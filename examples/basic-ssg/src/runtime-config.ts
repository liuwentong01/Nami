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
    appName: 'nami-ssg-demo',
    defaultRenderMode: RenderMode.SSG,

    routes: [
      {
        path: '/',
        component: './pages/home',
        renderMode: RenderMode.SSG,
        getStaticProps: 'getStaticProps',
      },
      {
        path: '/blog',
        component: './pages/blog',
        renderMode: RenderMode.SSG,
        getStaticProps: 'getStaticProps',
      },
      {
        path: '/blog/:slug',
        component: './pages/blog-post',
        renderMode: RenderMode.SSG,
        getStaticProps: 'getStaticProps',
        getStaticPaths: 'getStaticPaths',
      },
    ],

    server: {
      port: 3003,
    },

    plugins: [appShellPlugin],
  };
}
