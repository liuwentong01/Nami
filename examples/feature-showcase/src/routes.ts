import { RenderMode, type NamiRoute } from '@nami/shared';

/**
 * 同一张路由表同时驱动 Webpack 任务划分、Koa 路由匹配和浏览器 Router。
 *
 * `/routing/:id` 故意注册在 `/routing/new` 之前，用来验证 Nami 的路由
 * 排序仍会让静态路由优先于动态参数路由。
 */
export const routes: NamiRoute[] = [
  {
    path: '/',
    component: './pages/home',
    renderMode: RenderMode.SSG,
    getStaticProps: 'getStaticProps',
    meta: {
      title: 'Nami Feature Showcase',
      description: '在一个应用中观察 Nami 的混合渲染、数据、缓存、插件和客户端运行时。',
    },
  },
  {
    path: '/rendering/csr',
    component: './pages/csr-playground',
    renderMode: RenderMode.CSR,
    meta: {
      title: 'CSR Playground · Nami Showcase',
      description: '客户端渲染、交互状态与浏览器数据请求。',
    },
  },
  {
    path: '/rendering/ssr/:name',
    component: './pages/ssr-request',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
    meta: {
      title: 'SSR Request Context · Nami Showcase',
      description: '观察 params、query、cookie、requestId、自定义响应头和服务端注水。',
    },
  },
  {
    path: '/rendering/streaming',
    component: './pages/streaming',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
    meta: {
      title: 'Streaming SSR · Nami Showcase',
      description: '使用 renderToPipeableStream、Suspense 和 Shell 优先输出。',
      streaming: true,
      skeletonLayout: 'dashboard',
    },
  },
  {
    path: '/content',
    component: './pages/content-index',
    renderMode: RenderMode.SSG,
    getStaticProps: 'getStaticProps',
    meta: {
      title: 'SSG Content · Nami Showcase',
      description: '构建期静态内容与 Hydration。',
    },
  },
  {
    path: '/content/:slug',
    component: './pages/content-article',
    renderMode: RenderMode.SSG,
    getStaticProps: 'getStaticProps',
    getStaticPaths: 'getStaticPaths',
    fallback: false,
    meta: {
      title: 'Static Article · Nami Showcase',
      description: 'getStaticPaths 与动态 SSG 路由。',
    },
  },
  {
    path: '/products',
    component: './pages/isr-products',
    renderMode: RenderMode.ISR,
    getStaticProps: 'getStaticProps',
    revalidate: 8,
    meta: {
      title: 'ISR Products · Nami Showcase',
      description: '观察 MISS、HIT、STALE 和后台重建。',
      cacheTags: ['catalog'],
      skeletonLayout: 'list',
    },
  },
  {
    path: '/products/:id',
    component: './pages/isr-product',
    renderMode: RenderMode.ISR,
    getStaticProps: 'getStaticProps',
    getStaticPaths: 'getStaticPaths',
    revalidate: 8,
    fallback: 'blocking',
    meta: {
      title: 'ISR Product Detail · Nami Showcase',
      description: '动态 ISR、首次 MISS 同步生成与缓存标签。',
      cacheTags: ['catalog', 'product'],
      skeletonLayout: 'detail',
    },
  },
  {
    path: '/routing/:id',
    component: './pages/routing-dynamic',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
    meta: {
      title: 'Dynamic Route · Nami Showcase',
    },
  },
  {
    path: '/routing/new',
    component: './pages/routing-static',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
    meta: {
      title: 'Static Route Priority · Nami Showcase',
    },
  },
  {
    path: '/client/runtime',
    component: './pages/client-runtime',
    renderMode: RenderMode.CSR,
    meta: {
      title: 'Client Runtime · Nami Showcase',
      description: 'NamiLink、useRouter、路由预取、SWR 请求与性能时间线。',
    },
  },
  {
    path: '/plugins',
    component: './pages/plugins',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
    meta: {
      title: 'Plugin Lifecycle · Nami Showcase',
      description: '构建、服务端与客户端插件生命周期。',
    },
  },
  {
    path: '/stability',
    component: './pages/stability',
    renderMode: RenderMode.CSR,
    meta: {
      title: 'Stability Lab · Nami Showcase',
      description: '客户端错误边界、骨架屏与可控故障注入。',
    },
  },
  {
    path: '/redirect',
    component: './pages/redirect',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
    meta: {
      title: 'SSR Redirect · Nami Showcase',
    },
  },
  {
    path: '/data-not-found',
    component: './pages/data-not-found',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
    meta: {
      title: 'SSR notFound · Nami Showcase',
    },
  },
  {
    path: '/*',
    component: './pages/not-found',
    renderMode: RenderMode.CSR,
    meta: {
      title: 'Page Not Found · Nami Showcase',
    },
  },
];
