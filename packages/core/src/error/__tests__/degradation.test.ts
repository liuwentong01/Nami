import { describe, expect, it, vi } from 'vitest';
import {
  DegradationLevel,
  RenderMode,
  type FallbackConfig,
  type RenderResult,
} from '@nami/shared';
import { createMockRenderContext, createMockRoute } from '../../__tests__/mocks';
import { DegradationManager } from '../degradation';

const fallbackConfig = (
  overrides: Partial<FallbackConfig> = {},
): FallbackConfig => ({
  ssrToCSR: true,
  timeout: 5000,
  maxRetries: 0,
  ...overrides,
});

function createSuccessResult(html = '<html>success</html>'): RenderResult {
  return {
    html,
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=60',
    },
    meta: {
      renderMode: RenderMode.SSR,
      duration: 1,
      degraded: false,
      dataFetchDuration: 0,
    },
  };
}

describe('DegradationManager', () => {
  it('正常渲染只执行一次 Level 0', async () => {
    const manager = new DegradationManager();
    const render = vi.fn().mockResolvedValue(createSuccessResult());

    const result = await manager.executeWithDegradation(
      render,
      createMockRenderContext(),
      fallbackConfig({ maxRetries: 2 }),
    );

    expect(render).toHaveBeenCalledTimes(1);
    expect(result.level).toBe(DegradationLevel.None);
    expect(result.errors).toEqual([]);
  });

  it('首次失败后重试成功，插件骨架不能抢占重试结果', async () => {
    const manager = new DegradationManager();
    const context = createMockRenderContext();
    const render = vi.fn()
      .mockImplementationOnce(async () => {
        context.extra.__skeleton_fallback = '<div>plugin skeleton</div>';
        throw new Error('first render failed');
      })
      .mockResolvedValueOnce(createSuccessResult('<html>retry success</html>'));

    const result = await manager.executeWithDegradation(
      render,
      context,
      fallbackConfig({ maxRetries: 1 }),
    );

    expect(render).toHaveBeenCalledTimes(2);
    expect(result.level).toBe(DegradationLevel.Retry);
    expect(result.result.html).toContain('retry success');
    expect(result.result.headers['Cache-Control']).toBe('public, s-maxage=60');
    expect(context.extra.__skeleton_fallback_used).toBeUndefined();
  });

  it('CSR 开启时优先于插件骨架', async () => {
    const manager = new DegradationManager();
    const context = createMockRenderContext();
    const render = vi.fn(async () => {
      context.extra.__skeleton_fallback = '<div>plugin skeleton</div>';
      throw new Error('render failed');
    });

    const result = await manager.executeWithDegradation(
      render,
      context,
      fallbackConfig(),
    );

    expect(render).toHaveBeenCalledTimes(1);
    expect(result.level).toBe(DegradationLevel.CSRFallback);
    expect(result.result.html).toContain('<div id="nami-root"></div>');
    expect(result.result.html).not.toContain('plugin skeleton');
    expect(result.result.headers['Cache-Control']).toContain('no-store');
    expect(context.extra.__skeleton_fallback_used).toBeUndefined();
  });

  it('关闭 CSR 后在 Level 3 原样返回插件骨架', async () => {
    const manager = new DegradationManager();
    const context = createMockRenderContext();
    const pluginSkeleton = '<div data-test="plugin-skeleton">loading</div>';
    const render = vi.fn(async () => {
      context.extra.__skeleton_fallback = pluginSkeleton;
      throw new Error('render failed');
    });

    const result = await manager.executeWithDegradation(
      render,
      context,
      fallbackConfig({ ssrToCSR: false }),
    );

    expect(result.level).toBe(DegradationLevel.Skeleton);
    expect(result.result.html).toBe(pluginSkeleton);
    expect(result.result.headers['X-Nami-Degraded']).toBe('skeleton');
    expect(result.result.headers['X-Nami-Render-Mode']).toBe('skeleton-fallback');
    expect(result.result.headers['Cache-Control']).toContain('no-store');
    expect(context.extra.__skeleton_fallback_used).toBe(true);
  });

  it('插件未提供内容时使用路由骨架，并在更后级返回静态页或 503', async () => {
    const manager = new DegradationManager();
    const render = vi.fn().mockRejectedValue(new Error('render failed'));
    const skeletonContext = createMockRenderContext({
      route: createMockRoute({ skeleton: './Skeleton' }),
    });

    const skeleton = await manager.executeWithDegradation(
      render,
      skeletonContext,
      fallbackConfig({ ssrToCSR: false }),
    );
    expect(skeleton.level).toBe(DegradationLevel.Skeleton);
    expect(skeleton.result.html).toContain('nami-skeleton');
    expect(skeleton.result.headers['Cache-Control']).toContain('no-store');

    const staticResult = await manager.executeWithDegradation(
      render,
      createMockRenderContext(),
      fallbackConfig({ ssrToCSR: false, staticHTML: '<html>static fallback</html>' }),
    );
    expect(staticResult.level).toBe(DegradationLevel.StaticHTML);
    expect(staticResult.result.headers['Cache-Control']).toContain('no-store');

    const unavailable = await manager.executeWithDegradation(
      render,
      createMockRenderContext(),
      fallbackConfig({ ssrToCSR: false }),
    );
    expect(unavailable.level).toBe(DegradationLevel.ServiceUnavailable);
    expect(unavailable.result.statusCode).toBe(503);
    expect(unavailable.result.headers['Cache-Control']).toContain('no-store');
  });

  it('maxRetries 表示首次失败后的精确重试次数', async () => {
    const manager = new DegradationManager();
    const render = vi.fn().mockRejectedValue(new Error('always fails'));

    const result = await manager.executeWithDegradation(
      render,
      createMockRenderContext(),
      fallbackConfig({ maxRetries: 2, ssrToCSR: false }),
    );

    expect(render).toHaveBeenCalledTimes(3);
    expect(result.errors).toHaveLength(3);
    expect(result.level).toBe(DegradationLevel.ServiceUnavailable);
  });
});
