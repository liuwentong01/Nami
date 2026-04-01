import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RenderMode } from '@nami/shared';
import { SSRRenderer } from '../ssr-renderer';
import { CSRRenderer } from '../csr-renderer';
import {
  createMockConfig,
  createMockRenderContext,
  createMockRoute,
} from '../../__tests__/mocks';

// Mock react-dom/server
vi.mock('react-dom/server', () => ({
  renderToString: vi.fn(() => '<div>SSR 渲染内容</div>'),
}));

describe('SSRRenderer', () => {
  const config = createMockConfig({
    defaultRenderMode: RenderMode.SSR,
    server: {
      port: 3000,
      host: '0.0.0.0',
      ssrTimeout: 5000,
      gracefulShutdown: true,
      gracefulShutdownTimeout: 30000,
    },
  });

  const mockAppElementFactory = vi.fn(() => 'mock-react-element');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getMode() 返回 SSR', () => {
    const renderer = new SSRRenderer({
      config,
      appElementFactory: mockAppElementFactory,
    });
    expect(renderer.getMode()).toBe(RenderMode.SSR);
  });

  it('render() 生成包含渲染内容的 HTML', async () => {
    const renderer = new SSRRenderer({
      config,
      appElementFactory: mockAppElementFactory,
    });
    const context = createMockRenderContext({
      route: createMockRoute({ renderMode: RenderMode.SSR }),
    });

    const result = await renderer.render(context);

    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('<div>SSR 渲染内容</div>');
    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('<meta name="renderer" content="ssr">');
    expect(result.html).toContain('nami-root');
    expect(result.meta.renderMode).toBe(RenderMode.SSR);
  });

  it('render() 调用 appElementFactory 并传入渲染上下文', async () => {
    const renderer = new SSRRenderer({
      config,
      appElementFactory: mockAppElementFactory,
    });
    const context = createMockRenderContext({
      route: createMockRoute({ renderMode: RenderMode.SSR }),
    });

    await renderer.render(context);

    expect(mockAppElementFactory).toHaveBeenCalledWith(context);
  });

  it('createFallbackRenderer() 返回 CSRRenderer 实例', () => {
    const renderer = new SSRRenderer({
      config,
      appElementFactory: mockAppElementFactory,
    });
    const fallback = renderer.createFallbackRenderer();

    expect(fallback).toBeInstanceOf(CSRRenderer);
    expect(fallback!.getMode()).toBe(RenderMode.CSR);
  });

  it('prefetchData() 路由未配置 getServerSideProps 时返回空数据', async () => {
    const renderer = new SSRRenderer({
      config,
      appElementFactory: mockAppElementFactory,
    });
    const context = createMockRenderContext({
      route: createMockRoute({ renderMode: RenderMode.SSR }),
    });

    const result = await renderer.prefetchData(context);

    expect(result.data).toEqual({});
    expect(result.errors).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it('render() 超时后抛出错误', async () => {
    const slowConfig = createMockConfig({
      server: {
        port: 3000,
        host: '0.0.0.0',
        ssrTimeout: 1, // 1ms 超时，必定超时
        gracefulShutdown: true,
        gracefulShutdownTimeout: 30000,
      },
    });

    // 创建一个会永远 pending 的工厂函数
    const { renderToString } = await import('react-dom/server');
    (renderToString as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return new Promise(() => {
        // 永不 resolve
      });
    });

    const renderer = new SSRRenderer({
      config: slowConfig,
      appElementFactory: () => {
        // 返回一个 "element"，但 renderToString 会 hang
        return 'slow-element';
      },
    });

    const context = createMockRenderContext({
      route: createMockRoute({ renderMode: RenderMode.SSR }),
    });

    await expect(renderer.render(context)).rejects.toThrow();

    // 恢复 mock
    (renderToString as ReturnType<typeof vi.fn>).mockImplementation(
      () => '<div>SSR 渲染内容</div>',
    );
  });

  it('render() 触发插件钩子', async () => {
    const callHook = vi.fn().mockResolvedValue(undefined);
    const pluginManager = { callHook };

    const renderer = new SSRRenderer({
      config,
      pluginManager,
      appElementFactory: mockAppElementFactory,
    });
    const context = createMockRenderContext({
      route: createMockRoute({ renderMode: RenderMode.SSR }),
    });

    await renderer.render(context);

    expect(callHook).toHaveBeenCalledWith('beforeRender', context);
    expect(callHook).toHaveBeenCalledWith(
      'afterRender',
      context,
      expect.objectContaining({ html: expect.any(String) }),
    );
  });
});
