import { describe, it, expect, vi } from 'vitest';
import { RenderMode } from '@nami/shared';
import { CSRRenderer } from '../csr-renderer';
import {
  createMockConfig,
  createMockRenderContext,
} from '../../__tests__/mocks';

describe('CSRRenderer', () => {
  const config = createMockConfig();

  it('getMode() 返回 CSR', () => {
    const renderer = new CSRRenderer({ config });
    expect(renderer.getMode()).toBe(RenderMode.CSR);
  });

  it('render() 返回包含正确容器 ID 的 HTML 空壳', async () => {
    const renderer = new CSRRenderer({ config });
    const context = createMockRenderContext();

    const result = await renderer.render(context);

    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('<div id="nami-root"></div>');
    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('<meta name="renderer" content="csr">');
    expect(result.meta.renderMode).toBe(RenderMode.CSR);
  });

  it('render() 返回的 HTML 包含 JS 和 CSS 资源引用', async () => {
    const renderer = new CSRRenderer({ config });
    const context = createMockRenderContext();

    const result = await renderer.render(context);

    expect(result.html).toContain('static/css/main.css');
    expect(result.html).toContain('static/js/main.js');
    expect(result.html).toContain('<script defer');
  });

  it('render() 使用路由 meta 中的 title', async () => {
    const renderer = new CSRRenderer({ config });
    const context = createMockRenderContext({
      route: {
        path: '/',
        component: './pages/home',
        renderMode: RenderMode.CSR,
        meta: { title: '自定义标题' },
      },
    });

    const result = await renderer.render(context);
    expect(result.html).toContain('<title>自定义标题</title>');
  });

  it('prefetchData() 返回空数据', async () => {
    const renderer = new CSRRenderer({ config });
    const context = createMockRenderContext();

    const result = await renderer.prefetchData(context);

    expect(result.data).toEqual({});
    expect(result.errors).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.duration).toBe(0);
  });

  it('createFallbackRenderer() 返回 null（CSR 是降级链终点）', () => {
    const renderer = new CSRRenderer({ config });
    expect(renderer.createFallbackRenderer()).toBeNull();
  });

  it('render() 触发插件钩子', async () => {
    const callHook = vi.fn().mockResolvedValue(undefined);
    const pluginManager = { callHook };

    const renderer = new CSRRenderer({ config, pluginManager });
    const context = createMockRenderContext();

    await renderer.render(context);

    expect(callHook).toHaveBeenCalledWith('beforeRender', context);
    expect(callHook).toHaveBeenCalledWith(
      'afterRender',
      context,
      expect.objectContaining({ html: expect.any(String) }),
    );
  });

  it('自定义 publicPath 被正确应用', async () => {
    const customConfig = createMockConfig({
      assets: { publicPath: 'https://cdn.example.com/', hash: true },
    });
    const renderer = new CSRRenderer({ config: customConfig });
    const context = createMockRenderContext();

    const result = await renderer.render(context);

    expect(result.html).toContain('https://cdn.example.com/static/css/main.css');
    expect(result.html).toContain('https://cdn.example.com/static/js/main.js');
  });
});
