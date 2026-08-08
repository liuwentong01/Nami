import React from 'react';
import { NamiErrorBoundaryPlugin } from '@nami/plugin-error-boundary';
import { NamiMonitorPlugin } from '@nami/plugin-monitor';
import { NamiRequestPlugin } from '@nami/plugin-request';
import { NamiSkeletonPlugin } from '@nami/plugin-skeleton';
import type { NamiPlugin } from '@nami/shared';
import { App } from '../app';

const CLIENT_EVENT_NAME = 'nami-showcase:event';

function recordClientEvent(name: string, detail?: Record<string, unknown>): void {
  if (typeof window === 'undefined') {
    return;
  }

  const event: NamiShowcaseEvent = {
    name,
    at: new Date().toISOString(),
    detail,
  };

  window.__NAMI_SHOWCASE_EVENTS__ ??= [];
  window.__NAMI_SHOWCASE_EVENTS__.push(event);
  window.dispatchEvent(new CustomEvent(CLIENT_EVENT_NAME, { detail: event }));
}

/**
 * 一个刻意保持精简的自定义插件，用于把 Nami 的三端生命周期变成可观察结果：
 * 构建日志、Koa API/响应头、渲染响应头以及浏览器事件时间线。
 */
class ShowcaseLifecyclePlugin implements NamiPlugin {
  readonly name = 'showcase:lifecycle';
  readonly version = '1.0.0';
  readonly enforce = 'pre' as const;

  setup(api: Parameters<NamiPlugin['setup']>[0]): void {
    const logger = api.getLogger();

    api.modifyWebpackConfig((config, context) => ({
      ...config,
      stats: context.isDev ? 'errors-warnings' : config.stats,
    }));

    api.onBuildStart(() => {
      logger.info('[showcase] 构建生命周期：onBuildStart');
    });

    api.onBuildEnd(() => {
      logger.info('[showcase] 构建生命周期：onBuildEnd');
    });

    api.addServerMiddleware(async (ctx, next) => {
      const startedAt = Date.now();

      if (ctx.path === '/api/showcase/runtime' && ctx.method === 'GET') {
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
          source: 'showcase:lifecycle Koa middleware',
          serverTime: new Date().toISOString(),
          requestId: ctx.state.requestId ?? ctx.get('x-request-id') ?? 'not-exposed',
          capabilities: ['middleware', 'useClientFetch', 'SWR cache', 'manual refetch'],
        };
        return;
      }

      if (ctx.path === '/api/showcase/profile' && ctx.method === 'GET') {
        ctx.set('Cache-Control', 'private, max-age=5');
        ctx.body = {
          id: 'nami-interviewer',
          name: 'Nami Framework Learner',
          role: 'Full-stack Frontend Engineer',
          fetchedAt: new Date().toISOString(),
        };
        return;
      }

      if (ctx.path === '/api/showcase/failure') {
        ctx.status = 503;
        ctx.body = {
          code: 'SHOWCASE_CONTROLLED_FAILURE',
          message: '这是稳定性实验页主动触发的可控 503。',
        };
        return;
      }

      if (ctx.path === '/api/monitor/report' && ctx.method === 'POST') {
        ctx.status = 202;
        ctx.body = { accepted: true };
        return;
      }

      await next();
      ctx.set('X-Nami-Showcase-Middleware', 'active');
      ctx.set('X-Nami-Middleware-Duration', `${Date.now() - startedAt}ms`);
    });

    api.onServerStart(({ host, port }) => {
      logger.info('[showcase] 服务端生命周期：onServerStart', { host, port });
    });

    api.onBeforeRender((context) => {
      context.extra.__showcase_render_started_at = Date.now();
      context.extra.__custom_headers = {
        ...(context.extra.__custom_headers as Record<string, string> | undefined),
        'X-Nami-Showcase-Plugin': this.name,
        'X-Nami-Request-Id': context.requestId,
      };
    });

    api.onAfterRender((context, result) => {
      const startedAt = context.extra.__showcase_render_started_at;
      const duration =
        typeof startedAt === 'number' ? Date.now() - startedAt : result.meta.duration;

      result.headers['X-Nami-Plugin-Render-Duration'] = `${duration}ms`;
    });

    api.wrapApp((app) => <App>{app}</App>);

    api.onClientInit(() => {
      recordClientEvent('onClientInit', { plugin: this.name });
    });

    api.onHydrated(() => {
      recordClientEvent('onHydrated', { plugin: this.name });
    });

    api.onRouteChange((route) => {
      recordClientEvent('onRouteChange', route);
    });

    api.onError((error, context) => {
      recordClientEvent('onError', {
        message: error.message,
        ...context,
      });
    });

    api.onDispose(() => {
      recordClientEvent('onDispose', { plugin: this.name });
    });
  }
}

function createOfficialPlugins(target: 'server' | 'client'): NamiPlugin[] {
  const isServer = target === 'server';
  const apiOrigin = 'http://127.0.0.1:3100';

  return [
    new ShowcaseLifecyclePlugin(),
    new NamiRequestPlugin({
      serverOptions: {
        baseURL: apiOrigin,
        defaultTimeout: 2500,
        defaultHeaders: { 'X-Nami-Example': 'feature-showcase' },
      },
      clientOptions: {
        baseURL: '',
        defaultTimeout: 5000,
        credentials: 'same-origin',
      },
      retry: { maxRetries: 1, baseDelay: 150 },
      timeout: { defaultTimeout: 5000 },
      cache: { defaultTTL: 5000, maxEntries: 50 },
    }),
    new NamiSkeletonPlugin({
      defaultLayout: 'list',
      animation: 'pulse',
      routeSkeletons: {
        '/rendering/streaming': 'dashboard',
        '/products': 'list',
        '/products/:id': 'detail',
      },
      useAsFallback: true,
      enableSuspense: true,
    }),
    new NamiErrorBoundaryPlugin({
      retry: false,
      // 当前框架内核尚未消费插件写入的服务端渐进降级标记；示例只启用真实可用的客户端边界。
      enableDegradation: false,
      onError(error, context) {
        recordClientEvent('official-error-boundary', {
          message: error.message,
          ...context,
        });
      },
    }),
    new NamiMonitorPlugin({
      endpoint: isServer ? `${apiOrigin}/api/monitor/report` : '/api/monitor/report',
      enableWebVitals: false,
      flushInterval: 2000,
      reporterOptions: {
        disableInDev: false,
        flushInterval: 2000,
        maxBatchSize: 20,
        maxRetries: 1,
      },
      meta: {
        app: 'nami-feature-showcase',
        target,
      },
    }),
  ];
}

/** 每次调用都返回全新的插件实例，避免 client/server 构建共享可变状态。 */
export function createServerPlugins(): NamiPlugin[] {
  return createOfficialPlugins('server');
}

export function createClientPlugins(): NamiPlugin[] {
  return createOfficialPlugins('client');
}
