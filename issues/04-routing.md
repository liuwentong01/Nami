# 路由系统（6 题）

---

## 题目 27：Nami 的路由匹配算法是如何工作的？路由优先级是怎么计算的？⭐⭐⭐

**答案：**

### 路由优先级评分算法

Nami 使用**评分排序**而非注册顺序来决定路由优先级。每个路由段按类型打分：

| 段类型 | 分值 | 示例 |
|--------|------|------|
| 静态段 | +3 | `/users`、`/about` |
| 约束参数 | +2 | `:id(\d+)` |
| 动态参数 | +1 | `:id` |
| 通配符 | +0 | `*` |
| 无通配符加分 | +1 | 整个路径不含通配符 |

**评分示例：**

```
/users         → 3 + 1(无通配) = 4
/users/:id     → 3 + 1 + 1(无通配) = 5
/users/:id(\d+) → 3 + 2 + 1(无通配) = 6
/:path*        → 1 + 0 = 1
```

**排序规则：** 分数高的优先匹配，分数相同时段数多的优先（更具体的路由优先）。

### 匹配流程

```
1. rankRoutes(routes) — 按优先级排序所有路由
2. 对每条路由依次 matchPath(pattern, requestPath)
3. 如果匹配成功，提取路由参数
4. 如果路由有 children，递归匹配子路由
5. 第一个匹配的路由作为结果返回
```

### 正则编译缓存

每次 `matchPath` 需要将路由 pattern 编译为正则表达式。Nami 使用缓存避免重复编译：

```typescript
// MAX_CACHE_SIZE = 1024
const ruleCache = new Map<string, CompiledMatcher>();

function compilePath(pattern, options): CompiledMatcher {
  const cacheKey = `${pattern}|exact=${options.exact}|sensitive=${options.sensitive}`;

  if (ruleCache.has(cacheKey)) return ruleCache.get(cacheKey);

  // 编译正则...
  const compiled = { regex, keys, score };

  // 缓存满时清理前 50%
  if (ruleCache.size >= MAX_CACHE_SIZE) {
    const keysToDelete = [...ruleCache.keys()].slice(0, MAX_CACHE_SIZE / 2);
    keysToDelete.forEach(k => ruleCache.delete(k));
  }

  ruleCache.set(cacheKey, compiled);
  return compiled;
}
```

**为什么上限 1024？**
正则对象占内存。1024 条路由足以覆盖绝大多数应用，超出时删除最早的一半（简化版 LRU）。

**源码参考：**
- `packages/core/src/router/path-matcher.ts` — compilePath(), matchPath(), rankRoutes()
- `packages/core/src/router/route-manager.ts` — match()

---

## 题目 28：为什么路由要按优先级评分而不是按注册顺序匹配？⭐⭐⭐

**答案：**

**注册顺序匹配的问题：**

假设路由按如下顺序注册：

```typescript
routes: [
  { path: '/:category', ... },  // 动态路由
  { path: '/about', ... },      // 静态路由
]
```

按注册顺序匹配时，访问 `/about` 会被 `/:category` 捕获（`category = "about"`），永远无法到达 `/about` 路由。开发者必须小心安排注册顺序——静态路由在前，动态路由在后。

**优先级评分的优势：**

```
/:category → 分数 1 (动态参数)
/about     → 分数 3 + 1(无通配) = 4 (静态段)
```

不管注册顺序如何，`/about` 的分数总是高于 `/:category`，静态路由总是优先匹配。这**符合直觉且不依赖注册顺序**。

**更复杂的例子：**

```
/users/:id       → 3 + 1 + 1 = 5
/users/:id(\d+)  → 3 + 2 + 1 = 6
/users/admin     → 3 + 3 + 1 = 7
```

访问 `/users/admin`：匹配静态路由 `/users/admin`（分 7）
访问 `/users/123`：匹配约束路由 `/users/:id(\d+)`（分 6）
访问 `/users/abc`：匹配动态路由 `/users/:id`（分 5）

**源码参考：**
- `packages/core/src/router/path-matcher.ts` — getPatternScore(), rankRoutes()

---

## 题目 29：Nami 如何实现路由级代码分割（Code Splitting）？⭐⭐⭐

**答案：**

### 构建时：自动生成动态 import 映射

```typescript
// .nami/generated-route-modules.ts（构建时自动生成）
export const generatedComponentLoaders = {
  './pages/home': () => import(/* webpackChunkName: "page-home" */ '../src/pages/home'),
  './pages/about': () => import(/* webpackChunkName: "page-about" */ '../src/pages/about'),
  './pages/product': () => import(/* webpackChunkName: "page-product" */ '../src/pages/product'),
};
```

每个 `import()` 被 Webpack 识别为一个独立的分割点，生成独立的 chunk 文件。

### 运行时：React.lazy + Suspense

```typescript
// packages/client/src/router/nami-router.tsx
const lazyComponentCache = new Map();

function getLazyComponent(componentKey: string): React.LazyExoticComponent {
  if (lazyComponentCache.has(componentKey)) {
    return lazyComponentCache.get(componentKey);
  }

  const loader = generatedComponentLoaders[componentKey];
  const LazyComponent = React.lazy(loader);
  lazyComponentCache.set(componentKey, LazyComponent);
  return LazyComponent;
}

// 路由渲染
<Route path={route.path} element={
  <Suspense fallback={<Loading />}>
    <LazyComponent />
  </Suspense>
} />
```

### 为什么缓存 lazy 组件？

`React.lazy()` 每次调用都会创建一个新的懒加载包装器。如果不缓存，路由切换时会重新创建，导致组件重新挂载（丢失状态）。缓存确保同一路由始终使用同一个 lazy 包装器。

### 为什么用 webpackChunkName 注释？

1. 生成可读的 chunk 文件名（`page-home.chunk.js` 而非 `123.chunk.js`）
2. 方便调试和分析 Bundle 大小
3. 支持按名称预加载特定路由的 chunk

### 构建产物

```
dist/client/static/js/
├── main.[hash].js         # 应用入口
├── vendor.[hash].js       # React 等第三方库
├── runtime.[hash].js      # Webpack 运行时
├── page-home.[hash].js    # /home 路由 chunk
├── page-about.[hash].js   # /about 路由 chunk
└── page-product.[hash].js # /products/:slug 路由 chunk
```

**源码参考：**
- `packages/webpack/src/configs/client.config.ts` — 生成 generated-route-modules.ts
- `packages/client/src/router/nami-router.tsx` — React.lazy + Suspense

---

## 题目 30：matchConfiguredRoute 为什么被服务端多个中间件共用？这样设计有什么好处？⭐⭐⭐⭐

**答案：**

在 Nami 服务端，有三个中间件需要路由匹配：

1. **dataPrefetch 中间件**：匹配路由以找到对应的数据预取函数
2. **isrCacheMiddleware**：匹配路由以判断是否是 ISR 路由
3. **renderMiddleware**：匹配路由以确定渲染模式和组件

它们都使用同一个 `matchConfiguredRoute(path, routes)` 函数。

**为什么共用而不是各自匹配？**

**一致性保证：** 如果三个中间件使用不同的匹配逻辑，可能出现：
- dataPrefetch 匹配到路由 A，获取了 A 的数据
- renderMiddleware 匹配到路由 B，用 B 的组件渲染
- 结果：数据和组件不匹配

共用同一个匹配函数确保三者**始终命中同一条路由**。

**性能考虑：** RouteManager 的 `getRankedRoutes()` 会缓存排序结果。多次调用 matchConfiguredRoute 实际上复用了已排序的路由列表，而不是每次重新排序。

```typescript
// packages/core/src/router/route-manager.ts
getRankedRoutes(): NamiRoute[] {
  if (this.rankedRoutesCache) return this.rankedRoutesCache;  // 缓存命中
  this.rankedRoutesCache = rankRoutes(this.routes);
  return this.rankedRoutesCache;
}
```

**源码参考：**
- `packages/server/src/middleware/route-match.ts` — matchConfiguredRoute()
- `packages/server/src/middleware/render-middleware.ts` — 使用 matchConfiguredRoute
- `packages/server/src/middleware/isr-cache-middleware.ts` — 使用 matchConfiguredRoute

---

## 题目 31：NamiRoute 中的 skeleton 和 errorBoundary 字段的类型为什么是 string 而不是 boolean？⭐⭐⭐

**答案：**

```typescript
// packages/shared/src/types/route.ts
interface NamiRoute {
  skeleton?: string;        // 组件文件路径，如 './components/ProductSkeleton'
  errorBoundary?: string;   // 组件文件路径，如 './components/ProductError'
  // ...
}
```

**为什么是 string 而不是 boolean？**

因为不同路由可能需要不同的骨架屏和错误页面：

```typescript
routes: [
  {
    path: '/products/:id',
    component: './pages/product',
    skeleton: './components/ProductSkeleton',    // 商品页骨架屏
    errorBoundary: './components/ProductError',  // 商品页错误页
  },
  {
    path: '/dashboard',
    component: './pages/dashboard',
    skeleton: './components/DashboardSkeleton',  // 仪表盘骨架屏
    errorBoundary: './components/DashboardError', // 仪表盘错误页
  },
]
```

如果是 boolean，所有路由只能用同一个全局骨架屏，无法针对不同页面的布局提供定制化的 loading 体验。

**使用场景：**
- 降级管理器 Level 3（骨架屏降级）时，加载 `skeleton` 指定的组件文件生成骨架屏 HTML
- error-boundary 插件在渲染失败时加载 `errorBoundary` 指定的错误页面组件

**源码参考：**
- `packages/shared/src/types/route.ts` — NamiRoute.skeleton, NamiRoute.errorBoundary
- `packages/core/src/error/degradation.ts` — Level 3 使用 skeleton 路径

---

## 题目 32：客户端路由切换时如何获取新页面的数据？⭐⭐⭐

**答案：**

客户端路由切换（SPA 导航）时，不会刷新整个页面。但**当前实现不会在路由切换时自动请求页面数据**：

```
用户点击 Link / 调用 router.push()
→ react-router-dom 执行客户端导航
→ 加载目标页面组件（JS chunk）
→ 渲染新页面
```

`dataPrefetch API` 是框架提供的**可选数据预取能力**，只有显式调用时才会发起请求，不是每次 SPA 切换都会自动触发。

### dataPrefetch 中间件

当客户端显式请求 `GET /_nami/data/*` 时，服务端会由 `dataPrefetchMiddleware` 拦截：

```typescript
// packages/server/src/middleware/data-prefetch-middleware.ts
// 请求: GET /_nami/data/products/123

1. 从 URL 提取真实路径: /products/123
2. matchConfiguredRoute('/products/123', routes) → 匹配路由
3. 根据路由的 renderMode 决定调用哪个数据预取函数:
   - SSR 路由 → getServerSideProps(context)
   - ISR/SSG 路由 → getStaticProps(context)
4. 执行函数获取数据
5. 返回 JSON: props 对象本身（不是 { props: ... } 包装结构）
```

### 客户端的请求流程

```typescript
// 显式启用数据预取时才会触发
async function prefetchData(path: string) {
  const response = await fetch(`/_nami/data${path}`);
  const data = await response.json();
  return data;
}
```

### 当前代码里的实际行为

1. `useRouter().push()` / `replace()` 只调用 `navigate(...)`，不会自动请求 `/_nami/data/*`
2. `NamiLink` 只有配置 `prefetchOnHover` 或 `prefetchOnVisible` 时才会调用 `prefetchRoute(path)`，且默认只预取 JS chunk
3. 只有 `prefetchRoute(path, { prefetchData: true })` 时，才会真正请求 `/_nami/data/*`

**为什么不直接在客户端调用 API？**

1. **安全性**：`getServerSideProps` 可能包含内部 API 地址、数据库查询等，只在服务端执行
2. **一致性**：数据预取逻辑只写一份，首次 SSR 和后续导航都使用同一段逻辑
3. **简化开发**：开发者不需要维护两套数据获取逻辑

**源码参考：**
- `packages/server/src/middleware/data-prefetch-middleware.ts` — 服务端数据预取中间件
- `packages/client/src/router/use-router.ts` — 客户端导航只做 `navigate(...)`
- `packages/client/src/router/link.tsx` — `NamiLink` 在 hover / 视口策略触发时调用 `prefetchRoute(path)`
- `packages/client/src/router/route-prefetch.ts` — `prefetchData` 默认关闭，显式开启才请求 `/_nami/data/*`
