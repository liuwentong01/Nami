import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DegradationLevel, RenderMode } from '@nami/shared';
import { renderMiddleware } from '../render-middleware';
import type { RenderMiddlewareOptions } from '../render-middleware';

// Mock @nami/core 模块
vi.mock('@nami/core', () => {
  const mockRender = vi.fn().mockResolvedValue({
    html: '<html><body>渲染结果</body></html>',
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Nami-Render-Mode': 'csr',
      'X-Nami-Render-Duration': '10',
    },
    meta: {
      renderMode: 'csr',
      duration: 10,
      degraded: false,
      dataFetchDuration: 0,
    },
  });

  return {
    RendererFactory: {
      create: vi.fn(() => ({
        render: mockRender,
        getMode: () => 'csr',
        createFallbackRenderer: () => null,
      })),
    },
    PluginManager: vi.fn(),
    DegradationManager: vi.fn(),
    rankRoutes: vi.fn((routes) => routes),
    matchPath: vi.fn((pattern, pathname, options) => {
      if (options?.exact === false) {
        return pathname.startsWith(pattern) ? { params: {} } : null;
      }

      return pattern === pathname ? { params: {} } : null;
    }),
  };
});

/**
 * 创建 Mock Koa.Context
 */
function createMockKoaContext(overrides?: Record<string, unknown>) {
  return {
    method: 'GET',
    path: '/',
    url: '/',
    query: {},
    headers: {},
    querystring: '',
    protocol: 'http',
    ip: '127.0.0.1',
    origin: 'http://localhost:3000',
    hostname: 'localhost',
    secure: false,
    status: 200,
    body: undefined as unknown,
    state: { requestId: 'test-req-001' },
    get: vi.fn().mockReturnValue(''),
    set: vi.fn(),
    ...overrides,
  } as unknown as import('koa').Context;
}

function createMockMiddlewareOptions(
  overrides?: Partial<RenderMiddlewareOptions>,
): RenderMiddlewareOptions {
  return {
    config: {
      appName: 'test-app',
      srcDir: 'src',
      outDir: 'dist',
      defaultRenderMode: RenderMode.CSR,
      routes: [
        { path: '/', component: './pages/home', renderMode: RenderMode.CSR },
        { path: '/about', component: './pages/about', renderMode: RenderMode.CSR },
      ],
      server: {
        port: 3000,
        host: '0.0.0.0',
        ssrTimeout: 5000,
        gracefulShutdown: true,
        gracefulShutdownTimeout: 30000,
      },
      webpack: {},
      isr: {
        enabled: false,
        cacheDir: '.nami-cache/isr',
        defaultRevalidate: 60,
        cacheAdapter: 'memory',
      },
      assets: { publicPath: '/', hash: true },
      monitor: { enabled: false, sampleRate: 1 },
      fallback: { ssrToCSR: true, timeout: 5000, maxRetries: 0 },
      plugins: [],
    } as any,
    pluginManager: {
      runParallelHook: vi.fn().mockResolvedValue(undefined),
      runWaterfallHook: vi.fn((_, initial) => Promise.resolve(initial)),
    } as any,
    degradationManager: {
      executeWithDegradation: vi.fn(async (renderFn, context) => ({
        result: await renderFn(context),
        level: 0,
        errors: [],
      })),
    } as any,
    ...overrides,
  };
}

describe('renderMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('路由匹配成功时返回渲染 HTML', async () => {
    const options = createMockMiddlewareOptions();
    const middleware = renderMiddleware(options);
    const ctx = createMockKoaContext({ path: '/', url: '/' });
    const next = vi.fn();

    await middleware(ctx, next);

    expect(ctx.body).toContain('渲染结果');
    expect(ctx.status).toBe(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('非 GET 请求直接调用 next()', async () => {
    const options = createMockMiddlewareOptions();
    const middleware = renderMiddleware(options);
    const ctx = createMockKoaContext({ method: 'POST', path: '/' });
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.body).toBeUndefined();
  });

  it('HEAD 请求也会被处理', async () => {
    const options = createMockMiddlewareOptions();
    const middleware = renderMiddleware(options);
    const ctx = createMockKoaContext({ method: 'HEAD', path: '/', url: '/' });
    const next = vi.fn();

    await middleware(ctx, next);

    // HEAD 请求应该被渲染中间件处理（不调用 next）
    expect(next).not.toHaveBeenCalled();
  });

  it('未匹配路由时调用 next()', async () => {
    const options = createMockMiddlewareOptions();
    const middleware = renderMiddleware(options);
    const ctx = createMockKoaContext({ path: '/unknown', url: '/unknown' });
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalled();
  });

  it('使用自定义路由匹配函数', async () => {
    const customMatchRoute = vi.fn().mockReturnValue({
      route: {
        path: '/custom',
        component: './pages/custom',
        renderMode: RenderMode.CSR,
      },
      params: {},
      isExact: true,
    });

    const options = createMockMiddlewareOptions({
      matchRoute: customMatchRoute,
    });
    const middleware = renderMiddleware(options);
    const ctx = createMockKoaContext({ path: '/custom', url: '/custom' });
    const next = vi.fn();

    await middleware(ctx, next);

    expect(customMatchRoute).toHaveBeenCalledWith(
      '/custom',
      expect.any(Array),
    );
  });

  it('渲染完成后设置正确的响应头', async () => {
    const options = createMockMiddlewareOptions();
    const middleware = renderMiddleware(options);
    const ctx = createMockKoaContext({ path: '/', url: '/' });
    const next = vi.fn();

    await middleware(ctx, next);

    // set 应该被调用来设置 Content-Type 和 X-Nami 头
    expect(ctx.set).toHaveBeenCalled();
  });

  it('Level 2-5 降级结果标记为不可缓存并统一写入响应', async () => {
    const degradedResult = {
      html: '<div>skeleton</div>',
      statusCode: 200,
      headers: {
        'X-Nami-Degraded': 'skeleton',
        'Cache-Control': 'private, no-store, max-age=0',
      },
      meta: {
        renderMode: RenderMode.CSR,
        duration: 1,
        degraded: true,
        dataFetchDuration: 0,
      },
    };
    const options = createMockMiddlewareOptions({
      degradationManager: {
        executeWithDegradation: vi.fn().mockResolvedValue({
          result: degradedResult,
          level: DegradationLevel.Skeleton,
          errors: [new Error('render failed')],
        }),
      } as any,
    });
    const middleware = renderMiddleware(options);
    const ctx = createMockKoaContext({ path: '/', url: '/' });

    await middleware(ctx, vi.fn());

    expect(ctx.body).toBe(degradedResult.html);
    expect(ctx.state.namiCacheable).toBe(false);
    expect(ctx.state.namiDegradationLevel).toBe(DegradationLevel.Skeleton);
    expect(ctx.state.namiRenderResult).toBe(degradedResult);
  });

  it('重试成功可缓存，但 Level 0 的数据降级结果不可缓存', async () => {
    const retryResult = {
      html: '<html>retry success</html>',
      statusCode: 200,
      headers: {},
      meta: {
        renderMode: RenderMode.SSR,
        duration: 1,
        degraded: true,
        dataFetchDuration: 0,
      },
    };
    const retryOptions = createMockMiddlewareOptions({
      degradationManager: {
        executeWithDegradation: vi.fn().mockResolvedValue({
          result: retryResult,
          level: DegradationLevel.Retry,
          errors: [new Error('first attempt failed')],
        }),
      } as any,
    });
    const retryContext = createMockKoaContext({ path: '/', url: '/' });

    await renderMiddleware(retryOptions)(retryContext, vi.fn());
    expect(retryContext.state.namiCacheable).toBe(true);

    const dataDegradedOptions = createMockMiddlewareOptions({
      degradationManager: {
        executeWithDegradation: vi.fn().mockResolvedValue({
          result: retryResult,
          level: DegradationLevel.None,
          errors: [],
        }),
      } as any,
    });
    const dataDegradedContext = createMockKoaContext({ path: '/', url: '/' });

    await renderMiddleware(dataDegradedOptions)(dataDegradedContext, vi.fn());
    expect(dataDegradedContext.state.namiCacheable).toBe(false);
  });
});
