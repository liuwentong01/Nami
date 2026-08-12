/**
 * @nami/server - 核心渲染中间件
 *
 * 这是 Nami 服务端最核心的中间件，负责完整的 SSR 渲染流程。
 * 从请求路径匹配到最终 HTML 响应，中间经历以下阶段：
 *
 * 1. 路由匹配 — 使用路由表匹配当前请求路径
 * 2. 创建渲染上下文 — 构建 RenderContext 对象
 * 3. 选择渲染器 — 根据路由配置的 renderMode 创建渲染器实例
 * 4. 执行 onBeforeRender 钩子 — 通知插件渲染即将开始
 * 5. 数据预取 — 执行 getServerSideProps / getStaticProps
 * 6. 渲染执行 — 调用渲染器的 render() 方法
 * 7. 执行 onAfterRender 钩子 — 通知插件渲染已完成
 * 8. 错误处理 — 渲染失败时执行 onRenderError 钩子并触发降级
 * 9. 设置响应 — 将渲染结果写入 Koa 响应
 *
 * 中间件依赖：
 * - @nami/core: RendererFactory（渲染器工厂）
 * - @nami/core: PluginManager（插件管理器）
 * - @nami/core: DegradationManager（降级管理器）
 * - @nami/core: PrefetchManager（数据预取管理器）
 * - @nami/shared: 类型定义
 *
 * @example
 * ```typescript
 * import { renderMiddleware } from '@nami/server';
 *
 * app.use(renderMiddleware({
 *   config: namiConfig,
 *   pluginManager,
 *   degradationManager,
 * }));
 * ```
 */

import type Koa from 'koa';
import type {
  NamiConfig,
  NamiRoute,
  RenderContext,
  RenderResult,
  RouteMatchResult,
  Logger,
} from '@nami/shared';
import { DegradationLevel, RenderMode, createLogger, createTimer } from '@nami/shared';
import { RendererFactory } from '@nami/core';
import type {
  BaseRenderer,
  PluginManagerLike,
  AppElementFactory,
  ModuleLoaderLike,
  ISRManagerLike,
  AssetManifest,
} from '@nami/core';
import { PluginManager } from '@nami/core';
import { DegradationManager } from '@nami/core';
import { matchConfiguredRoute } from './route-match';

/**
 * 渲染中间件配置选项
 */
export interface RenderMiddlewareOptions {
  /** Nami 框架主配置 */
  config: NamiConfig;

  /** 插件管理器实例 */
  pluginManager: PluginManager;

  /** 降级管理器实例 */
  degradationManager: DegradationManager;

  /**
   * React 组件树工厂函数
   * SSR/ISR 模式下需要此函数来创建 React 元素树
   */
  appElementFactory?: AppElementFactory;

  /**
   * 页面模块加载器
   *
   * 用于解析 getServerSideProps / getStaticProps / getStaticPaths，
   * 让服务端默认启动路径也能拿到页面级数据预取函数。
   */
  moduleLoader?: ModuleLoaderLike;

  /** ISR 管理器实例（仅 ISR 路由会用到） */
  isrManager?: ISRManagerLike;

  /**
   * 构建产物资源清单
   *
   * 用于让 SSR/CSR/SSG/ISR HTML 注入真实的带 contenthash 的 JS/CSS 文件名。
   */
  assetManifest?: AssetManifest;

  /**
   * 动态运行时提供器
   *
   * 开发模式下 server bundle 会持续重编译，静态注入的 runtime 很容易过期。
   * 因此这里允许调用方在每个请求前动态解析最新的 server runtime。
   */
  runtimeProvider?: () => Promise<{
    appElementFactory?: AppElementFactory;
    moduleLoader?: ModuleLoaderLike;
    assetManifest?: AssetManifest;
  }>;

  /**
   * 自定义路由匹配函数
   *
   * 如果不提供，使用内置的简单路由匹配器。
   * 生产环境建议提供高性能的路由匹配实现（如 path-to-regexp）。
   *
   * @param path - 请求路径
   * @param routes - 路由配置列表
   * @returns 匹配结果，未匹配返回 null
   */
  matchRoute?: (path: string, routes: NamiRoute[]) => RouteMatchResult | null;
}

/** 模块级日志实例 */
const moduleLogger: Logger = createLogger('@nami/server:render');

/**
 * 内置路由匹配器（使用 @nami/core 的 matchPath + rankRoutes）
 *
 * 支持动态参数、正则约束、可选参数、通配符。
 * 先按优先级排序路由，再依次匹配，第一个命中即返回。
 * 由于 rankRoutes 内部有编译缓存，排序的性能开销很低。
 *
 * @param requestPath - 请求路径
 * @param routes - 路由配置列表
 * @returns 匹配结果，未匹配返回 null
 */
const defaultMatchRoute = matchConfiguredRoute;

/**
 * 根据 Koa 上下文创建 RenderContext
 *
 * RenderContext 是渲染器和插件钩子之间传递信息的核心数据结构，
 * 包含请求信息、路由信息、预取数据、性能计时等。
 *
 * @param ctx - Koa 上下文
 * @param matchResult - 路由匹配结果
 * @param requestId - 请求唯一标识
 * @returns RenderContext 实例
 */
function createRenderContext(
  ctx: Koa.Context,
  matchResult: RouteMatchResult,
  requestId: string,
): RenderContext {
  /**
   * 解析查询参数
   * Koa 的 ctx.query 返回 ParsedUrlQuery 类型，
   * 需要转换为 Record<string, string | string[]>
   */
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(ctx.query)) {
    if (typeof value === 'string' || Array.isArray(value)) {
      query[key] = value;
    }
  }

  /**
   * 提取请求头（转小写键名）
   * 过滤掉 cookie 等敏感头部，只保留业务相关的头部信息
   */
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (typeof value === 'string' || Array.isArray(value) || value === undefined) {
      headers[key.toLowerCase()] = value;
    }
  }

  return {
    url: ctx.url,
    path: ctx.path,
    query,
    headers,
    route: matchResult.route,
    params: matchResult.params,
    koaContext: {
      method: ctx.method,
      path: ctx.path,
      url: ctx.url,
      querystring: ctx.querystring,
      protocol: ctx.protocol,
      ip: ctx.ip,
      origin: ctx.origin,
      hostname: ctx.hostname,
      secure: ctx.secure,
      cookies: parseCookies(ctx.get('cookie')),
    },
    timing: {
      startTime: Date.now(),
    },
    requestId,
    extra: {},
  };
}

/**
 * 简单的 Cookie 解析函数
 *
 * 将 Cookie 头部字符串解析为键值对对象。
 * 例如: "a=1; b=2" → { a: "1", b: "2" }
 *
 * @param cookieHeader - Cookie 头部字符串
 * @returns Cookie 键值对
 */
function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach((pair) => {
    const [key, ...rest] = pair.split('=');
    if (key) {
      const trimmedKey = key.trim();
      const value = rest.join('=').trim();
      if (trimmedKey) {
        cookies[trimmedKey] = value;
      }
    }
  });

  return cookies;
}

/**
 * 创建核心渲染中间件
 *
 * @param options - 渲染中间件配置
 * @returns Koa 中间件函数
 */
export function renderMiddleware(options: RenderMiddlewareOptions): Koa.Middleware {
  const {
    config,
    pluginManager,
    degradationManager,
    appElementFactory,
    moduleLoader,
    isrManager,
    assetManifest,
    runtimeProvider,
    matchRoute = defaultMatchRoute,
  } = options;

  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    /**
     * 仅处理 GET 和 HEAD 请求
     *
     * 页面渲染只响应 GET 请求（以及 HEAD 请求），
     * POST/PUT/DELETE 等方法应该由 API 路由或其他中间件处理。
     */
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      await next();
      return;
    }

    const timer = createTimer();
    const requestId = (ctx.state.requestId as string) || 'unknown';
    const requestLogger = (ctx.state.logger as Logger) || moduleLogger;

    // ===== 1. 路由匹配 =====
    const matchResult = matchRoute(ctx.path, config.routes);

    if (!matchResult) {
      /**
       * 路由未匹配 — 交给下游中间件处理
       * 这可能是一个 API 请求或者 404 页面
       */
      requestLogger.debug('路由未匹配，跳过渲染', {
        path: ctx.path,
        requestId,
      });
      await next();
      return;
    }

    requestLogger.info('开始渲染流程', {
      path: ctx.path,
      requestId,
      renderMode: matchResult.route.renderMode,
      params: matchResult.params,
    });

    // ===== 2. 创建渲染上下文 =====
    const renderContext = createRenderContext(ctx, matchResult, requestId);

    // ===== 3. 选择渲染器 =====
    const renderMode = matchResult.route.renderMode || config.defaultRenderMode;
    let renderer: BaseRenderer | undefined;

    const resolveRenderer = async (): Promise<BaseRenderer> => {
      if (renderer) return renderer;

      try {
        // 创建失败后的 Level 1 重试会重新读取 runtimeProvider，开发态可在
        // server bundle 刚编译完成时自愈，而不是重复抛出同一个旧错误。
        const runtime = runtimeProvider ? await runtimeProvider() : undefined;
        renderer = RendererFactory.create({
          mode: renderMode,
          config,
          pluginManager: pluginManager as unknown as PluginManagerLike,
          appElementFactory: runtime?.appElementFactory ?? appElementFactory,
          moduleLoader: runtime?.moduleLoader ?? moduleLoader,
          assetManifest: runtime?.assetManifest ?? assetManifest,
          isrManager,
          preferStreaming:
            renderMode === RenderMode.SSR && matchResult.route.meta?.streaming === true,
        });
        return renderer;
      } catch (error) {
        const creationError = error instanceof Error ? error : new Error(String(error));
        requestLogger.error('创建渲染器失败，交由统一降级管线处理', {
          requestId,
          renderMode,
          error: creationError.message,
        });

        // 此时还没有 BaseRenderer，需由中间件补发 renderError hook，
        // 让骨架插件等仍可提供 Level 3 候选；真正 render() 的错误由 Renderer 自己通知。
        try {
          await pluginManager.callHook('renderError', renderContext, creationError);
        } catch (hookError) {
          requestLogger.warn('渲染器创建失败后的 renderError hook 执行异常', {
            requestId,
            error: hookError instanceof Error ? hookError.message : String(hookError),
          });
        }

        throw creationError;
      }
    };

    // ===== 4. 执行渲染与统一降级 =====
    // DegradationManager 从第一次渲染开始接管，保证 maxRetries 精确表示
    // “首次失败后的重试次数”，同时让插件骨架屏只作为 Level 3 候选。
    const performRender = async (context: RenderContext): Promise<RenderResult> => {
      const activeRenderer = await resolveRenderer();
      const streamingRenderer = activeRenderer as BaseRenderer & {
        renderToStream?: (renderContext: RenderContext) => Promise<RenderResult>;
      };

      return renderMode === RenderMode.SSR &&
        matchResult.route.meta?.streaming === true &&
        ctx.method !== 'HEAD' &&
        typeof streamingRenderer.renderToStream === 'function'
        ? streamingRenderer.renderToStream(context)
        : activeRenderer.render(context);
    };

    const degradationResult = await degradationManager.executeWithDegradation(
      performRender,
      renderContext,
      config.fallback,
    );
    const result = degradationResult.result;

    // ===== 5. 消费插件写入的 extra 字段 =====
    // 正常、重试与所有降级结果都经过同一响应协议，避免某条错误分支丢失响应头。
    applyPluginExtras(ctx, renderContext, result);

    // ISR 缓存层在 await next() 返回后读取该标记。
    // 完整渲染或重试成功可以缓存；CSR/骨架/静态页/503 以及数据降级结果不可缓存。
    ctx.state.namiDegradationLevel = degradationResult.level;
    ctx.state.namiRenderResult = result;
    ctx.state.namiCacheable =
      result.statusCode >= 200 &&
      result.statusCode < 300 &&
      ((degradationResult.level === DegradationLevel.Retry &&
        renderContext.extra.__retry_result_cacheable !== false) ||
        (degradationResult.level === DegradationLevel.None && result.meta.degraded === false));

    // ===== 6. 设置响应 =====
    setResponse(ctx, result, requestLogger);

    if (degradationResult.level === DegradationLevel.None) {
      requestLogger.info('渲染完成', {
        requestId,
        renderMode: result.meta.renderMode,
        duration: timer.total(),
        degraded: result.meta.degraded,
        statusCode: result.statusCode,
      });
      return;
    }

    const firstError = degradationResult.errors[0];
    requestLogger.error('渲染异常，已执行降级流程', {
      requestId,
      path: ctx.path,
      renderMode,
      error: firstError?.message,
      stack: firstError?.stack,
    });

    requestLogger.warn('降级渲染完成', {
      requestId,
      degradationLevel: degradationResult.level,
      duration: timer.total(),
      errorCount: degradationResult.errors.length,
    });
  };
}

/**
 * 消费插件通过 context.extra 传递的协议字段
 *
 * 插件可通过 context.extra 写入响应期协议字段，render-middleware 在得到最终
 * RenderResult 后将它们映射到 HTTP 响应。页面缓存命中不在这里处理：
 * BaseRenderer 已在数据预取和 React 渲染前完成短路。
 *
 * 约定字段：
 * - __csr_shell_skeleton: string — 正常/降级 CSR Shell 的临时 loading 片段
 * - __skeleton_fallback: string — Level 3 使用的被动静态应急 HTML（兼容字段名）
 * - __retry_attempted: boolean — 插件已触发重试标记
 * - __custom_headers: Record<string, string> — 插件注入的自定义响应头
 */
function applyPluginExtras(
  ctx: Koa.Context,
  renderContext: RenderContext,
  result: RenderResult,
): void {
  const { extra } = renderContext;
  if (!extra || Object.keys(extra).length === 0) return;

  // 插件注入的自定义响应头
  if (extra.__custom_headers && typeof extra.__custom_headers === 'object') {
    for (const [key, value] of Object.entries(extra.__custom_headers as Record<string, string>)) {
      if (typeof value === 'string') {
        result.headers[key] = value;
      }
    }
  }

  // 重试标记 — 写入响应头便于监控
  if (extra.__retry_attempted === true) {
    result.headers['X-Nami-Retry'] = '1';
  }

  // 将 extra 挂到 ctx.state 供下游中间件消费
  ctx.state.namiExtra = extra;
}

/**
 * 将 RenderResult 写入 Koa 响应
 *
 * @param ctx - Koa 上下文
 * @param result - 渲染结果
 * @param logger - 日志实例
 */
function setResponse(ctx: Koa.Context, result: RenderResult, _logger: Logger): void {
  // 设置 HTTP 状态码
  ctx.status = result.statusCode;

  if (result.meta.degraded) {
    // 同时写回 RenderResult，确保外层 ISR singleflight 的跟随请求也能恢复
    // 同一份不可缓存协议，而不只是在当前 Koa Context 上看到该响应头。
    result.headers['X-Nami-Degraded'] ??= '1';
    result.headers['Cache-Control'] = 'private, no-store, max-age=0';
  }

  // 设置响应头
  for (const [key, value] of Object.entries(result.headers)) {
    ctx.set(key, value);
  }

  /**
   * 设置缓存控制头
   *
   * 如果渲染结果包含 cacheControl 配置（通常来自 ISR 路由），
   * 则设置对应的 Cache-Control 头部。
   */
  if (result.meta.degraded) {
    // 数据预取失败后继续渲染得到的页面只能服务当前请求，不能进入 CDN/ISR。
    // 该显式协议也供绕过 ISR cache 的后台重验证请求识别失败结果，避免
    // 用空 props 的降级 HTML 覆盖仍然可用的 stale 缓存。
    const degradedCacheControl = 'private, no-store, max-age=0';
    ctx.state.namiCacheControl = degradedCacheControl;
    ctx.set('X-Nami-Degraded', result.headers['X-Nami-Degraded'] ?? '1');
    ctx.set('Cache-Control', degradedCacheControl);
  } else if (result.cacheControl) {
    const { revalidate, staleWhileRevalidate, tags } = result.cacheControl;
    let cacheValue = `s-maxage=${revalidate}`;

    if (staleWhileRevalidate) {
      cacheValue += `, stale-while-revalidate=${staleWhileRevalidate}`;
    }

    // 将最终缓存语义挂到请求上下文上，供外层中间件在响应收尾阶段兜底回写。
    // 这样即使后续链路里有历史逻辑覆盖了 Cache-Control，ISR/SSG 仍能保持一致的协议表达。
    ctx.state.namiCacheControl = cacheValue;
    ctx.state.namiCacheTags = tags;
    if (tags && tags.length > 0) {
      ctx.set('X-Nami-Cache-Tags', tags.join(','));
    }
    ctx.set('Cache-Control', cacheValue);
  }

  // 设置响应体
  if ('isStreaming' in result && result.isStreaming && 'stream' in result && result.stream) {
    ctx.body = result.stream;
    return;
  }

  ctx.body = result.html;
}
