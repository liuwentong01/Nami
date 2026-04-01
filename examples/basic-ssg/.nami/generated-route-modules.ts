/**
 * 构建阶段自动生成的路由模块映射。
 *
 * 这里使用静态 import 工厂而不是表达式 import，
 * 避免 webpack 对 `import(`${componentPath}`)` 发出 Critical dependency 警告。
 */
export interface GeneratedRouteDefinition {
  path: string;
  component: string;
  exact?: boolean;
}

export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "../src/pages/home"),
  "./pages/blog": () => import(/* webpackChunkName: "route-pages-blog" */ "../src/pages/blog"),
  "./pages/blog-post": () => import(/* webpackChunkName: "route-pages-blog-post" */ "../src/pages/blog-post"),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [
  { path: "/", component: "./pages/home", exact: true },
  { path: "/blog", component: "./pages/blog", exact: true },
  { path: "/blog/:slug", component: "./pages/blog-post", exact: true },
];
