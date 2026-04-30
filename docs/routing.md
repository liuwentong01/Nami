# 路由系统原理

Nami 的路由系统负责把 URL 映射到页面组件，并把同一份路由配置用于服务端渲染、ISR 缓存、数据预取 API、客户端懒加载和导航预取。

读这一章时要先区分三套“选路”逻辑：

1. **服务端 HTML / ISR / 数据 API 匹配**：统一走 `matchConfiguredRoute()`，内部使用 `rankRoutes + matchPath`。
2. **客户端页面渲染**：`NamiRouter` 基于 `react-router-dom` v6，把 `NamiRoute[]` 渲染成 `<Routes>/<Route>`。
3. **客户端预取**：`prefetchRoute()` 使用构建生成的 `generatedRouteDefinitions` 顺序扫描，再调用动态 import 工厂。

这三条链路使用相同路由配置，但实现细节并不完全相同。文档会在对应位置标出差异。

---

## 1. 源码地图

| 主题 | 源码 |
|------|------|
| 路由类型定义 | `packages/shared/src/types/route.ts` |
| 路径编译、匹配、排序 | `packages/core/src/router/path-matcher.ts` |
| 路由匹配封装 | `packages/core/src/router/route-matcher.ts` |
| 路由注册管理 | `packages/core/src/router/route-manager.ts` |
| 懒加载路由工具 | `packages/core/src/router/lazy-route.ts` |
| 服务端统一匹配 | `packages/server/src/middleware/route-match.ts` |
| 数据预取 API | `packages/server/src/middleware/data-prefetch-middleware.ts` |
| 渲染中间件匹配入口 | `packages/server/src/middleware/render-middleware.ts` |
| ISR 缓存路由判断 | `packages/server/src/middleware/isr-cache-middleware.ts` |
| 客户端路由组件 | `packages/client/src/router/nami-router.tsx` |
| 客户端链接组件 | `packages/client/src/router/link.tsx` |
| 客户端预取工具 | `packages/client/src/router/route-prefetch.ts` |
| `useRouter` Hook | `packages/client/src/router/use-router.ts` |
| 构建生成路由模块 | `packages/webpack/src/configs/client.config.ts` |
| 数据 API 前缀常量 | `packages/shared/src/constants/defaults.ts` |

---

## 2. 路由配置

源码位置：`packages/shared/src/types/route.ts`

`NamiRoute` 的字段：

```typescript
export interface NamiRoute {
  path: string;
  component: string;
  renderMode: RenderMode;
  getServerSideProps?: string;
  getStaticProps?: string;
  getStaticPaths?: string;
  revalidate?: number;
  fallback?: ISRFallbackStrategy;
  skeleton?: string;
  errorBoundary?: string;
  meta?: Record<string, unknown>;
  children?: NamiRoute[];
  exact?: boolean;
}
```

字段语义：

| 字段 | 说明 |
|------|------|
| `path` | 路由路径模式，支持静态段、动态参数、约束参数、通配符 |
| `component` | 页面组件路径，相对 `srcDir` |
| `renderMode` | 路由渲染模式，合并后的运行时配置里必有值 |
| `getServerSideProps` | SSR 数据函数的导出名字符串 |
| `getStaticProps` | SSG/ISR 数据函数的导出名字符串 |
| `getStaticPaths` | SSG/ISR 动态路径函数的导出名字符串 |
| `revalidate` | ISR 路由级重验证间隔，秒 |
| `fallback` | ISR/SSG 动态路径兜底策略 |
| `skeleton` | 路由骨架屏配置，目前降级管理器只判断该字段是否存在 |
| `errorBoundary` | 自定义错误边界组件路径，类型层面预留 |
| `meta` | 路由元信息，例如 `title`、`description`、`streaming`、`cacheTags` |
| `children` | 嵌套路由 |
| `exact` | 是否精确匹配；只有 `exact === false` 时走前缀匹配 |

示例：

```typescript
export default defineConfig({
  routes: [
    { path: '/', component: './pages/home', renderMode: 'ssr' },

    {
      path: '/users/:id',
      component: './pages/user-detail',
      renderMode: 'ssr',
      getServerSideProps: 'getServerSideProps',
    },

    {
      path: '/posts/:id(\\d+)',
      component: './pages/post-detail',
      renderMode: 'ssr',
    },

    {
      path: '/docs/*',
      component: './pages/docs',
      renderMode: 'csr',
    },

    {
      path: '/products/:slug',
      component: './pages/product',
      renderMode: 'isr',
      revalidate: 60,
      getStaticProps: 'getStaticProps',
      getStaticPaths: 'getStaticPaths',
      meta: { cacheTags: ['product'] },
    },
  ],
});
```

`getServerSideProps`、`getStaticProps`、`getStaticPaths` 都是**导出函数名字符串**，不是函数引用。框架运行时会通过 `ModuleLoader` 从 server bundle 中按名称查找对应导出。

---

## 3. 路径匹配器

源码位置：`packages/core/src/router/path-matcher.ts`

Nami 自带一个无外部依赖的 path-to-regexp 风格匹配器，核心 API：

| API | 作用 |
|-----|------|
| `compilePath(pattern, options)` | 把路径模式编译成匹配函数 |
| `matchPath(pattern, pathname, options)` | 快捷匹配 |
| `rankRoutes(routes)` | 按路由特异性排序 |

### 支持的路径语法

| 语法 | 示例 | 说明 |
|------|------|------|
| 静态路径 | `/about` | 字面匹配 |
| 必选参数 | `/user/:id` | 匹配单个路径段，输出 `{ id }` |
| 可选参数 | `/user/:id?` | 整个参数段可省略 |
| 约束参数 | `/post/:id(\\d+)` | 参数必须满足括号内正则 |
| 多值参数 | `/docs/:path+` | 匹配一个或多个路径段 |
| 通配符 | `/docs/*` | 匹配剩余路径，参数名为 `'*'` |
| 正则分组 | `/file/(.*)` | 正则分组参数名为 `$0`、`$1` |

注意：`/docs/*` 中的 `*` 编译为 `(.+)`，需要至少一个后续路径段，因此它不匹配 `/docs` 本身。

### 标准化与编译缓存

`compilePath()` 匹配前会通过 `normalizePath()`：

1. 确保路径以 `/` 开头。
2. 移除 `#hash`。
3. 移除 `?query`。

编译结果存放在模块级 `ruleCache` 中，缓存 key 包含 `pattern`、`exact`、`sensitive`。上限是 `1024` 条，超过时删除前一半 key，避免无限增长。

默认大小写不敏感，因为正则 flags 使用 `i`。精确匹配默认允许尾部可选 `/`：

```typescript
exact ? /^pattern\/?$/i : /^pattern/i
```

### `exact`

| 配置 | 正则形态 | 行为 |
|------|----------|------|
| `exact !== false` | `^...\\/?$` | 精确匹配，允许尾斜杠 |
| `exact === false` | `^...` | 前缀匹配 |

`exact: false` 会让父路径命中更多 URL，应谨慎与子路由、重叠路由搭配。

---

## 4. 路由优先级排序

源码位置：`packages/core/src/router/path-matcher.ts`

`rankRoutes()` 不是简单按配置顺序匹配，而是先算分：

| 段类型 | 分值 | 示例 |
|--------|------|------|
| 静态段 | `+3` | `/users` |
| 约束参数 | `+2` | `/:id(\\d+)` |
| 普通动态参数 | `+1` | `/:id` |
| 通配符 / 多值参数 | `+0` | `/*`、`:path+` |
| 无 `*` 的模式 | `+1` | 精确性加分 |

排序规则：

1. 分数高的在前。
2. 分数相同，路径段更多的在前。
3. 仍相同，保留原始顺序。

示例：

```text
/users/me          静态 + 静态 + 无通配 = 3 + 3 + 1 = 7
/users/:id(\\d+)   静态 + 约束 + 无通配 = 3 + 2 + 1 = 6
/users/:id         静态 + 动态 + 无通配 = 3 + 1 + 1 = 5
/users/*           静态 + 通配         = 3 + 0     = 3
```

因此 `/users/123` 优先命中 `/users/:id(\\d+)`，而 `/users/me` 优先命中静态路由。

---

## 5. 服务端统一匹配

源码位置：`packages/server/src/middleware/route-match.ts`

服务端统一入口：

```typescript
export function matchConfiguredRoute(
  requestPath: string,
  routes: NamiRoute[],
): RouteMatchResult | null;
```

流程：

```text
matchConfiguredRoute(path, routes)
  -> matchRouteList(path, routes)
       -> sortedRoutes = rankRoutes(routes)
       -> 逐条 matchPath(route.path, path, { exact: route.exact !== false })
       -> 命中则返回 { route, params, isExact }
       -> 顶层没命中，再递归扫描 children
```

这个函数被三类服务端中间件共用：

| 中间件 | 用途 |
|--------|------|
| `isr-cache-middleware.ts` | 判断请求是否为 ISR 路由，并决定是否走缓存 |
| `data-prefetch-middleware.ts` | 匹配 `/_nami/data/*` 对应页面路由 |
| `render-middleware.ts` | 创建 `RenderContext` 并选择 Renderer |

统一匹配源避免出现“缓存层命中路由 A、渲染层命中路由 B”的问题。

### `isExact` 的含义

`RouteMatchResult.isExact` 当前由：

```typescript
const exact = route.exact !== false;
return { isExact: exact };
```

得出。它表示该路由配置是否按精确模式匹配，不表示“本次 URL 是否刚好无额外段”。

---

## 6. 客户端路由

源码位置：`packages/client/src/router/nami-router.tsx`

客户端使用 `react-router-dom` v6：

```text
NamiRouter
  -> BrowserRouter
       -> RouteChangeListener
       -> Routes
            -> Route
```

每条 `NamiRoute` 会被转换成 `<Route>`。组件加载流程：

```text
route.component
  -> componentResolver(componentPath)
  -> generatedComponentLoaders[componentPath]
  -> React.lazy()
  -> Suspense
```

默认 `componentResolver` 读取构建时生成的 `generatedComponentLoaders`。如果找不到对应 loader，会返回 rejected Promise，并记录“未找到路由组件加载器”。

`NamiRouter` 内部有 `lazyComponentCache`，按 `componentPath` 缓存 `React.lazy` 包装结果，避免每次渲染重新创建 lazy 组件。

### 客户端路由变化

`RouteChangeListener` 使用 `useLocation()` 监听 `location.pathname`：

```text
from = previousPathRef.current
to = location.pathname
from !== to 时触发 onRouteChange({ from, to })
```

`entry-client.tsx` 收到后会调用插件：

```typescript
pluginManager.runParallelHook('onRouteChange', {
  from,
  to,
  params: {},
});
```

当前传给插件的 `params` 固定为空对象。插件若需要动态参数，需要结合路由上下文另行解析。

### 客户端与服务端选路差异

服务端显式 `rankRoutes()`；客户端 `<Routes>` 的最终匹配由 React Router v6 完成，`NamiRouter` 是按传入 `routes.map(renderRoute)` 渲染。大多数标准路由行为一致，但当存在大量重叠路由、`exact: false`、通配符或嵌套路由时，应避免依赖“配置顺序”推断服务端行为。

---

## 7. 构建生成路由模块

源码位置：`packages/webpack/src/configs/client.config.ts`

客户端构建会生成：

```text
.nami/generated-route-modules.ts
```

导出两个对象：

```typescript
export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "..."),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions = [
  { path: "/", component: "./pages/home", exact: true },
];
```

生成逻辑来自 `ensureGeneratedRouteModules()`：

| 产物 | 来源 |
|------|------|
| `generatedComponentLoaders` | `config.routes.map(route => route.component)` 去重 |
| `generatedRouteDefinitions` | `config.routes.map(route => ({ path, component, exact }))` |
| `exact` | `route.exact === false ? false : true` |

当前生成逻辑只扫描**顶层** `config.routes`，不会递归收集 `children`。如果子路由有独立 `component`，默认生成模块可能缺少对应 loader，客户端预取或渲染会找不到组件映射。使用嵌套路由时需要确认构建生成结果，或通过自定义 `componentResolver` 补齐。

---

## 8. `NamiLink` 与路由预取

源码位置：

- `packages/client/src/router/link.tsx`
- `packages/client/src/router/route-prefetch.ts`

`NamiLink` 是 `react-router-dom` 的 `Link` 增强版：

```tsx
<NamiLink to="/about" prefetchOnHover>
  关于
</NamiLink>

<NamiLink to="/products" prefetchOnVisible prefetchMargin="200px">
  商品
</NamiLink>
```

新增 props：

| 字段 | 默认值 | 行为 |
|------|--------|------|
| `prefetchOnHover` | `false` | 鼠标悬停后触发预取 |
| `prefetchOnVisible` | `false` | 进入视口后触发预取 |
| `prefetchMargin` | `'100px'` | `IntersectionObserver.rootMargin` |
| `prefetchDelay` | `100` | hover 延迟，设为 `0` 立即预取 |

`NamiLink` 内部调用：

```typescript
prefetchRoute(targetPath)
```

没有传 options，因此默认只预取 JS chunk，不预取数据。

### `prefetchRoute()`

默认选项：

```typescript
{
  prefetchChunk: true,
  prefetchData: false,
  dataApiPrefix: NAMI_DATA_API_PREFIX,
  timeout: 5000,
}
```

流程：

```text
prefetchRoute(path)
  -> prefetchChunkForRoute(path)
       -> resolveRouteComponent(path)
       -> generatedRouteDefinitions 顺序扫描 matchPath
       -> generatedComponentLoaders[componentPath]()
  -> 如果 prefetchData: true
       -> GET `${dataApiPrefix}${path}`
       -> 存入 dataCache，TTL 5 分钟
  -> Promise.race([allSettled(tasks), timeout])
```

`prefetchRoute()` 的预取失败只记录 warn，不阻断用户导航。

### 路径提取

`NamiLink` 的 `to` 支持字符串或对象。对象形式下：

```typescript
return to.pathname ?? '/';
```

用于预取的路径只取 `pathname`，不包含 `search` 和 `hash`。

---

## 9. `useRouter`

源码位置：`packages/client/src/router/use-router.ts`

`useRouter()` 封装 `react-router-dom`：

```typescript
const router = useRouter();

router.path;      // location.pathname
router.fullPath;  // pathname + search + hash
router.query;     // URLSearchParams 转普通对象
router.params;    // useParams()
router.hash;      // location.hash

router.push('/dashboard');
router.replace('/login');
router.back();
router.forward();
router.go(-2);
```

查询参数使用 `URLSearchParams.forEach()` 转对象。同名多值参数会保留最后一个值。

导航方法：

| 方法 | 实现 |
|------|------|
| `push(path, { state })` | `navigate(path, { state })` |
| `replace(path, { state })` | `navigate(path, { replace: true, state })` |
| `back()` | `navigate(-1)` |
| `forward()` | `navigate(1)` |
| `go(delta)` | `navigate(delta)` |

`useRouter` 当前不内置 `prefetch` 方法；预取请使用 `NamiLink` 或直接调用 `prefetchRoute()`。

---

## 10. `lazyRoute`

源码位置：`packages/core/src/router/lazy-route.ts`

`lazyRoute()` 是对 `React.lazy + Suspense` 的轻量封装：

```typescript
const About = lazyRoute(
  () => import('./pages/about'),
  {
    loading: <div>加载中...</div>,
    errorFallback: <div>页面加载失败</div>,
  },
);

<About.Component />;
await About.preload();
```

实现要点：

| 机制 | 行为 |
|------|------|
| `cachedImport()` | 缓存 import Promise，避免重复加载 |
| import 失败 | 清空缓存，允许下次重试 |
| `Suspense` | 加载中显示 `loading` |
| `LazyErrorBoundary` | 仅在提供 `errorFallback` 时包裹 |
| `preload()` | 提前调用 `cachedImport()`，失败只 warn，不抛给调用者 |

默认的 `NamiRouter` 已经使用 `React.lazy + Suspense` 加载组件。`lazyRoute()` 更适合用户在自定义路由组件或局部动态组件中手动使用。

---

## 11. 数据预取 API

源码位置：`packages/server/src/middleware/data-prefetch-middleware.ts`

数据 API 前缀来自：

```typescript
NAMI_DATA_API_PREFIX = '/_nami/data'
```

只处理 GET 请求：

```text
GET /_nami/data/products/123
  -> requestPath = /products/123
  -> matchConfiguredRoute(requestPath, config.routes)
  -> 按 renderMode 调用数据函数
```

### SSR

条件：

```typescript
route.renderMode === RenderMode.SSR && route.getServerSideProps
```

从 server bundle 中读取 `route.getServerSideProps` 指定的导出函数。传入上下文：

| 字段 | 来源 |
|------|------|
| `params` | 路由动态参数 |
| `query` | Koa query，只保留字符串或字符串数组 |
| `headers` | 小写请求头 |
| `path` | 去掉 `/_nami/data` 后的页面路径 |
| `url` | 页面路径 + 原始 querystring |
| `cookies` | 从 `Cookie` 请求头解析 |
| `requestId` | `ctx.state.requestId` 或 `'unknown'` |

返回处理：

| 返回 | HTTP 响应 |
|------|-----------|
| `notFound` | `404 { notFound: true }` |
| `redirect` | `statusCode` 或 `308/307`，body 为 `{ redirect }` |
| `props` | `200`，body 为 `props` |

### SSG / ISR

条件：

```typescript
(route.renderMode === SSG || route.renderMode === ISR)
  && route.getStaticProps
```

调用 `getStaticProps({ params })`。当前数据 API 链路只传 `params`，不传 query、headers、cookies、locale。

返回处理同样支持 `notFound` 和 `redirect`。

### 无数据函数

如果命中的路由模式不需要数据函数，或者未配置对应函数：

```http
204 No Content
```

这条 JSON API 与 HTML 首屏中的 `window.__NAMI_DATA__` 是两条链路。HTML 链路的数据预取发生在具体 Renderer 中。

---

## 12. 嵌套路由注意事项

类型与客户端 `NamiRouter` 都支持 `children`，服务端 `matchConfiguredRoute()` 也会递归匹配子路由。但当前构建生成文件只遍历顶层 `config.routes`：

```typescript
config.routes.map((route) => route.component)
config.routes.map((route) => ({ path, component, exact }))
```

这带来两个实践建议：

1. 如果子路由有独立组件，需要确认 `.nami/generated-route-modules.ts` 是否包含它。
2. 复杂嵌套路由建议用扁平化路由配置表达完整路径，或提供自定义 `componentResolver`。

另外，React Router v6 的嵌套路由通常需要父组件渲染 `<Outlet />` 才能显示子路由内容。`NamiRouter` 只负责生成 `<Route>` 树，不会自动给父组件插入 `<Outlet />`。

---

## 13. 常见误区

### 误区一：服务端完全按配置顺序匹配

不是。服务端先用 `rankRoutes()` 排序，再逐条匹配。只有分数和段数都相同，原始顺序才起作用。

### 误区二：客户端预取和服务端匹配一定完全一致

不一定。服务端显式使用 `rankRoutes()`；`prefetchRoute()` 在 `generatedRouteDefinitions` 上按数组顺序扫描；客户端页面渲染由 React Router v6 决定。重叠路由应尽量写清晰，避免依赖边缘排序。

### 误区三：`NamiLink` 默认会预取数据

不会。`NamiLink` 默认调用 `prefetchRoute(path)`，只预取 JS chunk。数据预取需要显式调用 `prefetchRoute(path, { prefetchData: true })`。

### 误区四：`children` 会自动进入生成模块

当前不会。`.nami/generated-route-modules.ts` 只基于顶层 `config.routes` 生成。

### 误区五：`/_nami/data/*` 是 HTML SSR 的数据预取入口

不是。它是客户端路由预取 JSON 的 API。HTML SSR 的数据预取由 `SSRRenderer.prefetchData()` 执行。

### 误区六：`getServerSideProps` 字段可以传函数

不能。路由配置里传的是导出函数名字符串，例如 `'getServerSideProps'`。

---

## 下一步

- ISR 路由如何缓存：阅读 [ISR 与缓存](./isr-and-caching.md)
- 路由如何进入渲染器：阅读 [渲染模式原理](./rendering-modes.md)
- 服务端匹配与中间件顺序：阅读 [服务器与中间件](./server-and-middleware.md)
