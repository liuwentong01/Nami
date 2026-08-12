import type { NamiConfig, NamiPlugin } from '@nami/shared';
import {
  DEFAULT_ASSETS_CONFIG,
  DEFAULT_FALLBACK_CONFIG,
  DEFAULT_ISR_CONFIG,
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_SERVER_CONFIG,
  RenderMode,
} from '@nami/shared';
import { routes } from './routes';

/**
 * 创建浏览器与服务端都可安全读取的完整配置。
 *
 * `defineConfig()` 接收的是顶层 Partial，CLI 会在加载时深度合并默认值；
 * 客户端入口没有这一步，所以综合示例显式构造完整的 NamiConfig。
 */
export function createRuntimeConfig(plugins: NamiPlugin[] = []): NamiConfig {
  return {
    appName: 'nami-feature-showcase',
    srcDir: 'src',
    outDir: 'dist',
    defaultRenderMode: RenderMode.SSR,
    routes,
    server: {
      ...DEFAULT_SERVER_CONFIG,
      port: 3100,
      ssrTimeout: 6000,
      gracefulShutdownTimeout: 10000,
    },
    webpack: {
      client(config) {
        return {
          ...config,
          module: {
            ...config.module,
            rules: [
              ...(config.module?.rules ?? []),
              {
                resourceQuery: /service-worker/,
                type: 'asset/resource',
                generator: {
                  filename: 'sw.js',
                },
              },
            ],
          },
        };
      },
      server(config) {
        return {
          ...config,
          stats: 'errors-warnings',
        };
      },
    },
    isr: {
      ...DEFAULT_ISR_CONFIG,
      enabled: true,
      cacheAdapter: 'memory',
      cacheDir: '.nami-cache/isr-showcase',
      defaultRevalidate: 8,
    },
    assets: {
      ...DEFAULT_ASSETS_CONFIG,
      publicPath: '/',
      hash: true,
    },
    monitor: {
      ...DEFAULT_MONITOR_CONFIG,
      enabled: true,
      sampleRate: 1,
      reportUrl: '/api/monitor/report',
      webVitals: true,
      renderMetrics: true,
    },
    fallback: {
      ...DEFAULT_FALLBACK_CONFIG,
      ssrToCSR: true,
      timeout: 6000,
      maxRetries: 1,
      staticHTML:
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nami 暂时不可用</title></head><body><main role="alert"><h1>Nami 暂时不可用</h1><p>请稍后刷新。</p><a href="">重新加载</a></main></body></html>',
    },
    plugins,
    title: 'Nami Feature Showcase',
    description: 'Nami 混合渲染、数据、缓存、插件与客户端运行时综合示例。',
    env: {
      NAMI_PUBLIC_SHOWCASE_VERSION: '2026.08',
    },
  };
}
