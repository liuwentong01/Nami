/** 构建阶段自动生成的浏览器路由模块映射。 */
export interface GeneratedRouteDefinition {
  path: string;
  component: string;
  exact?: boolean;
}

export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "../src/pages/home"),
  "./pages/posts": () => import(/* webpackChunkName: "route-pages-posts" */ "../src/pages/posts"),
  "./pages/post-detail": () => import(/* webpackChunkName: "route-pages-post-detail" */ "../src/pages/post-detail"),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [
  { path: "/", component: "./pages/home", exact: true },
  { path: "/posts", component: "./pages/posts", exact: true },
  { path: "/posts/:id", component: "./pages/post-detail", exact: true },
];
