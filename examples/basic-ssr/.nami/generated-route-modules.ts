/**
 * 构建阶段自动生成的路由模块映射。
 *
 * 这里使用静态 import 工厂而不是表达式 import，
 * 避免 webpack 对 `import(`${componentPath}`)` 发出 Critical dependency 警告。
 */
export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "../src/pages/home"),
  "./pages/posts": () => import(/* webpackChunkName: "route-pages-posts" */ "../src/pages/posts"),
  "./pages/post-detail": () => import(/* webpackChunkName: "route-pages-post-detail" */ "../src/pages/post-detail"),
} as Record<string, () => Promise<unknown>>;
