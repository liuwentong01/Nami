import type Koa from 'koa';
import type { NamiConfig, Logger } from '@nami/shared';
import {
  NAMI_DATA_API_PREFIX,
  RenderMode,
  createLogger,
} from '@nami/shared';
import type { ModuleLoaderLike } from '@nami/core';
import { matchConfiguredRoute } from './route-match';

const moduleLogger = createLogger('@nami/server:data-prefetch');

export interface DataPrefetchMiddlewareOptions {
  config: NamiConfig;
  moduleLoader?: ModuleLoaderLike;
  runtimeProvider?: () => Promise<{
    moduleLoader?: ModuleLoaderLike;
  }>;
  dataApiPrefix?: string;
}

export function dataPrefetchMiddleware(
  options: DataPrefetchMiddlewareOptions,
): Koa.Middleware {
  const {
    config,
    moduleLoader,
    runtimeProvider,
    dataApiPrefix = NAMI_DATA_API_PREFIX,
  } = options;

  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    if (ctx.method !== 'GET') {
      await next();
      return;
    }

    if (!ctx.path.startsWith(dataApiPrefix)) {
      await next();
      return;
    }

    const logger = (ctx.state.logger as Logger) || moduleLogger;
    const requestPath = normalizeDataPath(ctx.path.slice(dataApiPrefix.length));
    const matchResult = matchConfiguredRoute(requestPath, config.routes);

    if (!matchResult) {
      ctx.status = 404;
      ctx.body = { message: 'Route not found' };
      return;
    }

    const runtime = runtimeProvider ? await runtimeProvider() : undefined;
    const activeModuleLoader = runtime?.moduleLoader ?? moduleLoader;

    if (!activeModuleLoader) {
      logger.debug('数据预取请求缺少可用的 ModuleLoader，降级到下游中间件', {
        requestPath,
      });
      await next();
      return;
    }

    const route = matchResult.route;

    try {
      if (route.renderMode === RenderMode.SSR && route.getServerSideProps) {
        const gssp = await activeModuleLoader.getExportedFunction<
          (context: {
            params: Record<string, string>;
            query: Record<string, string | string[]>;
            headers: Record<string, string | string[] | undefined>;
            path: string;
            url: string;
            cookies: Record<string, string>;
            requestId: string;
          }) => Promise<{
            props?: Record<string, unknown>;
            redirect?: { destination: string; permanent?: boolean; statusCode?: number };
            notFound?: boolean;
          }>
        >(route.component, route.getServerSideProps);

        if (!gssp) {
          ctx.status = 404;
          ctx.body = { message: 'getServerSideProps not found' };
          return;
        }

        const result = await gssp({
          params: matchResult.params,
          query: normalizeQuery(ctx.query),
          headers: normalizeHeaders(ctx.headers),
          path: requestPath,
          url: `${requestPath}${ctx.querystring ? `?${ctx.querystring}` : ''}`,
          cookies: parseCookies(ctx.get('cookie')),
          requestId: (ctx.state.requestId as string) || 'unknown',
        });

        if (result.notFound) {
          ctx.status = 404;
          ctx.body = { notFound: true };
          return;
        }

        if (result.redirect) {
          ctx.status = result.redirect.statusCode ?? (result.redirect.permanent ? 308 : 307);
          ctx.body = { redirect: result.redirect };
          return;
        }

        ctx.status = 200;
        ctx.body = result.props ?? {};
        return;
      }

      if (
        (route.renderMode === RenderMode.SSG || route.renderMode === RenderMode.ISR)
        && route.getStaticProps
      ) {
        const gsp = await activeModuleLoader.getExportedFunction<
          (context: { params: Record<string, string> }) => Promise<{
            props?: Record<string, unknown>;
            redirect?: { destination: string; permanent?: boolean };
            notFound?: boolean;
          }>
        >(route.component, route.getStaticProps);

        if (!gsp) {
          ctx.status = 404;
          ctx.body = { message: 'getStaticProps not found' };
          return;
        }

        const result = await gsp({
          params: matchResult.params,
        });

        if (result.notFound) {
          ctx.status = 404;
          ctx.body = { notFound: true };
          return;
        }

        if (result.redirect) {
          ctx.status = result.redirect.permanent ? 308 : 307;
          ctx.body = { redirect: result.redirect };
          return;
        }

        ctx.status = 200;
        ctx.body = result.props ?? {};
        return;
      }

      ctx.status = 204;
      ctx.body = null;
    } catch (error) {
      logger.warn('路由数据预取失败', {
        requestPath,
        error: error instanceof Error ? error.message : String(error),
      });
      ctx.status = 500;
      ctx.body = { message: 'Failed to prefetch route data' };
    }
  };
}

function normalizeDataPath(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }

  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function normalizeQuery(
  query: Koa.Context['query'],
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' || Array.isArray(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function normalizeHeaders(
  headers: Koa.Context['headers'],
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' || Array.isArray(value) || value === undefined) {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) {
    return cookies;
  }

  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.split('=');
    if (!key) {
      continue;
    }

    const trimmedKey = key.trim();
    if (!trimmedKey) {
      continue;
    }

    cookies[trimmedKey] = rest.join('=').trim();
  }

  return cookies;
}
