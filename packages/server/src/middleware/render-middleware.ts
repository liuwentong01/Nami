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
import {
  RenderMode,
  createLogger,
  createTimer,
} from '@nami/shared';
import { RendererFactory, matchPath, rankRoutes } from '@nami/core';
import type { BaseRenderer, PluginManagerLike, AppElementFactory } from '@nami/core';
import { PluginManager } from '@nami/core';
import { DegradationManager } from '@nami/core';

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
function defaultMatchRoute(
  requestPath: string,
  routes: NamiRoute[],
): RouteMatchResult | null {
  // 按优先级排序（最具体的路由排在最前面）
  const sortedRoutes = rankRoutes(routes);

  for (const route of sortedRoutes) {
    const exact = route.exact !== false;
    const result = matchPath(route.path, requestPath, { exact });

    if (result) {
      return {
        route,
        params: result.params,
        isExact: !route.path.includes('*'),
      };
    }
  }

  return null;
}

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
    if (value !== undefined) {
      query[key] = value;
    }
  }

  /**
   * 提取请求头（转小写键名）
   * 过滤掉 cookie 等敏感头部，只保留业务相关的头部信息
   */
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(ctx.headers)) {
    headers[key.toLowerCase()] = value;
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
export function renderMiddleware(
  options: RenderMiddlewareOptions,
): Koa.Middleware {
  const {
    config,
    pluginManager,
    degradationManager,
    appElementFactory,
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
    let renderer: BaseRenderer;

    try {
      renderer = RendererFactory.create({
        mode: renderMode,
        config,
        pluginManager: pluginManager as unknown as PluginManagerLike,
        appElementFactory,
      });
    } catch (error) {
      requestLogger.error('创建渲染器失败，降级处理', {
        requestId,
        renderMode,
        error: error instanceof Error ? error.message : String(error),
      });

      // 创建渲染器失败时，尝试使用 CSR 降级
      renderer = RendererFactory.create({
        mode: RenderMode.CSR,
        config,
      });
    }

    try {
      // ===== 4. 执行 onBeforeRender 钩子 =====
      await pluginManager.runParallelHook('onBeforeRender', renderContext);

      // ===== 5. 执行渲染 =====
      const result: RenderResult = await renderer.render(renderContext);

      // ===== 6. 执行 onAfterRender 钩子 =====
      await pluginManager.runParallelHook('onAfterRender', renderContext, result);

      // ===== 7. 设置响应 =====
      setResponse(ctx, result, requestLogger);

      requestLogger.info('渲染完成', {
        requestId,
        renderMode: result.meta.renderMode,
        duration: timer.total(),
        degraded: result.meta.degraded,
        statusCode: result.statusCode,
      });
    } catch (renderError) {
      /**
       * ===== 8. 渲染异常处理 =====
       *
       * 渲染过程中发生错误时：
       * 1. 执行 onRenderError 钩子通知插件
       * 2. 使用 DegradationManager 执行降级策略
       * 3. 将降级结果写入响应
       */
      const normalizedError = renderError instanceof Error
        ? renderError
        : new Error(String(renderError));

      requestLogger.error('渲染异常，启动降级流程', {
        requestId,
        path: ctx.path,
        renderMode,
        error: normalizedError.message,
        stack: normalizedError.stack,
      });

      // 执行 onRenderError 钩子（错误隔离，不影响降级流程）
      try {
        await pluginManager.runParallelHook(
          'onRenderError',
          renderContext,
          normalizedError,
        );
      } catch (hookError) {
        requestLogger.warn('onRenderError 钩子执行失败', {
          requestId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
      }

      // 执行降级策略
      const degradationResult = await degradationManager.executeWithDegradation(
        async (ctx) => renderer.render(ctx),
        renderContext,
        config.fallback,
      );

      // 设置降级响应
      setResponse(ctx, degradationResult.result, requestLogger);

      requestLogger.warn('降级渲染完成', {
        requestId,
        degradationLevel: degradationResult.level,
        duration: timer.total(),
        errorCount: degradationResult.errors.length,
      });
    }
  };
}

/**
 * 将 RenderResult 写入 Koa 响应
 *
 * @param ctx - Koa 上下文
 * @param result - 渲染结果
 * @param logger - 日志实例
 */
function setResponse(
  ctx: Koa.Context,
  result: RenderResult,
  _logger: Logger,
): void {
  // 设置 HTTP 状态码
  ctx.status = result.statusCode;

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
  if (result.cacheControl) {
    const { revalidate, staleWhileRevalidate } = result.cacheControl;
    let cacheValue = `s-maxage=${revalidate}`;

    if (staleWhileRevalidate) {
      cacheValue += `, stale-while-revalidate=${staleWhileRevalidate}`;
    }

    ctx.set('Cache-Control', cacheValue);
  }

  // 设置响应体
  ctx.body = result.html;
}
