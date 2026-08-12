import { describe, expect, it, vi } from 'vitest';
import type Koa from 'koa';
import {
  RenderMode,
  type CacheStore,
  type NamiConfig,
  type RenderResult,
} from '@nami/shared';
import { ISRManager } from '../../isr/isr-manager';
import { isrCacheMiddleware } from '../isr-cache-middleware';

const isrRoute = {
  path: '/isr',
  component: './pages/isr',
  renderMode: RenderMode.ISR,
  revalidate: 60,
};

const config = {
  appName: 'test',
  srcDir: 'src',
  outDir: 'dist',
  defaultRenderMode: RenderMode.SSR,
  routes: [isrRoute],
  server: {
    port: 3000,
    host: '127.0.0.1',
    ssrTimeout: 5000,
    gracefulShutdown: true,
    gracefulShutdownTimeout: 30000,
  },
  webpack: {},
  isr: {
    enabled: true,
    cacheDir: '.nami-cache/isr',
    defaultRevalidate: 60,
    cacheAdapter: 'memory',
  },
  assets: { publicPath: '/', hash: true },
  monitor: { enabled: false, sampleRate: 1 },
  fallback: { ssrToCSR: true, timeout: 5000, maxRetries: 0 },
  plugins: [],
} as NamiConfig;

function createStore(overrides: Partial<CacheStore> = {}): CacheStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    clear: vi.fn().mockResolvedValue(undefined),
    invalidateByTag: vi.fn().mockResolvedValue(0),
    getStats: vi.fn().mockResolvedValue({
      totalEntries: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    }),
    ...overrides,
  };
}

function createContext(incomingHeaders: Record<string, string> = {}): {
  ctx: Koa.Context;
  responseHeaders: Record<string, string>;
} {
  const responseHeaders: Record<string, string> = {};
  const normalizedIncoming = Object.fromEntries(
    Object.entries(incomingHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const ctx = {
    method: 'GET',
    path: '/isr',
    url: '/isr',
    querystring: '',
    ip: '127.0.0.1',
    req: { socket: { remoteAddress: '127.0.0.1', localPort: 3000 } },
    state: { requestId: 'request-1' },
    status: 404,
    body: undefined,
    type: undefined,
    get: vi.fn((name: string) => normalizedIncoming[name.toLowerCase()] ?? ''),
    set: vi.fn((name: string, value: string) => {
      responseHeaders[name.toLowerCase()] = String(value);
    }),
  } as unknown as Koa.Context;

  return { ctx, responseHeaders };
}

function createRenderResult(
  overrides: Partial<RenderResult> = {},
): RenderResult {
  return {
    html: '<html>rendered</html>',
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Nami-Render-Mode': RenderMode.ISR,
    },
    meta: {
      renderMode: RenderMode.ISR,
      duration: 1,
      degraded: false,
      dataFetchDuration: 0,
    },
    ...overrides,
  };
}

const matchISRRoute = () => ({
  route: isrRoute,
  params: {},
  isExact: true,
});

describe('isrCacheMiddleware', () => {
  it('Fresh HIT 在渲染前短路', async () => {
    const store = createStore({
      get: vi.fn().mockResolvedValue({
        content: '<html>cached</html>',
        createdAt: Date.now(),
        revalidateAfter: 60,
        tags: [],
      }),
    });
    const manager = new ISRManager(config.isr, store);
    const middleware = isrCacheMiddleware({
      config,
      isrManager: manager,
      matchRoute: matchISRRoute,
    });
    const { ctx, responseHeaders } = createContext();
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.body).toBe('<html>cached</html>');
    expect(responseHeaders['x-nami-cache']).toBe('HIT');
    await manager.close();
  });

  it('正常冷 MISS 渲染一次并写入缓存', async () => {
    const store = createStore();
    const manager = new ISRManager(config.isr, store);
    const middleware = isrCacheMiddleware({
      config,
      isrManager: manager,
      matchRoute: matchISRRoute,
    });
    const { ctx, responseHeaders } = createContext();
    const result = createRenderResult();
    const next = vi.fn(async () => {
      ctx.body = result.html;
      ctx.status = result.statusCode;
      ctx.state.namiRenderResult = result;
      ctx.state.namiCacheable = true;
    });

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(ctx.body).toBe(result.html);
    expect(responseHeaders['x-nami-cache']).toBe('MISS');
    expect(responseHeaders['cache-control']).toContain('s-maxage=60');
    await manager.close();
  });

  it('降级冷 MISS 返回当前响应但不写入缓存', async () => {
    const store = createStore();
    const manager = new ISRManager(config.isr, store);
    const middleware = isrCacheMiddleware({
      config,
      isrManager: manager,
      matchRoute: matchISRRoute,
    });
    const { ctx, responseHeaders } = createContext();
    const result = createRenderResult({
      html: '<div>skeleton</div>',
      headers: {
        'X-Nami-Degraded': 'skeleton',
        'Cache-Control': 'private, no-store, max-age=0',
      },
      meta: {
        renderMode: RenderMode.CSR,
        duration: 1,
        degraded: true,
        degradeReason: 'skeleton',
        dataFetchDuration: 0,
      },
    });
    const next = vi.fn(async () => {
      ctx.body = result.html;
      ctx.status = result.statusCode;
      ctx.state.namiRenderResult = result;
      ctx.state.namiCacheable = false;
    });

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(store.set).not.toHaveBeenCalled();
    expect(ctx.body).toBe('<div>skeleton</div>');
    expect(responseHeaders['x-nami-cache']).toBe('SKIP');
    expect(responseHeaders['cache-control']).toContain('no-store');
    await manager.close();
  });

  it('下游抛错时不会第二次调用 next', async () => {
    const store = createStore();
    const manager = new ISRManager(config.isr, store);
    const middleware = isrCacheMiddleware({
      config,
      isrManager: manager,
      matchRoute: matchISRRoute,
    });
    const { ctx } = createContext();
    const next = vi.fn().mockRejectedValue(new Error('downstream failed'));

    await expect(middleware(ctx, next)).rejects.toThrow('downstream failed');
    expect(next).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it('缓存读取失败时只旁路渲染一次', async () => {
    const store = createStore({
      get: vi.fn().mockRejectedValue(new Error('cache unavailable')),
    });
    const manager = new ISRManager(config.isr, store);
    const middleware = isrCacheMiddleware({
      config,
      isrManager: manager,
      matchRoute: matchISRRoute,
    });
    const { ctx, responseHeaders } = createContext();
    const next = vi.fn(async () => {
      ctx.body = '<html>bypass</html>';
      ctx.status = 200;
    });

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.body).toBe('<html>bypass</html>');
    expect(responseHeaders['x-nami-cache']).toBe('BYPASS');
    await manager.close();
  });
});
