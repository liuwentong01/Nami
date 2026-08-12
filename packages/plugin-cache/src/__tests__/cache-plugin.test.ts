import { describe, expect, it, vi } from 'vitest';
import {
  RenderMode,
  type AfterRenderHook,
  type BeforeRenderHook,
  type CacheStore,
  type PluginAPI,
  type RenderContext,
  type RenderResult,
} from '@nami/shared';
import { NamiCachePlugin } from '../cache-plugin';

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

function createContext(
  renderMode = RenderMode.SSR,
  headers: RenderContext['headers'] = {},
): RenderContext {
  return {
    url: 'http://localhost/page',
    path: '/page',
    query: {},
    headers,
    route: {
      path: '/page',
      component: './pages/page',
      renderMode,
    },
    params: {},
    timing: { startTime: Date.now() },
    requestId: 'request-1',
    extra: {},
  };
}

function createResult(overrides: Partial<RenderResult> = {}): RenderResult {
  return {
    html: '<html>page</html>',
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=30',
      'X-Request-Id': 'must-not-be-shared',
    },
    meta: {
      renderMode: RenderMode.SSR,
      duration: 1,
      degraded: false,
      dataFetchDuration: 0,
    },
    ...overrides,
  };
}

async function setupPlugin(plugin: NamiCachePlugin): Promise<{
  beforeRender: BeforeRenderHook;
  afterRender: AfterRenderHook;
}> {
  let beforeRender: BeforeRenderHook | undefined;
  let afterRender: AfterRenderHook | undefined;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const api = {
    getLogger: () => logger,
    onBeforeRender: (hook: BeforeRenderHook) => {
      beforeRender = hook;
    },
    onAfterRender: (hook: AfterRenderHook) => {
      afterRender = hook;
    },
    onDispose: vi.fn(),
  } as unknown as PluginAPI;

  await plugin.setup(api);
  if (!beforeRender || !afterRender) {
    throw new Error('cache hooks were not registered');
  }
  return { beforeRender, afterRender };
}

describe('NamiCachePlugin', () => {
  it('缓存正常公开页面且只保存安全响应头', async () => {
    const store = createStore();
    const plugin = new NamiCachePlugin({ store });
    const { beforeRender, afterRender } = await setupPlugin(plugin);
    const context = createContext();

    await beforeRender(context);
    await afterRender(context, createResult());

    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(store.set).mock.calls[0]?.[1];
    expect(entry?.meta?.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=30',
    });
    expect(entry?.meta?.headers).not.toHaveProperty('X-Request-Id');
  });

  it('默认旁路 Cookie/Authorization 个性化请求', async () => {
    const store = createStore();
    const plugin = new NamiCachePlugin({ store });
    const { beforeRender, afterRender } = await setupPlugin(plugin);
    const context = createContext(RenderMode.SSR, { cookie: 'session=secret' });

    await beforeRender(context);
    await afterRender(context, createResult());

    expect(context.extra.__cache_bypass).toBe(true);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('旁路 ISR，避免与框架 ISR 缓存和失效协议冲突', async () => {
    const store = createStore();
    const plugin = new NamiCachePlugin({ store });
    const { beforeRender, afterRender } = await setupPlugin(plugin);
    const context = createContext(RenderMode.ISR);

    await beforeRender(context);
    await afterRender(context, createResult({
      meta: {
        renderMode: RenderMode.ISR,
        duration: 1,
        degraded: false,
        dataFetchDuration: 0,
      },
    }));

    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('不缓存 degraded、streaming、private/no-store 响应', async () => {
    const store = createStore();
    const plugin = new NamiCachePlugin({ store });
    const { beforeRender, afterRender } = await setupPlugin(plugin);

    const degradedContext = createContext();
    await beforeRender(degradedContext);
    await afterRender(degradedContext, createResult({
      meta: {
        renderMode: RenderMode.CSR,
        duration: 1,
        degraded: true,
        dataFetchDuration: 0,
      },
    }));

    const privateContext = createContext();
    await beforeRender(privateContext);
    await afterRender(privateContext, createResult({
      headers: { 'Cache-Control': 'private, no-store' },
    }));

    const streamingContext = createContext();
    await beforeRender(streamingContext);
    await afterRender(
      streamingContext,
      {
        ...createResult(),
        html: '',
        isStreaming: true,
      } as RenderResult,
    );

    expect(store.set).not.toHaveBeenCalled();
  });
});
