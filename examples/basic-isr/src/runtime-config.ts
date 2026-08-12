import pluginCache from '@nami/plugin-cache';
import pluginMonitor from '@nami/plugin-monitor';
import { RenderMode, type UserNamiConfig } from '@nami/shared';
import appShellPlugin from './app-shell-plugin';

/**
 * 浏览器与 CLI/服务端共用的纯运行时配置。
 *
 * 这里不导入 `@nami/core`，避免客户端 Bundle 沿根入口带入服务端 Renderer、
 * ConfigLoader 和 Node.js 模块。每次调用都创建独立插件实例，避免跨运行时共享状态。
 */
export function createRuntimeConfig(): UserNamiConfig {
  return {
    appName: 'nami-isr-demo',
    defaultRenderMode: RenderMode.ISR,

    routes: [
      {
        path: '/',
        component: './pages/home',
        renderMode: RenderMode.ISR,
        getStaticProps: 'getStaticProps',
        /** 首页每 60 秒重验证一次 */
        revalidate: 60,
      },
      {
        path: '/products',
        component: './pages/products',
        renderMode: RenderMode.ISR,
        getStaticProps: 'getStaticProps',
        /** 商品列表每 30 秒重验证一次（更新较频繁） */
        revalidate: 30,
      },
      {
        path: '/products/:id',
        component: './pages/product-detail',
        renderMode: RenderMode.ISR,
        getStaticProps: 'getStaticProps',
        getStaticPaths: 'getStaticPaths',
        /** 商品详情每 30 秒重验证一次 */
        revalidate: 30,
        /** 未预渲染的商品页面使用阻塞式渲染（等待渲染完成后返回） */
        fallback: 'blocking',
      },
    ],

    server: {
      port: 3004,
    },

    /** ISR 全局配置 */
    isr: {
      enabled: true,
      /** ISR 缓存存储策略 */
      cacheAdapter: 'memory',
      cacheDir: '.nami-cache/isr',
      defaultRevalidate: 60,
    },

    plugins: [
      pluginCache({
        strategy: 'lru',
        maxSize: 500,
        /** ISR 缓存的默认过期时间 */
        maxAge: 60,
      }),
      pluginMonitor({
        /** 开启性能监控，追踪 ISR 重验证的耗时和频率 */
        enabled: true,
        sampleRate: 1.0,
        reportUrl: '/api/monitor/report',
      }),
      appShellPlugin,
    ],
  };
}
