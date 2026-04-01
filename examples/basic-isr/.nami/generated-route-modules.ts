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
  "./pages/products": () => import(/* webpackChunkName: "route-pages-products" */ "../src/pages/products"),
  "./pages/product-detail": () => import(/* webpackChunkName: "route-pages-product-detail" */ "../src/pages/product-detail"),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [
  { path: "/", component: "./pages/home", exact: true },
  { path: "/products", component: "./pages/products", exact: true },
  { path: "/products/:id", component: "./pages/product-detail", exact: true },
];
