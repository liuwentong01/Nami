/**
 * Nami 框架配置文件 — CSR（客户端渲染）模式
 *
 * CSR 模式说明：
 * - 服务端返回一个空壳 HTML（仅包含 <div id="nami-root"></div>）
 * - 浏览器下载 JS 后，由 React 在客户端执行完整的渲染
 * - 首屏需等待 JS 下载和执行完成，适合对 SEO 无要求的后台管理类系统
 * - 优点：部署简单、服务端压力小、交互响应快
 * - 缺点：首屏白屏时间较长、不利于 SEO
 *
 * @see https://nami.dev/docs/config
 */
import { defineConfig, RenderMode } from '@nami/core';
import pluginRequest from '@nami/plugin-request';

export default defineConfig({
  appName: 'nami-csr-demo',
  defaultRenderMode: RenderMode.CSR,

  routes: [
    {
      path: '/',
      component: './pages/home',
      renderMode: RenderMode.CSR,
    },
    {
      path: '/about',
      component: './pages/about',
      renderMode: RenderMode.CSR,
    },
  ],

  server: {
    port: 3001,
  },

  plugins: [
    pluginRequest({
      baseURL: '/api',
      timeout: 10000,
    }),
  ],
});
