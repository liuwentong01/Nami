/** 构建阶段自动生成的浏览器路由模块映射。 */
export interface GeneratedRouteDefinition {
  path: string;
  component: string;
  exact?: boolean;
}

export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "../src/pages/home"),
  "./pages/products": () => import(/* webpackChunkName: "route-pages-products" */ "../src/pages/products"),
  "./pages/product-detail": () => import(/* webpackChunkName: "route-pages-product-detail" */ "../src/pages/product-detail"),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [
  { path: "/", component: "./pages/home", exact: true },
  { path: "/products", component: "./pages/products", exact: true },
  { path: "/products/:id", component: "./pages/product-detail", exact: true },
];
