# 路由系统

Nami 的路由系统负责将 URL 映射到页面组件，支持静态路由、动态参数、通配符、嵌套路由、客户端懒加载和服务端数据预取。

---

## 1. 路由配置

在 `nami.config.ts` 中声明路由：

```typescript
export default defineConfig({
  routes: [
    // 静态路由
    { path: '/', component: './pages/home', renderMode: 'ssr' },

    // 动态参数路由
    { path: '/users/:id', component: './pages/user-detail', renderMode: 'ssr',
      getServerSideProps: 'getServerSideProps' },

    // 带约束的动态参数（只匹配数字）
    { path: '/posts/:id(\\d+)', component: './pages/post-detail' },

    // 通配符路由
    { path: '/docs/*', component: './pages/docs', renderMode: 'csr' },

    // 嵌套路由
    {
      path: '/admin',
      component: './pages/admin/layout',
      children: [
        { path: 'dashboard', component: './pages/admin/dashboard' },
        { path: 'users', component: './pages/admin/users' },
        { path: 'users/:id', component: './pages/admin/user-edit' },
      ],
    },

    // ISR 路由
    { path: '/products/:slug', component: './pages/product',
      renderMode: 'isr', revalidate: 60,
      getStaticProps: 'getStaticProps',
      getStaticPaths: 'getStaticPaths',
      meta: { cacheTags: ['product'] } },
  ],
});
```

### NamiRoute 完整字段

```typescript
interface NamiRoute {
  path: string;                      // URL 路径模式
  component: string;                 // 组件文件路径（相对 srcDir）
  renderMode?: RenderMode;           // 渲染模式（默认取 defaultRenderMode）
  getServerSideProps?: string;       // SSR 数据预取函数名
  getStaticProps?: string;           // SSG/ISR 数据预取函数名
  getStaticPaths?: string;           // SSG/ISR 路径声明函数名
  revalidate?: number;               // ISR 重验证间隔（秒）
  skeleton?: string;                 // 骨架屏组件文件路径（如 './components/ProductSkeleton'）
  errorBoundary?: string;            // 自定义错误边界组件文件路径
  children?: NamiRoute[];            // 嵌套子路由
  meta?: Record<string, unknown>;    // 路由元信息（title, description, cacheTags 等）
}
```

## 2. 路由匹配算法

### 优先级评分

Nami 使用**优先级评分**而非注册顺序来决定匹配优先级：

```
路由                    段分析              评分
/users                 静态(3)             3 + 1(无通配) = 4
/users/:id(\\d+)       静态(3) + 约束(2)   5 + 1 = 6
/users/:id             静态(3) + 动态(1)   4 + 1 = 5
/users/*               静态(3) + 通配(0)   3 + 0 = 3
/*                     通配(0)             0 + 0 = 0
```

**评分规则**：

| 段类型 | 分值 | 示例 |
|--------|------|------|
| 静态段 | 3 | `/users` |
| 约束参数段 | 2 | `/:id(\\d+)` |
| 动态参数段 | 1 | `/:id` |
| 通配符段 | 0 | `/*` |
| 无通配符加分 | +1 | — |

**匹配结果**：对于请求 `/users/123`，评分最高的 `/users/:id(\\d+)` 优先匹配。

### 匹配流程

```
请求路径: /admin/users/42
    │
    ▼
rankRoutes(routes) — 按评分排序
    │
    ▼
逐条匹配:
  /admin 匹配 ✓
    │
    ▼ 递归匹配 children
    rankRoutes(children)
      /admin/dashboard → /users/42 ✗
      /admin/users/:id → /users/42 ✓ params = { id: '42' }
    │
    ▼
返回 { route, params: { id: '42' } }
```

### 源码核心

```typescript
// packages/core/src/router/path-matcher.ts

// 编译路径模式为正则（带缓存，上限 1024）
function compilePath(pattern: string): CompiledMatcher {
  // '/users/:id' → /^\/users\/([^/]+)$/
  // '/users/:id(\\d+)' → /^\/users\/(\d+)$/
}

// 计算路由优先级分数
function getPatternScore(pattern: string): number {
  // 静态段 +3, 约束参数 +2, 动态参数 +1, 通配符 +0
}

// 排序路由列表
function rankRoutes(routes): RankableRoute[] {
  return routes.sort((a, b) => getPatternScore(b.path) - getPatternScore(a.path));
}
```

### 编译缓存

`path-matcher` 内置 `ruleCache`（Map），避免重复编译正则。缓存上限 1024 条，超出时清除一半（LRU-like 策略）。`RouteManager` 还对 `rankRoutes` 的结果做二级缓存，路由注册/移除时自动失效。

## 3. 服务端路由匹配

服务端有一个**单一匹配源**：`route-match.ts` 的 `matchConfiguredRoute` 函数：

```typescript
function matchConfiguredRoute(requestPath: string, routes: NamiRoute[]): RouteMatchResult | null
```

该函数被三个中间件共用：
- **ISR 缓存中间件**：判断请求是否为 ISR 路由
- **数据预取中间件**：匹配路由后解析数据预取函数
- **渲染中间件**：匹配路由后创建 RenderContext

**统一匹配源保证三者命中同一条路由**，避免 ISR 缓存命中了路由 A 的缓存但渲染中间件匹配到路由 B 的问题。

## 4. 客户端路由

### NamiRouter

客户端使用 React Router v6 (`BrowserRouter` + `Routes`/`Route`)，自动从构建生成的路由模块映射中解析组件：

```typescript
// 构建时生成 .nami/generated-route-modules.ts
export const routeComponentLoaders = {
  './pages/home': () => import('./pages/home'),
  './pages/about': () => import('./pages/about'),
};
```

`NamiRouter` 根据 `nami.config.ts` 中的路由配置和上述映射，自动渲染对应组件。每个路由组件被 `React.lazy` + `Suspense` 包裹。

### NamiLink — 智能预加载

```tsx
import { NamiLink } from '@nami/client';

// hover 时预加载目标路由的 JS chunk
<NamiLink to="/about" prefetch>关于</NamiLink>

// IntersectionObserver 进入视口时预加载
<NamiLink to="/products" prefetch="viewport">商品</NamiLink>
```

预加载分两步：
1. **组件预加载**：触发 `import('./pages/xxx')` 下载 JS chunk
2. **数据预加载**（可选）：`fetch(/__nami_data__/xxx)` 预取数据

### useRouter Hook

```typescript
import { useRouter } from '@nami/client';

function MyComponent() {
  const {
    pathname,     // 当前路径
    search,       // 查询字符串
    params,       // 路由参数
    query,        // 查询参数对象
    navigate,     // 编程式导航
    location,     // location 对象
  } = useRouter();
}
```

## 5. 懒加载路由（lazyRoute）

`lazyRoute` 是对 `React.lazy` + `Suspense` + `ErrorBoundary` 的增强封装：

```typescript
import { lazyRoute } from '@nami/core';

const Home = lazyRoute(() => import('./pages/home'), {
  loading: <div>加载中...</div>,
  errorFallback: <div>页面加载失败</div>,
});

// 使用
<Home.Component />

// 手动预加载（如 hover 时）
Home.preload();
```

### 内部实现

```
lazyRoute(importFn, options)
    │
    ├── cachedImport(): 缓存 import Promise，失败时清除缓存允许重试
    │
    ├── LazyComponent = React.lazy(cachedImport)
    │
    └── WrappedComponent = (props) =>
          errorFallback ?
            <LazyErrorBoundary fallback={errorFallback}>
              <Suspense fallback={loading}>
                <LazyComponent {...props} />
              </Suspense>
            </LazyErrorBoundary>
          :
            <Suspense fallback={loading}>
              <LazyComponent {...props} />
            </Suspense>
```

## 6. 数据预取

### getServerSideProps（SSR）

每次请求时在服务端执行：

```typescript
export async function getServerSideProps(ctx) {
  // ctx 包含:
  // - params: 路由参数 { id: '123' }
  // - query: 查询参数 { page: '1' }
  // - headers: 请求头
  // - cookies: Cookie
  // - path: 请求路径
  // - url: 完整 URL
  // - requestId: 请求 ID

  return {
    props: { /* 组件 props */ },
    // 或
    redirect: { destination: '/login', permanent: false },
    // 或
    notFound: true,
  };
}
```

### getStaticProps（SSG / ISR）

构建时或重验证时执行：

```typescript
export async function getStaticProps(ctx) {
  // ctx 包含: params, path
  return {
    props: { /* 组件 props */ },
  };
}
```

### getStaticPaths（SSG / ISR）

声明需要预生成的所有路径：

```typescript
export async function getStaticPaths() {
  return {
    paths: [
      { params: { slug: 'hello' } },
      { params: { slug: 'world' } },
    ],
    fallback: false,  // false: 未列出的返回 404
                      // 'blocking': 未列出的首次访问时同步渲染
  };
}
```

### 客户端数据 API

服务端的 `dataPrefetchMiddleware` 同时暴露了 JSON API：

```
GET /__nami_data__/products/123
→ { "props": { "product": { ... } } }
```

客户端可通过此 API 在路由切换时获取数据，无需重新加载页面。

## 7. 路由变化监听

```typescript
// 插件中监听
api.onRouteChange(({ from, to, params }) => {
  analytics.track('page_view', { path: to });
});
```

客户端 `RouteChangeListener` 组件会在每次 `location` 变化时触发此钩子。

## 8. 常见问题与注意事项

### 动态路由和静态路由重叠

```typescript
routes: [
  { path: '/users/me', component: './pages/user-me' },      // 静态路由，分值 6
  { path: '/users/:id', component: './pages/user-detail' },  // 动态路由，分值 4
]
```

**不需要担心注册顺序**。Nami 按优先级评分排序，静态路由 `/users/me` 会优先于动态路由 `/users/:id` 匹配，无论谁先声明。

### 服务端和客户端路由一致性

Nami 使用同一份路由配置（`nami.config.ts`）驱动服务端和客户端路由匹配。服务端通过 `matchConfiguredRoute()` 统一匹配，客户端通过构建生成的 `routeDefinitions` 映射到 React Router。

**如果你遇到服务端渲染的页面和客户端 Hydration 后的页面不一致**，最常见的原因是路由配置中 `component` 路径写错，导致服务端匹配了正确的组件但客户端加载了错误的组件。

### getServerSideProps 与 getStaticProps 的函数名

这两个字段的值是**函数名字符串**（如 `'getServerSideProps'`），不是函数本身。框架通过 `ModuleLoader` 从 server bundle 中按名称查找并加载对应的导出函数。

```typescript
// ✅ 正确：函数名字符串
{ getServerSideProps: 'getServerSideProps' }

// ❌ 错误：不要传函数引用
{ getServerSideProps: getServerSideProps }
```

---

## 下一步

- 想了解 ISR 路由的缓存机制？→ [ISR 与缓存](./isr-and-caching.md)
- 想了解渲染器如何消费路由匹配结果？→ [五种渲染模式](./rendering-modes.md)
