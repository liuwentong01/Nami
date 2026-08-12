/** 构建阶段自动生成的浏览器路由模块映射。 */
export interface GeneratedRouteDefinition {
  path: string;
  component: string;
  exact?: boolean;
}

export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "../src/pages/home"),
  "./pages/csr-playground": () => import(/* webpackChunkName: "route-pages-csr-playground" */ "../src/pages/csr-playground"),
  "./pages/ssr-request": () => import(/* webpackChunkName: "route-pages-ssr-request" */ "../src/pages/ssr-request"),
  "./pages/streaming": () => import(/* webpackChunkName: "route-pages-streaming" */ "../src/pages/streaming"),
  "./pages/content-index": () => import(/* webpackChunkName: "route-pages-content-index" */ "../src/pages/content-index"),
  "./pages/content-article": () => import(/* webpackChunkName: "route-pages-content-article" */ "../src/pages/content-article"),
  "./pages/isr-products": () => import(/* webpackChunkName: "route-pages-isr-products" */ "../src/pages/isr-products"),
  "./pages/isr-product": () => import(/* webpackChunkName: "route-pages-isr-product" */ "../src/pages/isr-product"),
  "./pages/routing-dynamic": () => import(/* webpackChunkName: "route-pages-routing-dynamic" */ "../src/pages/routing-dynamic"),
  "./pages/routing-static": () => import(/* webpackChunkName: "route-pages-routing-static" */ "../src/pages/routing-static"),
  "./pages/client-runtime": () => import(/* webpackChunkName: "route-pages-client-runtime" */ "../src/pages/client-runtime"),
  "./pages/plugins": () => import(/* webpackChunkName: "route-pages-plugins" */ "../src/pages/plugins"),
  "./pages/stability": () => import(/* webpackChunkName: "route-pages-stability" */ "../src/pages/stability"),
  "./pages/redirect": () => import(/* webpackChunkName: "route-pages-redirect" */ "../src/pages/redirect"),
  "./pages/data-not-found": () => import(/* webpackChunkName: "route-pages-data-not-found" */ "../src/pages/data-not-found"),
  "./pages/not-found": () => import(/* webpackChunkName: "route-pages-not-found" */ "../src/pages/not-found"),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [
  { path: "/", component: "./pages/home", exact: true },
  { path: "/rendering/csr", component: "./pages/csr-playground", exact: true },
  { path: "/rendering/ssr/:name", component: "./pages/ssr-request", exact: true },
  { path: "/rendering/streaming", component: "./pages/streaming", exact: true },
  { path: "/content", component: "./pages/content-index", exact: true },
  { path: "/content/:slug", component: "./pages/content-article", exact: true },
  { path: "/products", component: "./pages/isr-products", exact: true },
  { path: "/products/:id", component: "./pages/isr-product", exact: true },
  { path: "/routing/:id", component: "./pages/routing-dynamic", exact: true },
  { path: "/routing/new", component: "./pages/routing-static", exact: true },
  { path: "/client/runtime", component: "./pages/client-runtime", exact: true },
  { path: "/plugins", component: "./pages/plugins", exact: true },
  { path: "/stability", component: "./pages/stability", exact: true },
  { path: "/redirect", component: "./pages/redirect", exact: true },
  { path: "/data-not-found", component: "./pages/data-not-found", exact: true },
  { path: "/*", component: "./pages/not-found", exact: true },
];
