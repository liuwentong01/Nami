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
import { RenderMode as RenderModeEnum, RenderError, ErrorCode } from '@nami/shared';

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

    const cachedResult = await this.resolvePluginCacheHit(context, timing);
    if (cachedResult) {
      return cachedResult;
    }

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
    let cleanupPendingStream: (() => void) | undefined;

    this.logger.debug('开始 Streaming SSR（流模式）', { url: context.url });

    await this.callPluginHook('beforeRender', context);

    const cachedResult = await this.resolvePluginCacheHit(context, timing);
    if (cachedResult) {
      // resolvePluginCacheHit 已完成 afterRender，这里只补充流式结果标记。
      return {
        ...cachedResult,
        isStreaming: false,
      };
    }

    try {
      // 数据预取
      timing.dataFetchStart = Date.now();
      const prefetchResult = await this.prefetchData(context);
      timing.dataFetchEnd = Date.now();
      context.initialData = prefetchResult.data as Record<string, unknown>;
      context.extra.__nami_data_degraded = prefetchResult.degraded;

      const earlyResult = this.createEarlyDataResult(prefetchResult, context, timing);
      if (earlyResult) {
        const result: StreamingRenderResult = {
          ...earlyResult,
          isStreaming: false,
        };

        await this.callPluginHook('afterRender', context, result);
        return result;
      }

      // 构建 HTML 头部（立即发送）
      const { headHTML, tailHTML } = this.buildHTMLShell(context);

      // 创建 React 元素
      const appElement = this.appElementFactory(context);
      const appElementWithData = await this.prepareAppElement(appElement, context);

      timing.renderStart = Date.now();

      // 使用 renderToPipeableStream
      const { renderToPipeableStream } = await this.importStreamRenderer();

      const reactStream = new PassThrough();
      const wrappedStream = new PassThrough();
      type StreamPhase =
        | 'waiting-shell'
        | 'shell-ready'
        | 'streaming'
        | 'aborting-after-shell'
        | 'failed-before-shell'
        | 'completed';
      type StreamController = {
        pipe: (writable: Writable) => Writable;
        abort: () => void;
      };

      const lifecycle: {
        phase: StreamPhase;
        exposed: boolean;
        failure?: Error;
      } = {
        phase: 'waiting-shell',
        exposed: false,
      };

      let controller: StreamController | undefined;
      let abortRequested = false;
      let abortIssued = false;
      let streamTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let abortGraceHandle: ReturnType<typeof setTimeout> | undefined;
      let resolveShell!: () => void;
      let rejectShell!: (error: Error) => void;

      const shellReadyPromise = new Promise<void>((resolve, reject) => {
        resolveShell = resolve;
        rejectShell = reject;
      });

      const normalizeError = (error: unknown): Error =>
        error instanceof Error ? error : new Error(String(error));

      const clearLifecycleTimers = () => {
        if (streamTimeoutHandle) {
          clearTimeout(streamTimeoutHandle);
          streamTimeoutHandle = undefined;
        }
        if (abortGraceHandle) {
          clearTimeout(abortGraceHandle);
          abortGraceHandle = undefined;
        }
      };

      const abortReactStream = () => {
        abortRequested = true;
        if (!controller || abortIssued) return;

        try {
          abortIssued = true;
          controller.abort();
        } catch (error) {
          this.logger.warn('Streaming SSR 中止 React 流时发生异常', {
            url: context.url,
            error: normalizeError(error).message,
          });
        }
      };

      const destroyUnexposedStreams = () => {
        if (!reactStream.destroyed) reactStream.destroy();
        if (!wrappedStream.destroyed) wrappedStream.destroy();
      };

      const rejectBeforeShell = (error: Error) => {
        if (lifecycle.phase !== 'waiting-shell') return;

        lifecycle.phase = 'failed-before-shell';
        lifecycle.failure = error;
        clearLifecycleTimers();
        abortReactStream();
        destroyUnexposedStreams();
        rejectShell(error);
      };

      const terminateAfterShell = (error: Error, source: string) => {
        if (lifecycle.phase !== 'shell-ready' && lifecycle.phase !== 'streaming') {
          return;
        }

        lifecycle.phase = 'aborting-after-shell';
        lifecycle.failure = error;
        clearLifecycleTimers();

        this.logger.error('Streaming SSR Shell 就绪后流异常，中止当前流', {
          url: context.url,
          source,
          error: error.message,
        });

        abortReactStream();

        // 结果尚未交给 Koa 时，销毁已缓冲的字节，上层仍可安全降级。
        if (!lifecycle.exposed) {
          destroyUnexposedStreams();
          return;
        }

        // 响应已开始后不能再写第二份 HTML。先让 React abort 收尾，
        // 如底层流未在宽限期内结束，再强制关闭输出避免连接永久悬挂。
        if (lifecycle.phase === 'aborting-after-shell') {
          abortGraceHandle = setTimeout(() => {
            if (lifecycle.phase !== 'aborting-after-shell') return;

            this.logger.warn('Streaming SSR abort 后流未结束，强制关闭输出', {
              url: context.url,
            });
            if (!reactStream.destroyed) reactStream.destroy();
            if (!wrappedStream.destroyed) wrappedStream.destroy();
            clearLifecycleTimers();
          }, 1000);
        }

        // 已向上层暴露的流发生错误时，renderToStream 已无法 reject；
        // 补发 renderError 供监控插件观测，且不尝试生成新响应。
        const renderError = this.wrapError(error, context);
        void this.callPluginHook('renderError', context, renderError);
      };

      cleanupPendingStream = () => {
        clearLifecycleTimers();
        abortReactStream();
        destroyUnexposedStreams();
      };

      controller = renderToPipeableStream(appElementWithData, {
        onShellReady: () => {
          if (lifecycle.phase !== 'waiting-shell') return;

          lifecycle.phase = 'shell-ready';
          timing.renderEnd = Date.now();
          timing.htmlEnd = Date.now();
          resolveShell();
        },

        onShellError: (error: unknown) => {
          const shellError = normalizeError(error);
          this.logger.error('Streaming SSR Shell 错误', {
            url: context.url,
            error: shellError.message,
          });
          rejectBeforeShell(shellError);
        },

        onAllReady: () => {
          this.logger.debug('Streaming SSR 所有内容就绪', {
            url: context.url,
            duration: Date.now() - timing.startTime,
          });
        },

        onError: (error: unknown) => {
          const streamError = normalizeError(error);

          if (lifecycle.phase === 'waiting-shell') {
            // React 可能在 Shell 就绪前恢复某个 Suspense 边界；
            // 是否为致命错误由随后的 onShellReady/onShellError 决定。
            this.logger.warn('Streaming SSR Shell 就绪前发生渲染错误', {
              url: context.url,
              error: streamError.message,
            });
            return;
          }

          terminateAfterShell(streamError, 'react-onError');
        },
      }) as StreamController;

      if (abortRequested) {
        abortReactStream();
      }

      // 同一绝对截止时间同时保护 Shell 和完整流：Shell 前超时拒绝 Promise
      // 交给 DegradationManager；Shell 后超时则 abort 当前流，不会二次写响应。
      streamTimeoutHandle = setTimeout(() => {
        const timeoutError = new RenderError(
          `Streaming SSR 流式渲染超时（${this.streamTimeout}ms）`,
          ErrorCode.RENDER_SSR_TIMEOUT,
          { timeout: this.streamTimeout, url: context.url },
        );

        if (lifecycle.phase === 'waiting-shell') {
          this.logger.warn('Streaming SSR Shell 超时，交给降级管线', {
            url: context.url,
            timeout: this.streamTimeout,
          });
          rejectBeforeShell(timeoutError);
          return;
        }

        terminateAfterShell(timeoutError, 'stream-timeout');
      }, this.streamTimeout);

      await shellReadyPromise;
      if (lifecycle.failure) {
        throw lifecycle.failure;
      }

      reactStream.on('error', (error: Error) => {
        terminateAfterShell(normalizeError(error), 'react-stream');
      });

      reactStream.on('end', () => {
        const aborted = lifecycle.phase === 'aborting-after-shell';
        if (lifecycle.phase === 'failed-before-shell' || lifecycle.phase === 'completed') {
          return;
        }

        lifecycle.phase = 'completed';
        clearLifecycleTimers();
        timing.renderEnd = Date.now();
        timing.htmlEnd = Date.now();

        if (!wrappedStream.destroyed) {
          wrappedStream.end(tailHTML);
        }

        this.logger.debug(aborted ? 'Streaming SSR 已中止并完成流收尾' : 'Streaming SSR 流已完成', {
          url: context.url,
          duration: Date.now() - timing.startTime,
        });
      });

      wrappedStream.on('error', (error: Error) => {
        terminateAfterShell(normalizeError(error), 'output-stream');
      });

      wrappedStream.on('close', () => {
        if (
          lifecycle.phase === 'completed' ||
          lifecycle.phase === 'failed-before-shell' ||
          lifecycle.phase === 'aborting-after-shell'
        ) {
          return;
        }

        // 客户端提前断开时及时取消 React 工作，避免继续占用 CPU/内存。
        lifecycle.phase = 'completed';
        clearLifecycleTimers();
        abortReactStream();
        if (!reactStream.destroyed) reactStream.destroy();
      });

      // 先把 Document 头部写入输出缓冲，再连接 React 流。此时结果尚未
      // 暴露给 Koa，同步/早期异步错误仍可丢弃缓冲内容并进入降级。
      lifecycle.phase = 'streaming';
      wrappedStream.write(headHTML);
      reactStream.pipe(wrappedStream, { end: false });
      controller.pipe(reactStream);

      const result: StreamingRenderResult = {
        ...this.createDefaultResult(
          '', // html 为空，内容在 stream 中
          200,
          RenderModeEnum.SSR,
          timing,
          {
            headers: {
              'Transfer-Encoding': 'chunked',
              'Cache-Control': this.buildCacheControl(prefetchResult.cache),
              ...prefetchResult.headers,
            },
            degraded: prefetchResult.degraded,
          },
        ),
        stream: wrappedStream,
        isStreaming: true,
      };

      if (lifecycle.failure) {
        throw lifecycle.failure;
      }

      // afterRender 必须在结果交给 Koa 前执行，否则插件无法稳定追加响应头。
      await this.callPluginHook('afterRender', context, result);

      if (lifecycle.failure) {
        throw lifecycle.failure;
      }

      lifecycle.exposed = true;
      cleanupPendingStream = undefined;
      return result;
    } catch (error) {
      cleanupPendingStream?.();
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
      let gsspFn: ((ctx: GetServerSidePropsContext) => Promise<GetServerSidePropsResult>) | null =
        null;

      if (this.moduleLoader) {
        gsspFn = await this.moduleLoader.getExportedFunction(
          route.component,
          route.getServerSideProps,
        );
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
        redirect: result.redirect,
        notFound: result.notFound,
        headers: result.headers,
        cache: result.cache,
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
      assetManifest: this.assetManifest,
      appElementFactory: this.appElementFactory,
      moduleLoader: this.moduleLoader,
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
    context.extra.__nami_data_degraded = prefetchResult.degraded;

    const earlyResult = this.createEarlyDataResult(prefetchResult, context, timing);
    if (earlyResult) {
      return earlyResult;
    }

    // React 渲染（收集完整 HTML）
    timing.renderStart = Date.now();

    const appElement = this.appElementFactory(context);
    const html = await this.renderToStringFromStream(
      await this.prepareAppElement(appElement, context),
    );

    timing.renderEnd = Date.now();

    // 组装完整 HTML
    const fullHTML = this.assembleHTML(html, context);
    timing.htmlEnd = Date.now();

    return this.createDefaultResult(fullHTML, 200, RenderModeEnum.SSR, timing, {
      headers: {
        'Cache-Control': this.buildCacheControl(prefetchResult.cache),
        ...prefetchResult.headers,
      },
      degraded: prefetchResult.degraded,
    });
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
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      };

      const safeResolve = (value: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const safeReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      writable.on('data', (chunk: Buffer) => chunks.push(chunk));
      writable.on('end', () => safeResolve(Buffer.concat(chunks).toString('utf-8')));
      writable.on('error', safeReject);

      const { pipe, abort } = renderToPipeableStream(element, {
        onAllReady: () => {
          pipe(writable);
        },
        onShellError: (error: unknown) => {
          safeReject(error);
        },
        onError: (error: unknown) => {
          this.logger.warn('Streaming render 非致命错误', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });

      // 超时保护
      timeoutHandle = setTimeout(() => {
        abort();
        safeReject(
          new RenderError(
            `Streaming SSR 流式渲染超时（${this.streamTimeout}ms）`,
            ErrorCode.RENDER_SSR_TIMEOUT,
            { timeout: this.streamTimeout },
          ),
        );
      }, this.streamTimeout);
    });
  }

  private createEarlyDataResult(
    prefetchResult: PrefetchResult,
    context: RenderContext,
    timing: RenderTiming,
  ): RenderResult | null {
    if (prefetchResult.redirect) {
      timing.htmlEnd = Date.now();
      const statusCode =
        prefetchResult.redirect.statusCode ?? (prefetchResult.redirect.permanent ? 308 : 307);
      return this.createDefaultResult('', statusCode, RenderModeEnum.SSR, timing, {
        headers: {
          ...prefetchResult.headers,
          Location: prefetchResult.redirect.destination,
          'Cache-Control': 'private, no-cache',
        },
        degraded: prefetchResult.degraded,
      });
    }

    if (prefetchResult.notFound) {
      timing.htmlEnd = Date.now();
      return this.createDefaultResult(
        this.assembleHTML(this.createNotFoundAppHTML(), context, { hydrate: false }),
        404,
        RenderModeEnum.SSR,
        timing,
        {
          headers: {
            ...prefetchResult.headers,
            'Cache-Control': 'private, no-cache',
          },
          degraded: prefetchResult.degraded,
        },
      );
    }

    return null;
  }

  private buildCacheControl(cache?: PrefetchResult['cache']): string {
    if (!cache || cache.maxAge === undefined) {
      return 'private, no-cache';
    }

    let value = `s-maxage=${cache.maxAge}`;
    if (cache.staleWhileRevalidate !== undefined) {
      value += `, stale-while-revalidate=${cache.staleWhileRevalidate}`;
    }
    return value;
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

  private buildHTMLShell(
    context: RenderContext,
    options: { hydrate?: boolean } = {},
  ): { headHTML: string; tailHTML: string } {
    const hydrate = options.hydrate !== false;
    const title = hydrate
      ? ((context.route.meta?.title as string) ?? this.config.title ?? this.config.appName)
      : `404 - ${this.config.title ?? this.config.appName}`;
    const description = hydrate
      ? ((context.route.meta?.description as string) ?? this.config.description ?? '')
      : '';

    const { cssLinks, jsScripts } = this.resolveAssets();

    const headHTML = [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${this.escapeHTML(title)}</title>`,
      description ? `  <meta name="description" content="${this.escapeHTML(description)}">` : '',
      `  <meta name="renderer" content="${hydrate ? 'streaming-ssr' : 'static-404'}">`,
      cssLinks,
      '</head>',
      '<body>',
      '  <div id="nami-root">',
    ]
      .filter(Boolean)
      .join('\n');

    const dataScript = hydrate ? this.createHydrationDataScript(context) : '';

    const tailHTML = [
      '  </div>',
      dataScript ? `  ${dataScript}` : '',
      hydrate ? jsScripts : '',
      '</body>',
      '</html>',
    ]
      .filter(Boolean)
      .join('\n');

    return { headHTML, tailHTML };
  }

  private assembleHTML(
    appHTML: string,
    context: RenderContext,
    options: { hydrate?: boolean } = {},
  ): string {
    const { headHTML, tailHTML } = this.buildHTMLShell(context, options);
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
