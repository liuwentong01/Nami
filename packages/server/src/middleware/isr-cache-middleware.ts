/**
 * @nami/server - ISR 缓存中间件
 *
 * 实现增量静态再生（ISR）的缓存层，位于渲染中间件之前。
 * 采用 stale-while-revalidate（SWR）策略，在保证内容实时性的同时最大化缓存命中率。
 *
 * 缓存查询逻辑：
 *
 * ```
 * 请求到达
 *   ↓
 * 是 ISR 路由？ --否--> 跳过，交给渲染中间件
 *   ↓ 是
 * 查询缓存
 *   ↓
 * 缓存命中？ --否--> 执行渲染中间件，缓存结果
 *   ↓ 是
 * 缓存新鲜？ --是--> 直接返回缓存（短路，不调用渲染）
 *   ↓ 否（过期但仍可用）
 * 返回过期内容 + 触发后台重验证
 * ```
 *
 * 性能优势：
 * - 缓存命中时响应时间 < 1ms（直接返回内存/文件中的 HTML）
 * - 缓存过期时不阻塞用户请求，后台异步更新
 * - 首次访问（冷启动）才需要等待完整渲染
 *
 * @example
 * ```typescript
 * import { isrCacheMiddleware } from '@nami/server';
 *
 * app.use(isrCacheMiddleware({
 *   config: namiConfig,
 *   isrManager,
 * }));
 * ```
 */

import type Koa from 'koa';
import type {
  NamiConfig,
  NamiRoute,
  RouteMatchResult,
  Logger,
} from '@nami/shared';
import { RenderMode, createLogger } from '@nami/shared';
import type { ISRManager } from '../isr/isr-manager';
import { matchConfiguredRoute } from './route-match';

/**
 * ISR 缓存中间件配置选项
 */
export interface ISRCacheMiddlewareOptions {
  /** Nami 框架主配置 */
  config: NamiConfig;

  /** ISR 管理器实例 */
  isrManager: ISRManager;

  /**
   * 自定义路由匹配函数
   * 如果不提供，使用与渲染中间件相同的简单匹配器
   */
  matchRoute?: (path: string, routes: NamiRoute[]) => RouteMatchResult | null;

  /**
   * 自定义缓存键生成函数
   *
   * 默认使用请求路径作为缓存键。
   * 如果页面内容依赖查询参数、Cookie 等因素，
   * 需要自定义此函数以生成包含这些因素的缓存键。
   *
   * @param ctx - Koa 上下文
   * @returns 缓存键字符串
   */
  generateCacheKey?: (ctx: Koa.Context) => string;
}

/** 模块级日志实例 */
const moduleLogger: Logger = createLogger('@nami/server:isr-cache');

/**
 * 默认的简单路由匹配器
 *
 * 与 render-middleware 中的匹配器逻辑一致。
 * 在实际项目中，建议通过配置注入统一的路由匹配器。
 */
const defaultMatchRoute = matchConfiguredRoute;

/**
 * 默认的缓存键生成函数
 *
 * 使用请求路径作为缓存键。
 * 注意：默认不包含查询参数，因为 ISR 页面通常不依赖查询参数。
 * 如果需要区分查询参数，请自定义 generateCacheKey。
 *
 * @param ctx - Koa 上下文
 * @returns 缓存键
 */
function defaultGenerateCacheKey(ctx: Koa.Context): string {
  return ctx.path;
}

function buildISRCacheControl(revalidateSeconds: number): string {
  return `public, s-maxage=${revalidateSeconds}, stale-while-revalidate=${revalidateSeconds * 2}`;
}

/**
 * 判断路由是否为 ISR 路由
 *
 * ISR 路由的判断条件：
 * 1. 路由的 renderMode 为 ISR
 * 2. 全局 ISR 配置已启用
 *
 * @param route - 路由配置
 * @param config - 框架主配置
 * @returns 是否为 ISR 路由
 */
function isISRRoute(route: NamiRoute, config: NamiConfig): boolean {
  return route.renderMode === RenderMode.ISR && config.isr.enabled;
}

/**
 * 创建 ISR 缓存中间件
 *
 * @param options - 配置选项
 * @returns Koa 中间件函数
 */
export function isrCacheMiddleware(
  options: ISRCacheMiddlewareOptions,
): Koa.Middleware {
  const {
    config,
    isrManager,
    matchRoute = defaultMatchRoute,
    generateCacheKey = defaultGenerateCacheKey,
  } = options;

  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    /**
     * 仅处理 GET 请求
     * POST/PUT/DELETE 请求不应命中 ISR 缓存
     */
    if (ctx.method !== 'GET') {
      await next();
      return;
    }

    const requestLogger = (ctx.state.logger as Logger) || moduleLogger;
    const requestId = (ctx.state.requestId as string) || 'unknown';

    // ===== 1. 路由匹配 =====
    const matchResult = matchRoute(ctx.path, config.routes);

    /**
     * 路由未匹配或不是 ISR 路由 → 跳过缓存层，交给下游处理
     */
    if (!matchResult || !isISRRoute(matchResult.route, config)) {
      await next();
      return;
    }

    // ===== 2. 生成缓存键 =====
    const cacheKey = generateCacheKey(ctx);
    const revalidateSeconds = matchResult.route.revalidate ?? config.isr.defaultRevalidate;

    requestLogger.debug('ISR 缓存查询', {
      requestId,
      cacheKey,
      revalidateSeconds,
    });

    // ===== 3. 查询 ISR 缓存 =====
    try {
      const cacheResult = await isrManager.getOrRevalidate(
        cacheKey,
        async () => {
          /**
           * 缓存未命中时的渲染回调
           *
           * 通过调用 next() 让请求继续到渲染中间件执行实际渲染。
           * 渲染完成后，ctx.body 中包含渲染产出的 HTML。
           */
          await next();
          return typeof ctx.body === 'string' ? ctx.body : String(ctx.body || '');
        },
        revalidateSeconds,
      );

      /**
       * 缓存命中 — 直接返回缓存内容
       */
      if (cacheResult && !cacheResult.isCacheMiss) {
        ctx.status = 200;
        ctx.type = 'text/html; charset=utf-8';
        ctx.body = cacheResult.html;

        // 设置缓存相关的响应头
        ctx.state.namiCacheControl = buildISRCacheControl(revalidateSeconds);
        ctx.set('X-Nami-Cache', cacheResult.isStale ? 'STALE' : 'HIT');
        ctx.set('X-Nami-Render-Mode', RenderMode.ISR);
        ctx.set('Cache-Control', ctx.state.namiCacheControl);

        if (cacheResult.etag) {
          ctx.set('ETag', cacheResult.etag);
        }

        if (cacheResult.createdAt) {
          ctx.set('X-Nami-Cache-Age', String(
            Math.round((Date.now() - cacheResult.createdAt) / 1000),
          ));
        }

        requestLogger.info('ISR 缓存命中', {
          requestId,
          cacheKey,
          isStale: cacheResult.isStale,
          cacheAge: cacheResult.createdAt
            ? Math.round((Date.now() - cacheResult.createdAt) / 1000)
            : undefined,
        });

        /**
         * 短路返回 — 不调用 next()（渲染中间件）
         * 这是 ISR 缓存的核心性能优势
         */
        return;
      }

      /**
       * 缓存未命中 — next() 已在 renderFn 中被调用
       * 渲染中间件已设置了 ctx.body，此处添加缓存标记头
       */
      ctx.state.namiCacheControl = buildISRCacheControl(revalidateSeconds);
      ctx.set('X-Nami-Cache', 'MISS');
      ctx.set('Cache-Control', ctx.state.namiCacheControl);

      requestLogger.info('ISR 缓存未命中，已执行渲染', {
        requestId,
        cacheKey,
      });
    } catch (cacheError) {
      /**
       * 缓存查询失败 — 降级为直接渲染
       *
       * ISR 缓存是性能优化手段，不是必要功能。
       * 缓存故障不应阻止页面正常渲染。
       */
      requestLogger.error('ISR 缓存查询失败，降级为直接渲染', {
        requestId,
        cacheKey,
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      });

      // 降级：直接执行渲染中间件
      await next();
      ctx.set('X-Nami-Cache', 'BYPASS');
    }
  };
}
