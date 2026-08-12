import pluginRequest from '@nami/plugin-request';
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
      appShellPlugin,
    ],
  };
}
