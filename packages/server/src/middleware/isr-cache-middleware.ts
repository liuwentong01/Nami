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
import type { NamiConfig, NamiRoute, RenderResult, RouteMatchResult, Logger } from '@nami/shared';
import { NAMI_ISR_REVALIDATE_HEADER, RenderMode, createLogger } from '@nami/shared';
import type { ISRManager, ISRRenderPayload } from '../isr/isr-manager';
import { responseHeadersToRecord, sanitizeCachedResponseHeaders } from '../isr/response-headers';
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
   * 默认使用完整请求 URL（pathname + query）作为缓存键。
   * 如果页面内容还依赖 Cookie 等请求信息，需要自定义此函数。
   *
   * @param ctx - Koa 上下文
   * @returns 缓存键字符串
   */
  generateCacheKey?: (ctx: Koa.Context) => string;
}

/** 模块级日志实例 */
const moduleLogger: Logger = createLogger('@nami/server:isr-cache');
const ISR_REVALIDATE_TOKEN_HEADER = 'x-nami-isr-revalidate-token';
const ISR_REVALIDATE_TOKEN_ENV = 'NAMI_ISR_REVALIDATE_TOKEN';
const ISR_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function shouldInvalidateISRCache(statusCode: number): boolean {
  return statusCode === 404 || ISR_REDIRECT_STATUS_CODES.has(statusCode);
}

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
 * 使用完整请求 URL（pathname + query）作为缓存键。
 * 这与 core ISRRenderer、Hydration 数据作用域保持一致，避免同一路径下
 * 不同查询参数互相污染缓存或错误复用首屏 props。
 *
 * @param ctx - Koa 上下文
 * @returns 缓存键
 */
function defaultGenerateCacheKey(ctx: Koa.Context): string {
  return ctx.url;
}

function buildISRCacheControl(revalidateSeconds: number): string {
  return `public, s-maxage=${revalidateSeconds}, stale-while-revalidate=${revalidateSeconds * 2}`;
}

function normalizeIPAddress(ip: string): string {
  return ip.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
}

function isLoopbackAddress(ip: string): boolean {
  const normalized = normalizeIPAddress(ip);
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.');
}

function isTrustedInternalAddress(ctx: Koa.Context, config: NamiConfig): boolean {
  const remoteAddress = normalizeIPAddress(ctx.ip || ctx.req.socket.remoteAddress || '');
  if (isLoopbackAddress(remoteAddress)) {
    return true;
  }

  const configuredHost = normalizeIPAddress(config.server.host || '');
  if (!configuredHost || configuredHost === '0.0.0.0' || configuredHost === '::') {
    return false;
  }

  return remoteAddress === configuredHost;
}

function isInternalRevalidateRequest(ctx: Koa.Context, config: NamiConfig): boolean {
  if (ctx.get(NAMI_ISR_REVALIDATE_HEADER) !== '1') {
    return false;
  }

  const expectedToken = process.env[ISR_REVALIDATE_TOKEN_ENV];
  if (expectedToken && ctx.get(ISR_REVALIDATE_TOKEN_HEADER) !== expectedToken) {
    return false;
  }

  return isTrustedInternalAddress(ctx, config);
}

function normalizeInternalHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }

  const normalized = normalizeIPAddress(host);
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

function buildInternalRevalidateURL(ctx: Koa.Context, config?: NamiConfig): string {
  const host = normalizeInternalHost(config?.server.host);
  const port = config?.server.port ?? ctx.req.socket.localPort;
  const portPart = port ? `:${port}` : '';
  const query = ctx.querystring ? `?${ctx.querystring}` : '';

  return `http://${host}${portPart}${ctx.path}${query}`;
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
export function isrCacheMiddleware(options: ISRCacheMiddlewareOptions): Koa.Middleware {
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

    // 内部后台重验证请求需要绕过 ISR 缓存层，避免 stale 命中再次把自己重新排队。
    if (isInternalRevalidateRequest(ctx, config)) {
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
    let downstreamInvoked = false;
    let cacheOperationCompleted = false;

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
          downstreamInvoked = true;
          await next();

          const renderResult = ctx.state.namiRenderResult as RenderResult | undefined;
          const statusCode = renderResult?.statusCode ?? ctx.status;
          return {
            html: typeof ctx.body === 'string' ? ctx.body : String(ctx.body || ''),
            tags: Array.isArray(ctx.state.namiCacheTags)
              ? (ctx.state.namiCacheTags as string[])
              : undefined,
            cacheable:
              ctx.state.namiCacheable === true && renderResult?.meta.renderMode === RenderMode.ISR,
            statusCode,
            headers: renderResult ? { ...renderResult.headers } : undefined,
            revalidate: renderResult?.cacheControl?.revalidate,
            invalidate:
              renderResult?.meta.degraded !== true && shouldInvalidateISRCache(statusCode),
          };
        },
        revalidateSeconds,
        async () => await revalidateByInternalRequest(ctx, config),
      );
      cacheOperationCompleted = true;

      /**
       * 缓存命中 — 直接返回缓存内容
       */
      if (cacheResult && !cacheResult.isCacheMiss) {
        const cachedRevalidate = cacheResult.revalidateAfter ?? revalidateSeconds;
        const cachedHeaders = sanitizeCachedResponseHeaders(cacheResult.headers);
        if (cachedHeaders) {
          for (const [name, value] of Object.entries(cachedHeaders)) {
            ctx.set(name, value);
          }
        }
        if (!ctx.response.get('Content-Type')) {
          ctx.type = 'text/html; charset=utf-8';
        }
        ctx.body = cacheResult.html;
        ctx.status = cacheResult.statusCode ?? 200;

        // 设置缓存相关的响应头
        ctx.state.namiCacheControl = buildISRCacheControl(cachedRevalidate);
        ctx.set('X-Nami-Cache', cacheResult.isStale ? 'STALE' : 'HIT');
        ctx.set('X-Nami-Render-Mode', RenderMode.ISR);
        ctx.set('Cache-Control', ctx.state.namiCacheControl);

        if (cacheResult.etag) {
          ctx.set('ETag', cacheResult.etag);
        }

        if (cacheResult.createdAt) {
          ctx.set(
            'X-Nami-Cache-Age',
            String(Math.round((Date.now() - cacheResult.createdAt) / 1000)),
          );
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
       * 并发冷 MISS 的跟随请求可能没有执行自己的 next()，因此必须使用
       * ISRManager 返回的共享结果恢复 body / status / headers。
       */
      ctx.body = cacheResult.html;
      if (cacheResult.statusCode !== undefined) {
        ctx.status = cacheResult.statusCode;
      }
      if (cacheResult.headers) {
        for (const [name, value] of Object.entries(
          sanitizeCachedResponseHeaders(cacheResult.headers) ?? {},
        )) {
          ctx.set(name, value);
        }
      }

      if (cacheResult.cacheSkipped) {
        ctx.state.namiCacheControl = undefined;
        ctx.set('X-Nami-Cache', 'SKIP');
        ctx.set('Cache-Control', 'private, no-store, max-age=0');

        requestLogger.warn('ISR 渲染结果不可缓存，已跳过写入', {
          requestId,
          cacheKey,
          statusCode: ctx.status,
        });
        return;
      }

      const renderedRevalidate = cacheResult.revalidateAfter ?? revalidateSeconds;
      ctx.state.namiCacheControl = buildISRCacheControl(renderedRevalidate);
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
      // 缓存层自身失败时才旁路到渲染；如果下游已经执行并抛错，必须继续上抛，
      // 不能再次调用同一个 Koa next()。
      if (downstreamInvoked || cacheOperationCompleted) {
        requestLogger.error('ISR 下游渲染或响应处理失败', {
          requestId,
          cacheKey,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
        throw cacheError;
      }

      requestLogger.error('ISR 缓存查询失败，降级为直接渲染', {
        requestId,
        cacheKey,
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      });

      await next();
      ctx.set('X-Nami-Cache', 'BYPASS');
    }
  };
}

export async function revalidateByInternalRequest(
  ctx: Koa.Context,
  config?: NamiConfig,
): Promise<ISRRenderPayload> {
  const url = buildInternalRevalidateURL(ctx, config);
  const token = process.env[ISR_REVALIDATE_TOKEN_ENV];
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      ...buildInternalRevalidateHeaders(ctx),
      [NAMI_ISR_REVALIDATE_HEADER]: '1',
      ...(token ? { [ISR_REVALIDATE_TOKEN_HEADER]: token } : {}),
      'X-Requested-With': 'nami-isr-revalidate',
    },
  });

  const statusCode = response.status;
  const html = await response.text();
  const responseHeaders = sanitizeCachedResponseHeaders(responseHeadersToRecord(response.headers));
  const cacheControl = response.headers.get('cache-control') ?? '';
  const degraded = response.headers.get('x-nami-degraded');

  // 降级响应不能覆盖或删除 stale 内容；它与业务主动返回 notFound 是两种语义。
  if (degraded) {
    throw new Error(`后台重验证返回不可缓存响应: ${degraded}`);
  }

  if (shouldInvalidateISRCache(statusCode)) {
    return {
      html,
      cacheable: false,
      invalidate: true,
      statusCode,
      headers: responseHeaders,
    };
  }

  if (!response.ok) {
    throw new Error(`后台重验证请求失败: ${response.status} ${response.statusText}`);
  }

  if (/(?:^|,)\s*(?:private|no-store)\b/i.test(cacheControl)) {
    throw new Error('后台重验证返回不可缓存响应');
  }

  const tagsHeader = response.headers.get('x-nami-cache-tags');
  return {
    html,
    tags: tagsHeader
      ? tagsHeader
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : undefined,
    revalidate: parseRevalidateFromCacheControl(cacheControl),
    statusCode,
    headers: responseHeaders,
  };
}

/**
 * 后台重验证必须复用触发 stale 请求的身份与 vary 维度。
 * Cookie、Authorization、Host、租户/语言等自定义头都可能影响 HTML；如果只
 * 请求 loopback URL 而不转发它们，会把错误变体写回原 cache key。
 * 仅剔除不能安全重放的 hop-by-hop、请求体与条件请求头。
 */
function buildInternalRevalidateHeaders(ctx: Koa.Context): Record<string, string> {
  const excludedHeaders = new Set([
    'connection',
    'content-length',
    'if-modified-since',
    'if-none-match',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'range',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(ctx.headers)) {
    const normalizedName = name.toLowerCase();
    if (excludedHeaders.has(normalizedName) || value === undefined) {
      continue;
    }

    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  return headers;
}

function parseRevalidateFromCacheControl(cacheControl: string): number | undefined {
  const match = cacheControl.match(/(?:^|,)\s*s-maxage\s*=\s*([^,\s]+)/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}
