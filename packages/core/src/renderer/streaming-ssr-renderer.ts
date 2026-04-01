/**
 * @nami/core - Streaming SSR 渲染器
 *
 * 基于 React 18 的 renderToPipeableStream API 实现流式 SSR。
 *
 * 与传统 SSR（renderToString）的区别：
 * - renderToString：等待整个组件树渲染完成后一次性返回 HTML 字符串
 * - renderToPipeableStream：边渲染边传输，支持 Suspense 和选择性 Hydration
 *
 * 优势：
 * 1. **更快的 TTFB** — HTML 的 head 和 shell 可以立即发送
 * 2. **Suspense 支持** — Suspense 边界内的内容可以异步加载，先发送 fallback
 * 3. **选择性 Hydration** — 客户端可以优先 hydrate 用户正在交互的部分
 * 4. **内存效率** — 不需要在内存中缓冲完整 HTML 字符串
 *
 * 使用场景：
 * - 大型页面（HTML 体积 > 100KB）
 * - 使用 React.lazy + Suspense 的页面
 * - 对 TTFB 敏感的场景
 *
 * 降级策略：
 * 流式 SSR 失败时降级到普通 SSR（renderToString），再失败降级到 CSR。
 */

import type { Writable } from 'stream';
import { PassThrough } from 'stream';

import type {
  RenderMode,
  RenderContext,
  RenderResult,
  RenderTiming,
  PrefetchResult,
  GetServerSidePropsContext,
  GetServerSidePropsResult,
} from '@nami/shared';
import {
  RenderMode as RenderModeEnum,
  RenderError,
  ErrorCode,
  generateDataScript,
} from '@nami/shared';

import { BaseRenderer } from './base-renderer';
import { SSRRenderer } from './ssr-renderer';
import { CSRRenderer } from './csr-renderer';
import type { RendererOptions, AppElementFactory, ModuleLoaderLike } from './types';

/**
 * Streaming SSR 渲染器配置
 */
export interface StreamingSSRRendererOptions extends RendererOptions {
  /** React 组件树工厂函数 */
  appElementFactory: AppElementFactory;

  /**
   * 模块加载器
   *
   * 用于从 server bundle 中加载 getServerSideProps 等数据预取函数。
   * 不传时 Streaming SSR 数据预取将无法工作。
   */
  moduleLoader?: ModuleLoaderLike;

  /**
   * 流式传输超时时间（毫秒）
   * 超过此时间后，即使 Suspense 边界未 resolve 也强制完成流
   * 默认: 10000
   */
  streamTimeout?: number;

  /**
   * 是否启用渐进式 Hydration 提示
   * 在 HTML 中插入标记帮助客户端识别哪些部分需要优先 hydrate
   * 默认: true
   */
  progressiveHydration?: boolean;
}

/**
 * 流式渲染结果（扩展 RenderResult）
 *
 * 除了标准的 html 字段外，还提供 stream 字段
 * 供 Koa 中间件直接 pipe 到 response。
 */
export interface StreamingRenderResult extends RenderResult {
  /**
   * Node.js Readable Stream
   * 中间件可以直接 pipe 到 ctx.res
   */
  stream?: NodeJS.ReadableStream;

  /**
   * 是否使用流式响应
   * 如果为 true，中间件应使用 stream 而非 html
   */
  isStreaming: boolean;
}

/**
 * Streaming SSR 渲染器
 *
 * 使用 React 18 renderToPipeableStream 实现流式 SSR。
 */
export class StreamingSSRRenderer extends BaseRenderer {
  private readonly appElementFactory: AppElementFactory;
  private readonly moduleLoader?: ModuleLoaderLike;
  private readonly streamTimeout: number;
  private readonly ssrTimeout: number;
  private readonly progressiveHydration: boolean;

  constructor(options: StreamingSSRRendererOptions) {
    super(options);
    this.appElementFactory = options.appElementFactory;
    this.moduleLoader = options.moduleLoader;
    this.streamTimeout = options.streamTimeout ?? 10000;
    this.ssrTimeout = options.config.server.ssrTimeout;
    this.progressiveHydration = options.progressiveHydration ?? true;

    this.logger.debug('Streaming SSR 渲染器已初始化', {
      streamTimeout: this.streamTimeout,
      progressiveHydration: this.progressiveHydration,
    });
  }

  getMode(): RenderMode {
    return RenderModeEnum.SSR;
  }

  /**
   * 执行流式 SSR 渲染
   *
   * 返回的 RenderResult 中：
   * - html 字段包含完整的 HTML（等待流结束后收集）
   * - 调用方可以通过 renderToStream() 获取流式结果
   *
   * @param context - 渲染上下文
   * @returns 渲染结果
   */
  async render(context: RenderContext): Promise<RenderResult> {
    const timing = this.createRenderTiming();

    this.logger.debug('开始 Streaming SSR 渲染', { url: context.url });

    await this.callPluginHook('beforeRender', context);

    try {
      const result = await this.withTimeout(
        this.executeStreamingSSR(context, timing),
        this.ssrTimeout,
        `Streaming SSR 渲染超时，URL: ${context.url}`,
      );

      await this.callPluginHook('afterRender', context, result);

      return result;
    } catch (error) {
      const renderError = this.wrapError(error, context);
      await this.callPluginHook('renderError', context, renderError);

      this.logger.error('Streaming SSR 渲染失败', {
        url: context.url,
        error: renderError.message,
        duration: Date.now() - timing.startTime,
      });

      throw renderError;
    }
  }

  /**
   * 执行流式 SSR 渲染并返回流
   *
   * 这是 Streaming SSR 的核心优势入口。
   * 返回一个 StreamingRenderResult，其 stream 字段可以直接 pipe 到响应。
   *
   * @param context - 渲染上下文
   * @returns 包含 stream 的渲染结果
   */
  async renderToStream(context: RenderContext): Promise<StreamingRenderResult> {
    const timing = this.createRenderTiming();

    this.logger.debug('开始 Streaming SSR（流模式）', { url: context.url });

    await this.callPluginHook('beforeRender', context);

    try {
      // 数据预取
      timing.dataFetchStart = Date.now();
      const prefetchResult = await this.prefetchData(context);
      timing.dataFetchEnd = Date.now();
      context.initialData = prefetchResult.data as Record<string, unknown>;

      // 构建 HTML 头部（立即发送）
      const { headHTML, tailHTML } = this.buildHTMLShell(context);

      // 创建 React 元素
      const appElement = this.appElementFactory(context);

      timing.renderStart = Date.now();

      // 使用 renderToPipeableStream
      const { renderToPipeableStream } = await this.importStreamRenderer();

      const passThrough = new PassThrough();
      let shellReady = false;

      const { pipe, abort } = renderToPipeableStream(
        appElement as React.ReactElement,
        {
          onShellReady: () => {
            shellReady = true;
            // Shell 就绪，开始写入 HTML 头部
            passThrough.write(headHTML);
            // Pipe React 渲染的内容
            pipe(passThrough);
          },

          onShellError: (error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error('Streaming SSR Shell 错误', { error: msg });
            passThrough.destroy(error instanceof Error ? error : new Error(msg));
          },

          onAllReady: () => {
            // 所有 Suspense 边界 resolve 后写入尾部 HTML
            timing.renderEnd = Date.now();
            timing.htmlEnd = Date.now();

            this.logger.debug('Streaming SSR 所有内容就绪', {
              url: context.url,
              duration: Date.now() - timing.startTime,
            });
          },

          onError: (error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn('Streaming SSR 渲染错误（非致命）', { error: msg });
          },
        },
      );

      // 设置超时
      const timeoutHandle = setTimeout(() => {
        if (!shellReady) {
          this.logger.warn('Streaming SSR shell 超时，中止流', {
            timeout: this.streamTimeout,
          });
          abort();
        }
      }, this.streamTimeout);

      // 流结束时写入尾部 HTML 并清理
      passThrough.on('end', () => {
        clearTimeout(timeoutHandle);
      });

      // 在 pipe 完成后追加尾部 HTML
      const wrappedStream = new PassThrough();
      passThrough.pipe(wrappedStream, { end: false });
      passThrough.on('end', () => {
        wrappedStream.write(tailHTML);
        wrappedStream.end();
      });

      const result: StreamingRenderResult = {
        ...this.createDefaultResult(
          '', // html 为空，内容在 stream 中
          200,
          RenderModeEnum.SSR,
          timing,
          {
            headers: {
              'Transfer-Encoding': 'chunked',
              'Cache-Control': 'private, no-cache',
            },
            degraded: prefetchResult.degraded,
          },
        ),
        stream: wrappedStream,
        isStreaming: true,
      };

      return result;
    } catch (error) {
      const renderError = this.wrapError(error, context);
      await this.callPluginHook('renderError', context, renderError);
      throw renderError;
    }
  }

  async prefetchData(context: RenderContext): Promise<PrefetchResult> {
    const startTime = Date.now();
    const { route } = context;

    if (!route.getServerSideProps) {
      return { data: {}, errors: [], degraded: false, duration: 0 };
    }

    try {
      const gsspContext: GetServerSidePropsContext = {
        params: context.params,
        query: context.query,
        headers: context.headers,
        path: context.path,
        url: context.url,
        cookies: context.koaContext?.cookies ?? {},
        requestId: context.requestId,
      };

      // 通过 ModuleLoader 从 server bundle 中解析 getServerSideProps 函数
      let gsspFn: ((ctx: GetServerSidePropsContext) => Promise<GetServerSidePropsResult>) | null = null;

      if (this.moduleLoader) {
        gsspFn = await this.moduleLoader.getExportedFunction(route.component, route.getServerSideProps);
      }

      if (!gsspFn) {
        return {
          data: {},
          errors: [new Error(`getServerSideProps "${route.getServerSideProps}" 未找到`)],
          degraded: true,
          duration: Date.now() - startTime,
        };
      }

      const result = await this.withTimeout(
        gsspFn(gsspContext),
        this.ssrTimeout,
        `getServerSideProps 超时`,
      );

      return {
        data: result.props ?? {},
        errors: [],
        degraded: false,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        data: {},
        errors: [error instanceof Error ? error : new Error(String(error))],
        degraded: true,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 降级渲染器链：Streaming SSR → 普通 SSR → CSR
   */
  createFallbackRenderer(): BaseRenderer {
    this.logger.info('Streaming SSR 降级到普通 SSR');
    return new SSRRenderer({
      config: this.config,
      pluginManager: this.pluginManager,
      appElementFactory: this.appElementFactory,
    });
  }

  // ==================== 私有方法 ====================

  private async executeStreamingSSR(
    context: RenderContext,
    timing: RenderTiming,
  ): Promise<RenderResult> {
    // 数据预取
    timing.dataFetchStart = Date.now();
    const prefetchResult = await this.prefetchData(context);
    timing.dataFetchEnd = Date.now();
    context.initialData = prefetchResult.data as Record<string, unknown>;

    // React 渲染（收集完整 HTML）
    timing.renderStart = Date.now();

    const appElement = this.appElementFactory(context);
    const html = await this.renderToStringFromStream(appElement as React.ReactElement);

    timing.renderEnd = Date.now();

    // 组装完整 HTML
    const fullHTML = this.assembleHTML(html, context);
    timing.htmlEnd = Date.now();

    return this.createDefaultResult(
      fullHTML,
      200,
      RenderModeEnum.SSR,
      timing,
      {
        headers: {
          'Cache-Control': 'private, no-cache',
        },
        degraded: prefetchResult.degraded,
      },
    );
  }

  /**
   * 使用 renderToPipeableStream 但收集为完整字符串
   *
   * 这是 render() 的实现方式 — 等待流完成后返回完整 HTML。
   * 适用于需要完整 HTML 的场景（如 ISR 缓存）。
   */
  private async renderToStringFromStream(element: React.ReactElement): Promise<string> {
    const { renderToPipeableStream } = await this.importStreamRenderer();

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const writable = new PassThrough();

      writable.on('data', (chunk: Buffer) => chunks.push(chunk));
      writable.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      writable.on('error', reject);

      const { pipe, abort } = renderToPipeableStream(element, {
        onAllReady: () => {
          pipe(writable);
        },
        onShellError: (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        onError: (error: unknown) => {
          this.logger.warn('Streaming render 非致命错误', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });

      // 超时保护
      setTimeout(() => {
        abort();
      }, this.streamTimeout);
    });
  }

  private async importStreamRenderer(): Promise<{
    renderToPipeableStream: (
      element: React.ReactElement,
      options?: any,
    ) => { pipe: (writable: Writable) => Writable; abort: () => void };
  }> {
    try {
      const ReactDOMServer = await import(/* webpackIgnore: true */ 'react-dom/server');
      if (!ReactDOMServer.renderToPipeableStream) {
        throw new Error('renderToPipeableStream 不可用，请确保 react-dom >= 18');
      }
      return { renderToPipeableStream: ReactDOMServer.renderToPipeableStream };
    } catch (error) {
      throw new RenderError(
        'react-dom/server 的 renderToPipeableStream 加载失败',
        ErrorCode.RENDER_SSR_FAILED,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private buildHTMLShell(context: RenderContext): { headHTML: string; tailHTML: string } {
    const title =
      (context.route.meta?.title as string) ?? this.config.title ?? this.config.appName;
    const description =
      (context.route.meta?.description as string) ?? this.config.description ?? '';

    const { cssLinks, jsScripts } = this.resolveAssets();

    const headHTML = [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${this.escapeHTML(title)}</title>`,
      description
        ? `  <meta name="description" content="${this.escapeHTML(description)}">`
        : '',
      '  <meta name="renderer" content="streaming-ssr">',
      cssLinks,
      '</head>',
      '<body>',
      '  <div id="nami-root">',
    ]
      .filter(Boolean)
      .join('\n');

    const dataScript = context.initialData
      ? generateDataScript(context.initialData)
      : '';

    const tailHTML = [
      '  </div>',
      dataScript ? `  ${dataScript}` : '',
      jsScripts,
      '</body>',
      '</html>',
    ]
      .filter(Boolean)
      .join('\n');

    return { headHTML, tailHTML };
  }

  private assembleHTML(appHTML: string, context: RenderContext): string {
    const { headHTML, tailHTML } = this.buildHTMLShell(context);
    return headHTML + appHTML + '\n' + tailHTML;
  }

  private wrapError(error: unknown, context: RenderContext): RenderError {
    if (error instanceof RenderError) return error;

    const isTimeout = error instanceof Error && error.message.includes('超时');
    return new RenderError(
      error instanceof Error ? error.message : `Streaming SSR 渲染未知错误: ${String(error)}`,
      isTimeout ? ErrorCode.RENDER_SSR_TIMEOUT : ErrorCode.RENDER_SSR_FAILED,
      {
        url: context.url,
        path: context.path,
        requestId: context.requestId,
      },
    );
  }

  private escapeHTML(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
