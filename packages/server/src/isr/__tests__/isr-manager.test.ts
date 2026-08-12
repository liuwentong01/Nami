import { describe, expect, it, vi } from 'vitest';
import type { CacheStore, ISRConfig } from '@nami/shared';
import { ISRManager, type ISRRenderPayload } from '../isr-manager';

const isrConfig: ISRConfig = {
  enabled: true,
  cacheDir: '.nami-cache/isr',
  defaultRevalidate: 60,
  cacheAdapter: 'memory',
};

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
      memoryUsage: 0,
    }),
    ...overrides,
  };
}

describe('ISRManager', () => {
  it('cacheable=false 时返回结果但不写缓存', async () => {
    const store = createStore();
    const manager = new ISRManager(isrConfig, store);

    const result = await manager.getOrRevalidate(
      '/degraded',
      async () => ({
        html: '<div>skeleton</div>',
        cacheable: false,
        statusCode: 200,
        headers: { 'X-Nami-Degraded': 'skeleton' },
      }),
      60,
    );

    expect(store.set).not.toHaveBeenCalled();
    expect(result.cacheSkipped).toBe(true);
    expect(result.html).toContain('skeleton');
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['X-Nami-Degraded']).toBe('skeleton');
    await manager.close();
  });

  it('非 2xx 响应即使未显式标记也不写缓存', async () => {
    const store = createStore();
    const manager = new ISRManager(isrConfig, store);

    const result = await manager.getOrRevalidate(
      '/unavailable',
      async () => ({ html: '<h1>503</h1>', statusCode: 503 }),
      60,
    );

    expect(store.set).not.toHaveBeenCalled();
    expect(result.cacheSkipped).toBe(true);
    expect(result.statusCode).toBe(503);
    await manager.close();
  });

  it('可缓存结果在返回前完成缓存写入', async () => {
    let finishWrite: (() => void) | undefined;
    const set = vi.fn(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const store = createStore({ set });
    const manager = new ISRManager(isrConfig, store);
    let settled = false;

    const pending = manager.getOrRevalidate(
      '/page',
      async () => '<html>page</html>',
      60,
    ).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    finishWrite?.();

    const result = await pending;
    expect(result.isCacheMiss).toBe(true);
    expect(settled).toBe(true);
    await manager.close();
  });

  it('同 key 并发冷 MISS 合并渲染并共享完整响应', async () => {
    const store = createStore();
    const manager = new ISRManager(isrConfig, store);
    let finishRender: ((payload: ISRRenderPayload) => void) | undefined;
    const render = vi.fn(() => new Promise<ISRRenderPayload>((resolve) => {
      finishRender = resolve;
    }));

    const first = manager.getOrRevalidate('/same', render, 60);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    const follower = manager.getOrRevalidate('/same', render, 60);

    finishRender?.({
      html: '<html>shared</html>',
      statusCode: 200,
      headers: { 'X-Test': 'shared' },
    });

    const [firstResult, followerResult] = await Promise.all([first, follower]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(followerResult.html).toBe(firstResult.html);
    expect(followerResult.statusCode).toBe(200);
    expect(followerResult.headers?.['X-Test']).toBe('shared');
    await manager.close();
  });

  it('Fresh HIT 不执行渲染函数', async () => {
    const store = createStore({
      get: vi.fn().mockResolvedValue({
        content: '<html>cached</html>',
        createdAt: Date.now(),
        revalidateAfter: 60,
        tags: [],
        etag: 'etag-cached',
      }),
    });
    const manager = new ISRManager(isrConfig, store);
    const render = vi.fn();

    const result = await manager.getOrRevalidate('/cached', render, 60);

    expect(render).not.toHaveBeenCalled();
    expect(result.isCacheMiss).toBe(false);
    expect(result.isStale).toBe(false);
    expect(result.html).toContain('cached');
    await manager.close();
  });
});
