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
 * 与 ISRManager 的关系：
 * ISRRenderer 本身不管理缓存存储，而是通过 ISRManagerLike 接口
 * 委托给外部的 ISRManager 处理缓存的读写和后台重验证。
 * 这种设计使得缓存策略（内存/文件/Redis）可以独立替换。
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
  ISRCacheResult,
  GetStaticPropsContext,
  GetStaticPropsResult,
} from '@nami/shared';
import {
  RenderMode as RenderModeEnum,
  RenderError,
  ErrorCode,
  generateDataScript,
} from '@nami/shared';

import { BaseRenderer } from './base-renderer';
import { CSRRenderer } from './csr-renderer';
import type { RendererOptions, AppElementFactory, ISRManagerLike } from './types';

/**
 * ISR 渲染器配置
 */
export interface ISRRendererOptions extends RendererOptions {
  /**
   * ISR 管理器实例
   *
   * 负责缓存的读写和后台重验证调度。
   * 必须提供，否则 ISR 无法工作。
   */
  isrManager: ISRManagerLike;

  /**
   * React 组件树工厂函数
   *
   * 在缓存未命中时用于执行 React 渲染。
   * 缓存命中时不需要（直接返回缓存的 HTML）。
   */
  appElementFactory: AppElementFactory;
}

/**
 * ISR 渲染器
 *
 * 基于 stale-while-revalidate 缓存策略的增量静态再生渲染器。
 * 通过 ISRManager 管理缓存，支持后台异步重验证。
 */
export class ISRRenderer extends BaseRenderer {
  /** ISR 管理器 — 负责缓存读写和重验证调度 */
  private readonly isrManager: ISRManagerLike;

  /** React 组件树工厂函数 */
  private readonly appElementFactory: AppElementFactory;

  /** 默认重验证间隔（秒），来自 config.isr.defaultRevalidate */
  private readonly defaultRevalidate: number;

  constructor(options: ISRRendererOptions) {
    super(options);
    this.isrManager = options.isrManager;
    this.appElementFactory = options.appElementFactory;
    this.defaultRevalidate = options.config.isr.defaultRevalidate;

    this.logger.debug('ISR 渲染器已初始化', {
      defaultRevalidate: this.defaultRevalidate,
      cacheAdapter: options.config.isr.cacheAdapter,
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
      // ========== 步骤一：查询 ISR 缓存 ==========
      const cacheResult = await this.isrManager.getOrRevalidate(cacheKey, revalidate);

      // ========== 步骤二：根据缓存状态选择处理路径 ==========
      let result: RenderResult;

      if (cacheResult && !cacheResult.isCacheMiss) {
        // 缓存命中 — 无论是否过期，先返回缓存内容
        result = this.handleCacheHit(cacheResult, context, timing, revalidate, cacheKey);
      } else {
        // 缓存未命中 — 需要执行完整渲染
        result = await this.handleCacheMiss(context, timing, cacheKey, revalidate);
      }

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
   * 处理缓存命中
   *
   * 缓存命中分为两种情况：
   * - 新鲜缓存（!isStale）：直接返回，无需任何后台操作
   * - 过期缓存（isStale）：先返回旧内容，同时调度后台重验证
   *
   * @param cacheResult - ISR 缓存查询结果
   * @param context - 渲染上下文
   * @param timing - 性能计时
   * @param revalidate - 重验证间隔
   * @param cacheKey - 缓存键
   * @returns 渲染结果
   */
  private handleCacheHit(
    cacheResult: ISRCacheResult,
    context: RenderContext,
    timing: RenderTiming,
    revalidate: number,
    cacheKey: string,
  ): RenderResult {
    timing.renderStart = Date.now();
    timing.renderEnd = Date.now();
    timing.htmlEnd = Date.now();

    if (cacheResult.isStale) {
      // 过期缓存 — 返回旧内容 + 异步重验证
      this.logger.debug('ISR 缓存已过期，调度后台重验证', {
        url: context.url,
        cacheKey,
        createdAt: cacheResult.createdAt,
      });

      // 调度后台重验证（异步，不阻塞当前请求）
      this.scheduleBackgroundRevalidation(cacheKey, context, revalidate);
    } else {
      this.logger.debug('ISR 缓存命中（新鲜）', {
        url: context.url,
        cacheKey,
      });
    }

    return this.createDefaultResult(
      cacheResult.html,
      200,
      RenderModeEnum.ISR,
      timing,
      {
        headers: {
          // 通过 stale-while-revalidate 头告知 CDN 缓存策略
          'Cache-Control': `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}`,
          // 如果有 ETag，设置用于条件请求
          ...(cacheResult.etag ? { ETag: cacheResult.etag } : {}),
        },
        cacheHit: true,
        cacheStale: cacheResult.isStale,
        cacheControl: {
          revalidate,
          staleWhileRevalidate: revalidate * 2,
        },
      },
    );
  }

  /**
   * 处理缓存未命中
   *
   * 执行完整的渲染流程：数据预取 → React 渲染 → HTML 组装 → 写入缓存。
   * 这是 ISR 中最慢的路径，仅在首次请求或缓存失效后触发。
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
    this.logger.debug('ISR 缓存未命中，执行完整渲染', {
      url: context.url,
      cacheKey,
    });

    // ========== 数据预取 ==========
    timing.dataFetchStart = Date.now();
    const prefetchResult = await this.prefetchData(context);
    timing.dataFetchEnd = Date.now();

    context.initialData = prefetchResult.data as Record<string, unknown>;

    // ========== React 渲染 ==========
    timing.renderStart = Date.now();

    const { renderToString } = await this.importRenderToString();
    const appElement = this.appElementFactory(context);
    const appHTML = renderToString(appElement as React.ReactElement);

    timing.renderEnd = Date.now();

    // ========== HTML 组装 ==========
    const fullHTML = this.assembleHTML(appHTML, context);
    timing.htmlEnd = Date.now();

    // ========== 异步写入缓存（不阻塞响应） ==========
    const cacheTags = this.extractCacheTags(context);
    this.isrManager
      .set(cacheKey, fullHTML, revalidate, cacheTags)
      .catch((error) => {
        // 缓存写入失败不影响本次响应，仅打印警告
        this.logger.warn('ISR 缓存写入失败', {
          cacheKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    this.logger.debug('ISR 完整渲染完成', {
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
          'Cache-Control': `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}`,
        },
        cacheHit: false,
        cacheStale: false,
        degraded: prefetchResult.degraded,
        degradeReason: prefetchResult.degraded
          ? `数据预取降级: ${prefetchResult.errors.map((e) => e.message).join('; ')}`
          : undefined,
        cacheControl: {
          revalidate,
          staleWhileRevalidate: revalidate * 2,
        },
      },
    );
  }

  /**
   * 调度后台重验证
   *
   * 将重新渲染任务交给 ISRManager 异步执行。
   * 重验证过程：数据预取 → React 渲染 → HTML 组装 → 更新缓存。
   * 不阻塞当前请求，失败时仅打印日志。
   *
   * @param cacheKey - 缓存键
   * @param context - 渲染上下文（用于构造渲染函数）
   * @param revalidate - 重验证间隔
   */
  private scheduleBackgroundRevalidation(
    cacheKey: string,
    context: RenderContext,
    revalidate: number,
  ): void {
    // 构造渲染函数，供 ISRManager 在后台执行
    const renderFn = async (): Promise<string> => {
      this.logger.debug('执行后台重验证渲染', { cacheKey });

      // 数据预取
      const prefetchResult = await this.prefetchData(context);
      context.initialData = prefetchResult.data as Record<string, unknown>;

      // React 渲染
      const { renderToString } = await this.importRenderToString();
      const appElement = this.appElementFactory(context);
      const appHTML = renderToString(appElement as React.ReactElement);

      // HTML 组装
      return this.assembleHTML(appHTML, context);
    };

    // 委托 ISRManager 调度后台重验证
    this.isrManager.scheduleRevalidation(cacheKey, renderFn);
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
    const { config } = this;
    const publicPath = config.assets.publicPath;
    const containerId = 'nami-root';

    const title =
      (context.route.meta?.title as string) ??
      config.title ??
      config.appName;

    const description =
      (context.route.meta?.description as string) ??
      config.description ??
      '';

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
      '  <meta name="renderer" content="isr">',
      `  <link rel="stylesheet" href="${publicPath}static/css/main.css">`,
      '</head>',
      '<body>',
      `  <div id="${containerId}">${appHTML}</div>`,
      dataScript ? `  ${dataScript}` : '',
      `  <script defer src="${publicPath}static/js/main.js"></script>`,
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
    renderToString: (element: React.ReactElement) => string;
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
   * 解析 getStaticProps 函数
   */
  private async resolveGetStaticProps(
    componentPath: string,
    functionName: string,
  ): Promise<((ctx: GetStaticPropsContext) => Promise<GetStaticPropsResult>) | null> {
    try {
      // 占位实现 — 实际应从 server bundle 中加载
      this.logger.debug('解析 getStaticProps', {
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
