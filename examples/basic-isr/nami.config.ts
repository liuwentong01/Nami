/**
 * Nami 框架配置文件 — ISR（增量静态再生）模式
 *
 * ISR 模式说明：
 * - 基于 SSG 的基础上增加了"按需重验证"能力
 * - 首次构建时预渲染页面为静态 HTML（同 SSG）
 * - 每个页面可配置 revalidate 间隔（秒），过期后：
 *   1. 当前请求仍返回旧的缓存页面（stale）
 *   2. 后台异步触发重新渲染（revalidate）
 *   3. 新页面生成后替换缓存，后续请求获取新内容
 * - 这就是 "stale-while-revalidate" 策略
 *
 * 优点：
 * - 兼具 SSG 的极速响应和 SSR 的内容时效性
 * - 无需全量重建即可更新单个页面
 * - 服务端压力远低于 SSR（大部分请求命中缓存）
 *
 * 缺点：
 * - 需要 Node.js 服务端运行时（不能纯静态部署）
 * - 过期窗口期内用户可能看到旧内容
 *
 * 适用场景：电商商品页、新闻资讯、内容平台等需要兼顾性能和时效性的场景。
 *
 * @see https://nami.dev/docs/config
 */
import { defineConfig, RenderMode } from '@nami/core';
import pluginCache from '@nami/plugin-cache';
import pluginMonitor from '@nami/plugin-monitor';

export default defineConfig({
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
    /** ISR 缓存存储策略 */
    cacheStrategy: 'memory',
    /** 最大缓存条目数 */
    maxCacheSize: 1000,
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
  ],
});
