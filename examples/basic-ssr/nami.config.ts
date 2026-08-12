/**
 * Nami 框架配置文件 — SSR（服务端渲染）模式
 *
 * SSR 模式说明：
 * - 每次请求到达服务端时，Koa 中间件调用 React 的 renderToString 生成完整 HTML
 * - 浏览器收到已包含页面内容的 HTML，首屏可立即展示
 * - 客户端 JS 加载后执行 Hydration，为已有 DOM 附加事件监听器
 * - 优点：首屏速度快、对 SEO 友好、可访问性好
 * - 缺点：服务端压力较大、TTFB 受服务端渲染耗时影响
 *
 * 每个路由可配置 getServerSideProps 函数，
 * 该函数在每次请求时在服务端执行，获取页面所需数据。
 *
 * @see https://nami.dev/docs/config
 */
import { defineConfig } from '@nami/core';
import { createRuntimeConfig } from './src/runtime-config';

/** CLI/构建端入口；浏览器只读取 client-safe 的 runtime-config。 */
export default defineConfig(createRuntimeConfig());
