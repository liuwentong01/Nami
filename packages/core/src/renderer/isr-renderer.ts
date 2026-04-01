/**
 * @nami/core - ISR（增量静态再生）渲染器
 *
 * ISR 是 SSG 和 SSR 的混合体，结合了两者的优点：
 * - 像 SSG 一样返回缓存的静态 HTML（极低 TTFB）
 * - 像 SSR 一样在后台按需更新内容（数据不过时）
 *
 * 核心机制 — Stale-While-Revalidate：
 *
 * ┌──────────────────────────────────────────────────────┐
 * │ 请求到达                                              │
 * │   ├─ 缓存命中且未过期 → 直接返回缓存内容（最快路径）       │
 * │   ├─ 缓存命中但已过期 → 返回旧缓存 + 后台触发重新渲染     │
 * │   └─ 缓存未命中 → 阻塞渲染，结果写入缓存后返回            │
 * └──────────────────────────────────────────────────────┘
 *
 * 与 server ISR 缓存层的关系：
 * 默认服务端链路会先经过 `isr-cache-middleware`，
 * 由 server 侧的 ISRManager 统一处理缓存命中、stale 返回和后台重验证。
 * 因此 ISRRenderer 自身只负责在需要真正执行渲染时产出 HTML，
 * 避免 core 与 server 各自再维护一套重复的 ISR 缓存协议。
 *
 * 适用场景：
 * - 电商商品页（内容频繁更新但允许短暂过期）
 * - 新闻列表页（分钟级更新即可）
 * - 任何需要平衡性能和新鲜度的页面
 *
 * 降级策略：
 * ISR 渲染失败 → CSR（通过 createFallbackRenderer）
 *
 * 配置项（来自 route.revalidate 和 config.isr）：
 * - revalidate: 重验证间隔（秒），控制缓存"新鲜"时长
 * - fallback: 缓存未命中时的处理策略（blocking / true / false）
 */

import type {
  RenderMode,
  RenderContext,
  RenderResult,
  RenderTiming,
  PrefetchResult,
  GetStaticPropsContext,
  GetStaticPropsResult,
} from '@nami/shared';
import {
  RenderMode as RenderModeEnum,
  RenderError,
  ErrorCode,
  generateDataScript,
} from '@nami/shared';
import type { ReactElement } from 'react';

import { BaseRenderer } from './base-renderer';
import { CSRRenderer } from './csr-renderer';
import type { RendererOptions, AppElementFactory, HTMLRenderer, ModuleLoaderLike } from './types';

/**
 * ISR 渲染器配置
 */
export interface ISRRendererOptions extends RendererOptions {
  /**
   * React 组件树工厂函数
   *
   * 在缓存未命中时用于执行 React 渲染。
   * 缓存命中时不需要（直接返回缓存的 HTML）。
   */
  appElementFactory?: AppElementFactory;

  /**
   * 服务端 HTML 渲染函数
   *
   * 用于兼容 `entry-server.renderToHTML()` 风格的历史接入方式。
   * 当缓存未命中或后台重验证时，ISR 可以直接复用这个入口产出 HTML。
   */
  htmlRenderer?: HTMLRenderer;

  /**
   * 模块加载器
   *
   * 用于从 server bundle 中加载 getStaticProps 等数据预取函数。
   * 不传时 ISR 数据预取将无法工作。
   */
  moduleLoader?: ModuleLoaderLike;
}

/**
 * ISR 渲染器
 *
 * 基于 stale-while-revalidate 缓存策略的增量静态再生渲染器。
 * 通过 ISRManager 管理缓存，支持后台异步重验证。
 */
export class ISRRenderer extends BaseRenderer {
  /** React 组件树工厂函数 */
  private readonly appElementFactory?: AppElementFactory;

  /** 兼容 entry-server.renderToHTML() 的 HTML 渲染函数 */
  private readonly htmlRenderer?: HTMLRenderer;

  /** 模块加载器 — 用于从 server bundle 中加载数据预取函数 */
  private readonly moduleLoader?: ModuleLoaderLike;

  /** 默认重验证间隔（秒），来自 config.isr.defaultRevalidate */
  private readonly defaultRevalidate: number;

  constructor(options: ISRRendererOptions) {
    super(options);
    this.appElementFactory = options.appElementFactory;
    this.htmlRenderer = options.htmlRenderer;
    this.moduleLoader = options.moduleLoader;
    this.defaultRevalidate = options.config.isr.defaultRevalidate;

    this.logger.debug('ISR 渲染器已初始化', {
      defaultRevalidate: this.defaultRevalidate,
      cacheAdapter: options.config.isr.cacheAdapter,
      hasAppElementFactory: !!this.appElementFactory,
      hasHtmlRenderer: !!this.htmlRenderer,
    });
  }

  /**
   * 返回渲染模式标识
   */
  getMode(): RenderMode {
    return RenderModeEnum.ISR;
  }

  /**
   * ISR 渲染
   *
   * 实现 stale-while-revalidate 渲染策略：
   *
   * 1. 通过 ISRManager 查询缓存
   * 2. 根据缓存状态分三种处理路径：
   *    a) 缓存命中且新鲜 → 直接返回（零渲染开销）
   *    b) 缓存命中但过期 → 返回旧内容 + 异步重验证
   *    c) 缓存未命中 → 阻塞渲染 → 写入缓存 → 返回
   *
   * @param context - 渲染上下文
   * @returns 渲染结果
   * @throws {RenderError} 缓存未命中且渲染失败时抛出
   */
  async render(context: RenderContext): Promise<RenderResult> {
    const timing = this.createRenderTiming();
    const revalidate = context.route.revalidate ?? this.defaultRevalidate;

    // 生成缓存键 — 使用请求路径作为缓存标识
    const cacheKey = this.buildCacheKey(context);

    this.logger.debug('开始 ISR 渲染', {
      url: context.url,
      cacheKey,
      revalidate,
    });

    // 触发渲染前钩子
    await this.callPluginHook('beforeRender', context);

    try {
      // 默认服务端链路中的缓存命中与后台重验证由上游 isr-cache-middleware 处理。
      // 走到 ISRRenderer 时，说明当前请求已经明确需要执行一次真实渲染
      // （如缓存未命中，或由其他环境直接调用 ISRRenderer）。
      const result = await this.handleCacheMiss(context, timing, cacheKey, revalidate);

      // 触发渲染后钩子
      await this.callPluginHook('afterRender', context, result);

      return result;
    } catch (error) {
      // 触发渲染错误钩子
      await this.callPluginHook('renderError', context, error);

      const renderError = this.wrapError(error, context);
      this.logger.error('ISR 渲染失败', {
        url: context.url,
        cacheKey,
        error: renderError.message,
        duration: Date.now() - timing.startTime,
      });

      throw renderError;
    }
  }

  /**
   * ISR 数据预取
   *
   * 与 SSG 一致，调用路由的 getStaticProps 获取数据。
   * 在缓存未命中或后台重验证时执行。
   *
   * @param context - 渲染上下文
   * @returns 预取结果
   */
  async prefetchData(context: RenderContext): Promise<PrefetchResult> {
    const startTime = Date.now();
    const { route } = context;

    // 路由未配置 getStaticProps，无需预取
    if (!route.getStaticProps) {
      return {
        data: {},
        errors: [],
        degraded: false,
        duration: 0,
      };
    }

    this.logger.debug('开始 ISR 数据预取', { path: route.path });

    try {
      // 构造 getStaticProps 上下文
      const gspContext: GetStaticPropsContext = {
        params: context.params,
      };

      // 解析并执行 getStaticProps
      const gspFn = await this.resolveGetStaticProps(route.component, route.getStaticProps);

      if (!gspFn) {
        this.logger.warn('getStaticProps 函数未找到', {
          component: route.component,
          functionName: route.getStaticProps,
        });
        return {
          data: {},
          errors: [new Error(`getStaticProps 函数 "${route.getStaticProps}" 未找到`)],
          degraded: true,
          duration: Date.now() - startTime,
        };
      }

      const result = await gspFn(gspContext);
      const duration = Date.now() - startTime;

      this.logger.debug('ISR 数据预取完成', {
        path: route.path,
        duration,
        hasProps: !!result.props,
        revalidate: result.revalidate,
      });

      return {
        data: result.props ?? {},
        errors: [],
        degraded: false,
        duration,
        details: [
          {
            key: 'getStaticProps',
            success: true,
            duration,
          },
        ],
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error('ISR 数据预取失败', {
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
            key: 'getStaticProps',
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
   * ISR 降级到 CSR：缓存和渲染都失败时，返回 CSR 兜底。
   *
   * @returns CSRRenderer 实例
   */
  createFallbackRenderer(): BaseRenderer {
    this.logger.info('创建 CSR 降级渲染器（ISR 降级）');
    return new CSRRenderer({
      config: this.config,
      pluginManager: this.pluginManager,
    });
  }

  // ==================== 私有方法 ====================

  /**
   * 执行 ISR 实际渲染
   *
   * 这里不直接读写缓存，而是专注于：
   * 1. 数据预取
   * 2. React / HTML 渲染
   * 3. 返回带 ISR 缓存头的响应结果
   *
   * 缓存命中、stale 返回与后台重验证由 server 侧 ISR 缓存层统一处理。
   *
   * @param context - 渲染上下文
   * @param timing - 性能计时
   * @param cacheKey - 缓存键
   * @param revalidate - 重验证间隔
   * @returns 渲染结果
   */
  private async handleCacheMiss(
    context: RenderContext,
    timing: RenderTiming,
    cacheKey: string,
    revalidate: number,
  ): Promise<RenderResult> {
    this.logger.debug('执行 ISR 实际渲染', {
      url: context.url,
      cacheKey,
    });

    // ========== 数据预取 ==========
    timing.dataFetchStart = Date.now();
    const prefetchResult = await this.prefetchData(context);
    timing.dataFetchEnd = Date.now();

    context.initialData = prefetchResult.data as Record<string, unknown>;

    // ========== 服务端渲染 ==========
    timing.renderStart = Date.now();
    const renderedHTML = await this.renderAppHTML(context);

    timing.renderEnd = Date.now();

    // ========== HTML 组装 ==========
    const fullHTML = this.ensureDocumentHTML(renderedHTML, context);
    timing.htmlEnd = Date.now();

    this.logger.debug('ISR 实际渲染完成', {
      url: context.url,
      cacheKey,
      totalDuration: Date.now() - timing.startTime,
    });

    return this.createDefaultResult(
      fullHTML,
      200,
      RenderModeEnum.ISR,
      timing,
      {
        headers: {
          // 响应头仍声明 ISR 语义，便于上游 CDN / 缓存层保持一致策略。
          'Cache-Control': `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}`,
        },
        cacheHit: false,
        cacheStale: false,
        degraded: prefetchResult.degraded,
        degradeReason: prefetchResult.degraded
          ? `数据预取降级: ${prefetchResult.errors.map((error: Error) => error.message).join('; ')}`
          : undefined,
        cacheControl: {
          revalidate,
          staleWhileRevalidate: revalidate * 2,
          tags: this.extractCacheTags(context),
        },
      },
    );
  }

  /**
   * 构建缓存键
   *
   * ISR 缓存键由请求路径和查询参数组成。
   * 相同路径不同查询参数视为不同的缓存条目。
   *
   * @param context - 渲染上下文
   * @returns 缓存键字符串
   */
  private buildCacheKey(context: RenderContext): string {
    // 基础键 = 路径
    let key = context.path;

    // 如果有查询参数，将其排序后附加到键中
    // 排序确保 ?a=1&b=2 和 ?b=2&a=1 使用同一个缓存条目
    const queryEntries = Object.entries(context.query).sort(([a], [b]) => a.localeCompare(b));
    if (queryEntries.length > 0) {
      const queryString = queryEntries
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
        .join('&');
      key += `?${queryString}`;
    }

    return key;
  }

  /**
   * 从渲染上下文中提取缓存标签
   *
   * 缓存标签用于按标签批量失效缓存。
   * 例如商品详情页可携带 ['product:123'] 标签，
   * 当商品信息更新时通过标签批量清除所有相关缓存。
   *
   * @param context - 渲染上下文
   * @returns 缓存标签列表
   */
  private extractCacheTags(context: RenderContext): string[] {
    const tags: string[] = [];

    // 从路由 meta 中读取自定义标签
    if (context.route.meta?.cacheTags && Array.isArray(context.route.meta.cacheTags)) {
      tags.push(...(context.route.meta.cacheTags as string[]));
    }

    // 从渲染上下文扩展数据中读取标签
    if (context.extra.cacheTags && Array.isArray(context.extra.cacheTags)) {
      tags.push(...(context.extra.cacheTags as string[]));
    }

    return tags;
  }

  /**
   * 组装完整的 HTML 文档
   */
  private assembleHTML(appHTML: string, context: RenderContext): string {
    const containerId = 'nami-root';

    const title =
      (context.route.meta?.title as string) ??
      this.config.title ??
      this.config.appName;

    const description =
      (context.route.meta?.description as string) ??
      this.config.description ??
      '';

    const dataScript = context.initialData
      ? generateDataScript(context.initialData)
      : '';

    const { cssLinks, jsScripts } = this.resolveAssets();

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
      '  <meta name="renderer" content="isr">',
      cssLinks,
      '</head>',
      '<body>',
      `  <div id="${containerId}">${appHTML}</div>`,
      dataScript ? `  ${dataScript}` : '',
      jsScripts,
      '</body>',
      '</html>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 条件导入 react-dom/server
   */
  private async importRenderToString(): Promise<{
    renderToString: (element: ReactElement) => string;
  }> {
    try {
      const ReactDOMServer = await import(/* webpackIgnore: true */ 'react-dom/server');
      return { renderToString: ReactDOMServer.renderToString };
    } catch (error) {
      throw new RenderError(
        'react-dom/server 加载失败，请确保已安装 react-dom 依赖',
        ErrorCode.RENDER_ISR_REVALIDATE_FAILED,
        {
          originalError: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * 执行实际的页面渲染
   *
   * ISR 在缓存未命中和后台重验证时都会走到这里。
   * 为了兼容老项目，这里同时支持 React 元素工厂和 HTML 渲染函数两套协议。
   */
  private async renderAppHTML(context: RenderContext): Promise<string> {
    if (this.htmlRenderer) {
      return await this.htmlRenderer(context, context.initialData ?? {});
    }

    if (!this.appElementFactory) {
      throw new RenderError(
        'ISR 渲染缺少可用的服务端渲染入口',
        ErrorCode.RENDER_ISR_REVALIDATE_FAILED,
        {
          hint: '请提供 appElementFactory，或在 entry-server 中导出 renderToHTML()',
        },
      );
    }

    const { renderToString } = await this.importRenderToString();
    const appElement = this.appElementFactory(context);
    return renderToString(appElement as ReactElement);
  }

  /**
   * 将渲染结果规范化为完整 HTML 文档
   *
   * 对 `htmlRenderer` 返回的完整 HTML 文档直接透传；
   * 对仅返回页面片段的情况，再由框架补齐文档外壳和数据注入。
   */
  private ensureDocumentHTML(renderedHTML: string, context: RenderContext): string {
    if (/<!doctype html>/i.test(renderedHTML) || /<html[\s>]/i.test(renderedHTML)) {
      return renderedHTML;
    }

    return this.assembleHTML(renderedHTML, context);
  }

  /**
   * 解析 getStaticProps 函数
   *
   * 通过 ModuleLoader 从 server bundle 中加载指定组件的 getStaticProps 导出函数。
   * ModuleLoader 未配置时返回 null 并打印警告。
   *
   * @param componentPath - 组件路径（如 './pages/home'）
   * @param functionName - 导出函数名（如 'getStaticProps'）
   * @returns getStaticProps 函数或 null
   */
  private async resolveGetStaticProps(
    componentPath: string,
    functionName: string,
  ): Promise<((ctx: GetStaticPropsContext) => Promise<GetStaticPropsResult>) | null> {
    try {
      this.logger.debug('解析 getStaticProps', {
        componentPath,
        functionName,
      });

      if (this.moduleLoader) {
        return await this.moduleLoader.getExportedFunction(componentPath, functionName);
      }

      this.logger.warn('ModuleLoader 未配置，无法解析 getStaticProps', {
        componentPath,
        functionName,
      });
      return null;
    } catch (error) {
      this.logger.error('getStaticProps 函数解析失败', {
        componentPath,
        functionName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 将未知错误包装为 RenderError
   */
  private wrapError(error: unknown, context: RenderContext): RenderError {
    if (error instanceof RenderError) {
      return error;
    }

    const message =
      error instanceof Error
        ? error.message
        : `ISR 渲染未知错误: ${String(error)}`;

    return new RenderError(message, ErrorCode.RENDER_ISR_REVALIDATE_FAILED, {
      url: context.url,
      path: context.path,
      route: context.route.path,
      requestId: context.requestId,
    });
  }

  /**
   * 转义 HTML 特殊字符
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
