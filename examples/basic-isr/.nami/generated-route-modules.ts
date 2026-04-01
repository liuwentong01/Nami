/**
 * 构建阶段自动生成的路由模块映射。
 *
 * 这里使用静态 import 工厂而不是表达式 import，
 * 避免 webpack 对 `import(`${componentPath}`)` 发出 Critical dependency 警告。
 */
export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "../src/pages/home"),
  "./pages/products": () => import(/* webpackChunkName: "route-pages-products" */ "../src/pages/products"),
  "./pages/product-detail": () => import(/* webpackChunkName: "route-pages-product-detail" */ "../src/pages/product-detail"),
} as Record<string, () => Promise<unknown>>;
