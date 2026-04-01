/**
 * @nami/core - SSR（服务端渲染）渲染器
 *
 * SSR 是 Nami 框架的核心渲染模式，在服务端执行完整的 React 渲染流程，
 * 返回包含可交互内容的 HTML，客户端通过 hydration 激活交互能力。
 *
 * 工作流程：
 * 1. 执行 getServerSideProps 获取页面数据（带超时保护）
 * 2. 调用 React renderToString 将组件树渲染为 HTML 字符串
 * 3. 将预取数据通过 <script> 标签注入 HTML（XSS 安全序列化）
 * 4. 组装完整的 HTML 文档返回给客户端
 *
 * 关键设计：
 * - **超时保护**：通过 config.server.ssrTimeout 控制整体超时，
 *   超时后立即降级到 CSR，避免请求堆积
 * - **安全序列化**：使用 safeStringify 转义危险字符，防止 XSS
 * - **条件导入**：renderToString 仅在服务端环境导入，避免客户端 Bundle 膨胀
 * - **降级链**：SSR 失败自动降级到 CSR（通过 createFallbackRenderer）
 *
 * 性能特征：
 * - TTFB 较慢（需要服务端执行渲染）
 * - FCP/LCP 快（HTML 已包含完整内容）
 * - 对 SEO 友好（搜索引擎可直接读取 HTML 内容）
 * - 服务端 CPU 开销较大（每次请求都执行 renderToString）
 */

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
  safeStringify,
  generateDataScript,
} from '@nami/shared';
import type { ReactElement } from 'react';

import { BaseRenderer } from './base-renderer';
import { CSRRenderer } from './csr-renderer';
import type { RendererOptions, AppElementFactory, HTMLRenderer, ModuleLoaderLike } from './types';

/**
 * SSR 渲染器配置
 *
 * 继承基础 RendererOptions，增加 SSR 特有的配置项
 */
export interface SSRRendererOptions extends RendererOptions {
  /**
   * React 组件树工厂函数
   *
   * 接收渲染上下文，返回待渲染的 React 元素树。
   * 这是 SSR 渲染器与业务 React 代码的桥梁。
   *
   * @example
   * ```typescript
   * const appElementFactory = (context) => (
   *   <App initialData={context.initialData} url={context.url} />
   * );
   * ```
   */
  appElementFactory?: AppElementFactory;

  /**
   * 服务端 HTML 渲染函数
   *
   * 兼容已有 `entry-server.tsx` 直接导出 `renderToHTML(url, props)` 的接入方式。
   * 当业务侧尚未切换到 React 元素工厂协议时，SSRRenderer 会优先复用它，
   * 以保证默认 SSR 启动链路可以正常工作。
   */
  htmlRenderer?: HTMLRenderer;
}

/**
 * SSR 渲染器
 *
 * 在服务端执行 React renderToString，返回包含完整内容的 HTML。
 * 支持数据预取（getServerSideProps）、超时保护和自动降级到 CSR。
 */
export class SSRRenderer extends BaseRenderer {
  /** React 组件树工厂函数 */
  private readonly appElementFactory?: AppElementFactory;

  /** 兼容 entry-server.renderToHTML() 的 HTML 渲染函数 */
  private readonly htmlRenderer?: HTMLRenderer;

  /** SSR 超时时间（毫秒），来自 config.server.ssrTimeout */
  private readonly ssrTimeout: number;

  /** 模块加载器（用于解析数据预取函数） */
  private readonly moduleLoader?: import('./types').ModuleLoaderLike;

  constructor(options: SSRRendererOptions) {
    super(options);
    this.appElementFactory = options.appElementFactory;
    this.htmlRenderer = options.htmlRenderer;
    this.ssrTimeout = options.config.server.ssrTimeout;
    this.moduleLoader = options.moduleLoader;

    this.logger.debug('SSR 渲染器已初始化', {
      timeout: this.ssrTimeout,
      hasAppElementFactory: !!this.appElementFactory,
      hasHtmlRenderer: !!this.htmlRenderer,
    });
  }

  /**
   * 返回渲染模式标识
   */
  getMode(): RenderMode {
    return RenderModeEnum.SSR;
  }

  /**
   * 执行 SSR 渲染
   *
   * 完整的 SSR 渲染流程包含三个阶段：
   *
   * 阶段一：数据预取
   * - 执行路由级别的 getServerSideProps 函数
   * - 带超时保护，超时后数据为空但渲染继续
   *
   * 阶段二：React 渲染
   * - 调用 appElementFactory 创建 React 元素树
   * - 使用 react-dom/server 的 renderToString 将元素树转化为 HTML 字符串
   *
   * 阶段三：HTML 组装
   * - 将渲染出的 HTML 片段嵌入完整的 HTML 文档模板
   * - 注入预取数据的 <script> 标签
   * - 引用客户端 JS/CSS 资源
   *
   * 整体带超时保护（ssrTimeout），超时后抛出 RenderError，
   * 由上层调用 createFallbackRenderer() 获取 CSR 降级方案。
   *
   * @param context - 渲染上下文
   * @returns 包含完整 HTML 的渲染结果
   * @throws {RenderError} SSR 渲染失败或超时时抛出
   */
  async render(context: RenderContext): Promise<RenderResult> {
    const timing = this.createRenderTiming();

    this.logger.debug('开始 SSR 渲染', { url: context.url });

    // 触发渲染前钩子
    await this.callPluginHook('beforeRender', context);

    try {
      // 整体超时保护：将完整渲染流程包装在超时 Promise 中
      const result = await this.withTimeout(
        this.executeSSR(context, timing),
        this.ssrTimeout,
        `SSR 渲染超时，URL: ${context.url}`,
      );

      // 触发渲染后钩子
      await this.callPluginHook('afterRender', context, result);

      return result;
    } catch (error) {
      const renderError = this.wrapError(error, context);

      // 触发渲染错误钩子
      await this.callPluginHook('renderError', context, renderError);

      this.logger.error('SSR 渲染失败', {
        url: context.url,
        error: renderError.message,
        code: renderError.code,
        duration: Date.now() - timing.startTime,
      });

      throw renderError;
    }
  }

  /**
   * 执行 SSR 数据预取
   *
   * 查找并执行路由配置中声明的 getServerSideProps 函数。
   * 如果路由未声明数据预取函数，返回空数据。
   *
   * 预取过程带超时保护，超时后返回已获取的部分数据并标记 degraded。
   *
   * @param context - 渲染上下文
   * @returns 预取结果
   */
  async prefetchData(context: RenderContext): Promise<PrefetchResult> {
    const startTime = Date.now();
    const { route } = context;

    // 路由未配置 getServerSideProps，无需预取
    if (!route.getServerSideProps) {
      this.logger.debug('路由未配置 getServerSideProps，跳过数据预取', {
        path: route.path,
      });
      return {
        data: {},
        errors: [],
        degraded: false,
        duration: 0,
      };
    }

    this.logger.debug('开始 SSR 数据预取', { path: route.path });

    try {
      // 构造 getServerSideProps 的入参上下文
      const gsspContext = this.buildGSSPContext(context);

      // 动态加载组件模块并获取 getServerSideProps 函数
      // 注意：实际实现中应从已编译的 server bundle 中加载
      // 这里展示逻辑框架，具体的模块加载由上层 ModuleLoader 负责
      const gsspFn = await this.resolveGetServerSideProps(route.component, route.getServerSideProps);

      if (!gsspFn) {
        this.logger.warn('getServerSideProps 函数未找到', {
          component: route.component,
          functionName: route.getServerSideProps,
        });
        return {
          data: {},
          errors: [new Error(`getServerSideProps 函数 "${route.getServerSideProps}" 未找到`)],
          degraded: true,
          duration: Date.now() - startTime,
        };
      }

      // 执行数据预取（带超时保护）
      const result = await this.withTimeout<GetServerSidePropsResult>(
        gsspFn(gsspContext),
        this.ssrTimeout,
        `getServerSideProps 超时，路由: ${route.path}`,
      );

      const duration = Date.now() - startTime;

      this.logger.debug('SSR 数据预取完成', {
        path: route.path,
        duration,
        hasProps: !!result.props,
        hasRedirect: !!result.redirect,
        notFound: !!result.notFound,
      });

      return {
        data: result.props ?? {},
        errors: [],
        degraded: false,
        duration,
        details: [
          {
            key: 'getServerSideProps',
            success: true,
            duration,
          },
        ],
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error('SSR 数据预取失败', {
        path: route.path,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });

      return {
        data: {},
        errors: [error instanceof Error ? error : new Error(String(error))],
        degraded: true,
        duration,
        details: [
          {
            key: 'getServerSideProps',
            success: false,
            duration,
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /**
   * 创建降级渲染器
   *
   * SSR 降级到 CSR：当 SSR 渲染失败（超时、异常等）时，
   * 返回 CSR 渲染器作为兜底，至少保证页面可以在客户端渲染。
   *
   * @returns CSRRenderer 实例
   */
  createFallbackRenderer(): BaseRenderer {
    this.logger.info('创建 CSR 降级渲染器');
    return new CSRRenderer({
      config: this.config,
      pluginManager: this.pluginManager,
    });
  }

  // ==================== 私有方法 ====================

  /**
   * 执行完整的 SSR 渲染流程
   *
   * 这是 render() 的核心实现，被超时 Promise 包装。
   * 按顺序执行：数据预取 → React 渲染 → HTML 组装。
   *
   * @param context - 渲染上下文
   * @param timing - 性能计时对象
   * @returns 渲染结果
   */
  private async executeSSR(
    context: RenderContext,
    timing: RenderTiming,
  ): Promise<RenderResult> {
    // ========== 阶段一：数据预取 ==========
    timing.dataFetchStart = Date.now();
    const prefetchResult = await this.prefetchData(context);
    timing.dataFetchEnd = Date.now();

    // 将预取数据注入到渲染上下文中，供 React 组件读取
    context.initialData = prefetchResult.data as Record<string, unknown>;

    // ========== 阶段二：服务端渲染 ==========
    timing.renderStart = Date.now();
    const renderedHTML = await this.renderAppHTML(context);

    timing.renderEnd = Date.now();

    // ========== 阶段三：HTML 组装 ==========
    const fullHTML = this.ensureDocumentHTML(renderedHTML, context);

    timing.htmlEnd = Date.now();

    this.logger.debug('SSR 渲染流程完成', {
      url: context.url,
      dataFetchDuration: timing.dataFetchEnd! - timing.dataFetchStart!,
      renderDuration: timing.renderEnd! - timing.renderStart!,
      totalDuration: Date.now() - timing.startTime,
    });

    return this.createDefaultResult(
      fullHTML,
      200,
      RenderModeEnum.SSR,
      timing,
      {
        headers: {
          // SSR 页面通常不应被 CDN 长时间缓存（数据实时性要求高）
          // 但可以设置短暂缓存以应对突发流量
          'Cache-Control': 'private, no-cache',
        },
        degraded: prefetchResult.degraded,
        degradeReason: prefetchResult.degraded
          ? `数据预取降级: ${prefetchResult.errors.map((error: Error) => error.message).join('; ')}`
          : undefined,
      },
    );
  }

  /**
   * 条件导入 react-dom/server 的 renderToString
   *
   * 使用动态 import 实现条件加载：
   * - 服务端：正常加载 react-dom/server
   * - 客户端：不应到达此处（CSR 不调用 SSRRenderer）
   *
   * 这样做的好处是客户端 Webpack Bundle 不会包含 react-dom/server，
   * 减少客户端 JS 体积。
   *
   * @returns renderToString 函数
   */
  private async importRenderToString(): Promise<{
    renderToString: (element: ReactElement) => string;
  }> {
    try {
      // 动态 import，Webpack 可以通过 magic comment 排除此依赖
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ReactDOMServer = await import(/* webpackIgnore: true */ 'react-dom/server');
      return { renderToString: ReactDOMServer.renderToString };
    } catch (error) {
      throw new RenderError(
        'react-dom/server 加载失败，请确保已安装 react-dom 依赖',
        ErrorCode.RENDER_SSR_FAILED,
        {
          originalError: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * 执行真正的服务端页面渲染
   *
   * 兼容两种历史接入协议：
   * 1. `appElementFactory(context)` -> ReactElement
   * 2. `htmlRenderer(context, initialData)` -> string
   *
   * 这样可以在不破坏现有 renderer 设计的前提下，
   * 打通 CLI / server bundle / entry-server 的默认 SSR 链路。
   */
  private async renderAppHTML(context: RenderContext): Promise<string> {
    if (this.htmlRenderer) {
      return await this.htmlRenderer(context, context.initialData ?? {});
    }

    if (!this.appElementFactory) {
      throw new RenderError(
        'SSR 渲染缺少可用的服务端渲染入口',
        ErrorCode.RENDER_SSR_FAILED,
        {
          hint: '请提供 appElementFactory，或在 entry-server 中导出 renderToHTML()',
        },
      );
    }

    // 条件导入 react-dom/server，仅在服务端执行
    // 使用动态 import 确保客户端 Bundle 不包含此依赖
    const { renderToString } = await this.importRenderToString();
    const appElement = this.appElementFactory(context);
    return renderToString(appElement as ReactElement);
  }

  /**
   * 将渲染结果规范化为完整 HTML 文档
   *
   * `htmlRenderer` 可能直接返回页面片段，也可能已经返回完整文档。
   * 这里做一次轻量检测，避免对完整 HTML 再次包壳导致嵌套文档结构错误。
   */
  private ensureDocumentHTML(renderedHTML: string, context: RenderContext): string {
    if (/<!doctype html>/i.test(renderedHTML) || /<html[\s>]/i.test(renderedHTML)) {
      return renderedHTML;
    }

    return this.assembleHTML(renderedHTML, context);
  }

  /**
   * 组装完整的 HTML 文档
   *
   * 将 React 渲染产出的 HTML 片段与文档壳（head/body）组合，
   * 并注入预取数据的 <script> 标签。
   *
   * 注入顺序：
   * 1. CSS 资源（head 中，避免 FOUC）
   * 2. React HTML 内容（body 中的挂载容器内）
   * 3. 数据注入 script（在客户端 JS 之前，确保 hydration 时可用）
   * 4. 客户端 JS Bundle（defer 加载）
   *
   * @param appHTML - React renderToString 的输出
   * @param context - 渲染上下文
   * @returns 完整的 HTML 文档字符串
   */
  private assembleHTML(appHTML: string, context: RenderContext): string {
    const { config } = this;
    const publicPath = config.assets.publicPath;
    const containerId = 'nami-root';

    // 页面标题
    const title =
      (context.route.meta?.title as string) ??
      config.title ??
      config.appName;

    // 页面描述
    const description =
      (context.route.meta?.description as string) ??
      config.description ??
      '';

    // 生成数据注入脚本
    // 使用 safeStringify 防止 XSS，数据通过 window.__NAMI_DATA__ 传递给客户端
    const dataScript = context.initialData
      ? generateDataScript(context.initialData)
      : '';

    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${this.escapeHTML(title)}</title>`,
      description
        ? `  <meta name="description" content="${this.escapeHTML(description)}">`
        : '',
      '  <meta name="renderer" content="ssr">',
      `  <link rel="stylesheet" href="${publicPath}static/css/main.css">`,
      '</head>',
      '<body>',
      `  <div id="${containerId}">${appHTML}</div>`,
      // 数据注入脚本必须在客户端 JS 之前，确保 hydration 时 window.__NAMI_DATA__ 已就绪
      dataScript ? `  ${dataScript}` : '',
      `  <script defer src="${publicPath}static/js/main.js"></script>`,
      '</body>',
      '</html>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 构造 getServerSideProps 的入参上下文
   *
   * 从 RenderContext 中提取 getServerSideProps 需要的信息，
   * 构建标准的 GetServerSidePropsContext 对象。
   *
   * @param context - 渲染上下文
   * @returns getServerSideProps 上下文
   */
  private buildGSSPContext(context: RenderContext): GetServerSidePropsContext {
    return {
      params: context.params,
      query: context.query,
      headers: context.headers,
      path: context.path,
      url: context.url,
      cookies: context.koaContext?.cookies ?? {},
      requestId: context.requestId,
    };
  }

  /**
   * 解析 getServerSideProps 函数
   *
   * 从编译后的组件模块中获取指定的数据预取函数。
   * 实际项目中此函数应从 server bundle 的模块系统中加载，
   * 这里提供框架级别的接口定义，具体实现依赖 ModuleLoader。
   *
   * @param componentPath - 组件文件路径
   * @param functionName - 导出的函数名
   * @returns getServerSideProps 函数，未找到时返回 null
   */
  private async resolveGetServerSideProps(
    componentPath: string,
    functionName: string,
  ): Promise<((ctx: GetServerSidePropsContext) => Promise<GetServerSidePropsResult>) | null> {
    try {
      this.logger.debug('解析 getServerSideProps', {
        componentPath,
        functionName,
      });

      // 通过 ModuleLoader 从 server bundle 加载组件模块
      if (this.moduleLoader) {
        return await this.moduleLoader.getExportedFunction(componentPath, functionName);
      }

      this.logger.warn('ModuleLoader 未配置，无法解析 getServerSideProps', {
        componentPath,
        functionName,
      });
      return null;
    } catch (error) {
      this.logger.error('getServerSideProps 函数解析失败', {
        componentPath,
        functionName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 将未知错误包装为 RenderError
   *
   * 确保所有从 render() 抛出的错误都是标准的 RenderError，
   * 便于上层统一处理和日志上报。
   *
   * @param error - 原始错误
   * @param context - 渲染上下文（用于填充错误上下文信息）
   * @returns 标准化的 RenderError
   */
  private wrapError(error: unknown, context: RenderContext): RenderError {
    // 已经是 RenderError 则直接返回
    if (error instanceof RenderError) {
      return error;
    }

    // 超时错误使用专用错误码
    const isTimeout =
      error instanceof Error && error.message.includes('超时');
    const errorCode = isTimeout
      ? ErrorCode.RENDER_SSR_TIMEOUT
      : ErrorCode.RENDER_SSR_FAILED;

    const message =
      error instanceof Error
        ? error.message
        : `SSR 渲染未知错误: ${String(error)}`;

    return new RenderError(message, errorCode, {
      url: context.url,
      path: context.path,
      route: context.route.path,
      requestId: context.requestId,
    });
  }

  /**
   * 转义 HTML 特殊字符
   *
   * @param str - 原始字符串
   * @returns 转义后的安全字符串
   */
  private escapeHTML(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
