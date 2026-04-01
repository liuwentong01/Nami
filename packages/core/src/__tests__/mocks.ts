/**
 * 测试用 Mock 对象
 *
 * 提供测试中常用的 NamiConfig、RenderContext 等 Mock 工厂函数。
 */

import { RenderMode } from '@nami/shared';
import type {
  NamiConfig,
  NamiRoute,
  RenderContext,
  ServerConfig,
  ISRConfig,
  MonitorConfig,
  FallbackConfig,
  AssetsConfig,
  WebpackCustomConfig,
} from '@nami/shared';

/**
 * 创建 Mock NamiConfig
 */
export function createMockConfig(overrides?: Partial<NamiConfig>): NamiConfig {
  const defaults: NamiConfig = {
    appName: 'test-app',
    srcDir: 'src',
    outDir: 'dist',
    defaultRenderMode: RenderMode.CSR,
    routes: [
      {
        path: '/',
        component: './pages/home',
        renderMode: RenderMode.CSR,
      },
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
    assets: {
      publicPath: '/',
      hash: true,
    },
    monitor: {
      enabled: false,
      sampleRate: 1,
    },
    fallback: {
      ssrToCSR: true,
      timeout: 5000,
      maxRetries: 0,
    },
    plugins: [],
  };

  return { ...defaults, ...overrides };
}

/**
 * 创建 Mock NamiRoute
 */
export function createMockRoute(overrides?: Partial<NamiRoute>): NamiRoute {
  return {
    path: '/',
    component: './pages/home',
    renderMode: RenderMode.CSR,
    ...overrides,
  };
}

/**
 * 创建 Mock RenderContext
 */
export function createMockRenderContext(
  overrides?: Partial<RenderContext>,
): RenderContext {
  return {
    url: 'http://localhost:3000/',
    path: '/',
    query: {},
    headers: {},
    route: createMockRoute(),
    params: {},
    timing: { startTime: Date.now() },
    requestId: 'test-req-001',
    extra: {},
    ...overrides,
  };
}
