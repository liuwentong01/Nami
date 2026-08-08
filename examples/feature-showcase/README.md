# Nami Feature Showcase

这是 Nami 当前的综合示例与可运行验收应用。它不是把功能拆成彼此孤立的代码片段，而是在同一套路由、构建、服务端和客户端入口中组合展示：

- CSR、SSR、Streaming SSR、SSG、ISR 五种页面行为。
- GSSP、GSP、`getStaticPaths`、参数、查询串、Cookie、请求头和安全序列化。
- React 18 Streaming、Suspense Shell 优先输出和分块返回。
- ISR 的 `MISS → HIT → STALE → 后台重建 → HIT`、动态路径和 cache tags。
- 静态路由优先级、动态参数、通配路由、服务端重定向和 `notFound`。
- 客户端 Hydration、NamiLink、useRouter、代码/数据预取、SWR 请求缓存和 Service Worker 注册。
- 构建、服务端、渲染、客户端、路由、错误和销毁阶段的插件 Hook。
- 官方 Request、Skeleton、Error Boundary、Monitor 插件和一个可观察的自定义插件。
- Webpack 客户端 Bundle、服务端 Bundle、路由级 chunk、asset manifest 和静态页面产物。

> 缩写：GSSP = `getServerSideProps`；GSP = `getStaticProps`。`getStaticPaths` 通常直接写全称，避免使用不统一的缩写。Streaming SSR 在路由上仍是 `RenderMode.SSR`，通过 `meta.streaming: true` 选择流式 Renderer。

## 1. 启动

需要 Node.js 18+、pnpm 8+。从仓库根目录执行：

```bash
pnpm install
pnpm build
pnpm typecheck:showcase
pnpm dev:showcase
```

访问 `http://127.0.0.1:3100`。

这里的 `dev:showcase` 会先执行一次完整生产构建再启动服务，因此能够覆盖所有渲染模式，但不提供 HMR。当前 CLI 的原生 `nami dev` 尚未应用示例必需的 webpack/插件配置，也不生成 SSG 页面；只把它保留为 `pnpm --filter @nami/example-feature-showcase run dev:hmr` 诊断入口，不作为本示例的成功路径。

验证生产构建和生产运行时：

```bash
pnpm build:showcase
pnpm start:showcase
```

也可以进入当前目录执行：

```bash
pnpm run typecheck
pnpm run build
pnpm run start
```

## 2. 路由能力地图

| 地址                             | 模式          | 数据入口             | 重点观察                                                       |
| -------------------------------- | ------------- | -------------------- | -------------------------------------------------------------- |
| `/`                              | SSG           | GSP                  | 构建时间、静态 HTML、Hydration 数据快照                        |
| `/rendering/csr`                 | CSR           | 浏览器状态与请求     | HTML 壳、事件、客户端请求、无需服务端数据函数                  |
| `/rendering/ssr/:name?topic=...` | SSR           | GSSP                 | params、query、Cookie、UA、requestId、自定义响应头             |
| `/rendering/streaming`           | Streaming SSR | GSSP + Suspense      | 先到达的 Shell、700ms / 1400ms 异步边界、chunked 响应          |
| `/content`                       | SSG           | GSP                  | 构建期内容索引和运行时静态文件读取                             |
| `/content/:slug`                 | 动态 SSG      | getStaticPaths + GSP | 三条构建路径、静态文件读取、缺失文件的错误隔离                 |
| `/products`                      | ISR           | GSP                  | 8 秒 revalidate、Generation ID、cache tag `catalog`            |
| `/products/:id`                  | 动态 ISR      | getStaticPaths + GSP | 构建枚举与运行缓存的边界、首次 MISS、cache tags                |
| `/routing/:id`                   | SSR           | GSSP                 | 动态路由参数和路由匹配结果头                                   |
| `/routing/new`                   | SSR           | GSSP                 | 即使声明在动态路由之后，静态路由仍优先                         |
| `/client/runtime`                | CSR           | Client APIs          | NamiLink、useRouter、prefetchRoute、useClientFetch、useRequest |
| `/plugins`                       | SSR           | GSSP + Plugin Hooks  | 插件顺序、生命周期、响应头和浏览器事件时间线                   |
| `/stability`                     | CSR           | 客户端状态 + Koa API | 局部/插件全局 Error Boundary、Skeleton、503 和恢复             |
| `/redirect`                      | SSR           | GSSP redirect        | 直接文档请求返回 `307` 与 `Location`                           |
| `/data-not-found`                | SSR           | GSSP notFound        | 直接文档请求返回 `404`                                         |
| `/*`                             | CSR           | 无                   | 客户端通配兜底页                                               |

动态 SSG 已生成的 slug：

- `rendering-pipeline`
- `data-hydration`
- `route-manifest`

动态 ISR 中 `edge-cache`、`stream-kit` 会由 `getStaticPaths` 生成构建文件，`manifest-inspector`、`hydration-probe` 不会。当前运行时并不使用前者预热 ISR 缓存，因此新进程中两类地址的第一次请求都会是 `MISS`；这个差异正是页面要展示的实现边界。

## 3. 源码地图

```text
feature-showcase/
├── nami.config.ts                  # CLI 配置、构建期兼容插件、server webpack 补充
├── src/
│   ├── routes.ts                   # 唯一路由事实源，驱动构建/服务端/客户端
│   ├── runtime-config.ts           # client/server 共用的完整 NamiConfig
│   ├── entry-server.tsx            # 页面注册、SSR/Streaming 元素工厂、SSG 文档生成
│   ├── entry-client.tsx            # 注水协议归一化与 initNamiClient
│   ├── app.tsx                     # 被 wrapApp 注入的共享应用壳
│   ├── pages/                      # 每项能力对应的真实页面和数据函数
│   ├── plugins/showcase-plugins.tsx# 官方插件组合与自定义生命周期插件
│   ├── hooks/use-showcase-data.ts  # SSR/注水数据的兼容读取
│   ├── service-worker.js           # 注册流程示例，不拦截请求
│   └── global.css                  # 客户端抽取并进入 asset manifest 的样式
└── .nami/                          # CLI 生成的客户端精简 shim 与路由模块映射
```

阅读顺序建议：`routes.ts → 某个 page → entry-server.tsx → runtime-config.ts → nami.config.ts → entry-client.tsx → showcase-plugins.tsx`。

## 4. 五种渲染链路

### 4.1 CSR

```text
请求 /rendering/csr
  → Koa 匹配 CSR 路由
  → 返回 document shell + client assets
  → 浏览器执行 entry-client
  → initNamiClient 创建 React Root
  → 加载页面 chunk 并渲染交互 UI
```

`csr-playground.tsx` 用本地 state、浏览器时间和 API 请求证明业务内容在客户端执行。CSR 不应导出 GSSP/GSP。

### 4.2 SSR

```text
请求 /rendering/ssr/:name
  → RouteManager 匹配并提取 params
  → ModuleLoader 获取页面模块与 GSSP
  → GSSP 读取 RenderContext / 请求上下文
  → SSRRenderer 生成 React HTML
  → 注入 title、manifest 资源、序列化数据和响应头
  → 浏览器用同一份 props hydrateRoot
```

`ssr-request.tsx` 会把参数、查询串、Cookie、UA、requestId 与执行时间画到页面上，并返回 `X-Nami-Showcase` 等响应头。

### 4.3 Streaming SSR

`streaming.tsx` 使用两个延迟 `lazy()` 模块和两个 Suspense 边界。Renderer 调用 `renderToPipeableStream` 后可以先发送页面 Shell 和 fallback，随后依次写入约 700ms、1400ms 才完成的内容。Lazy 组件按 `requestId` 建立并限制为 64 组缓存，避免 React.lazy 的模块级缓存导致只有进程第一次请求能观察到分块。Streaming 优化的是可展示内容到达时间，并不消除总计算时间。

### 4.4 SSG

```text
nami build
  → Builder 筛选 SSG 路由
  → 动态路由先执行 getStaticPaths 展开 params
  → 对每个 URL 执行 GSP
  → entry-server.renderToHTML 输出完整 document
  → 写入 dist/static，并引用带 hash 的 JS/CSS

生产请求
  → SSGRenderer 直接读取对应 HTML
  → 不再执行业务 GSP
```

静态 HTML 和 `window.__NAMI_DATA__` 必须来自同一快照，浏览器第一次 render 才不会出现 Hydration mismatch。

### 4.5 ISR

```text
首次访问（无缓存）     → MISS  → 阻塞生成并写缓存 → 返回新 HTML
有效期内再次访问       → HIT   → 直接返回缓存
超过 revalidate 后访问 → STALE → 先返回旧 HTML，同时进入重建队列
并发 stale 请求        → 共用同一重建任务，避免击穿
重建完成后的访问       → HIT   → 返回新 Generation ID
```

列表和详情页都配置 8 秒 `revalidate`，并通过 `cacheTags` 暴露 `catalog`、`product` 分类。详情页同时对比“Builder 生成的静态文件”与“ISRManager 的运行时缓存”：目前二者没有启动预热关系，`fallback` 也尚未参与请求分支。

## 5. 可重复实验

以下命令均在 `pnpm start:showcase` 运行期间执行。

### 5.1 SSR 上下文、HTML 与响应头

```bash
curl -sS -D /tmp/nami-ssr.headers \
  -H 'Cookie: nami_session=interview-demo' \
  'http://127.0.0.1:3100/rendering/ssr/interviewer?topic=render-context' \
  -o /tmp/nami-ssr.html

rg -i 'x-nami|cache-control' /tmp/nami-ssr.headers
rg 'interviewer|render-context|__NAMI_DATA__' /tmp/nami-ssr.html
```

预期：状态码 `200`、`X-Nami-Render-Mode: ssr`，HTML 在 JavaScript 执行前就包含业务内容。

### 5.2 Streaming 的 TTFB 与总时间

```bash
curl -sS -N \
  -D /tmp/nami-stream.headers \
  -o /tmp/nami-stream.html \
  -w 'TTFB=%{time_starttransfer}s TOTAL=%{time_total}s\n' \
  http://127.0.0.1:3100/rendering/streaming

rg -i 'transfer-encoding|x-nami-render-mode' /tmp/nami-stream.headers
```

预期：`Transfer-Encoding: chunked`；TTFB 明显早于约 1.4 秒的完整响应时间。

### 5.3 ISR 三态与构建/运行缓存边界

依次执行，不要并行：

```bash
curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/edge-cache
curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/manifest-inspector
curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/edge-cache
curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/manifest-inspector
sleep 9
curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/manifest-inspector
sleep 1
curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/manifest-inspector

curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/not-a-product
curl -sS -D - -o /dev/null http://127.0.0.1:3100/products/not-a-product
```

重点看 `X-Nami-Cache`、`X-Nami-Cache-Age` 与服务端后台重建日志；`X-Nami-Cache-Tags` 当前只在 `MISS` 响应可见。即使 `edge-cache` 有构建文件，它与未枚举的 `manifest-inspector` 在新进程里的第一次请求都是 `MISS`；各自紧接着是 `HIT`。过期后的请求是 `STALE`，重建是异步任务，所以等待约 1 秒后再确认新的 `HIT`。

最后两条未知商品请求刻意展示另一个边界：GSP 返回了 `notFound: true`，但当前 ISRRenderer 丢弃该语义，并把空 props 页面先作为 `200 MISS`、再作为 `200 HIT` 缓存。正确实现应透传 404 且禁止写入成功缓存。

### 5.4 路由优先级、重定向与 notFound

```bash
curl -sS -D - -o /dev/null http://127.0.0.1:3100/routing/new
curl -sS -D - -o /dev/null http://127.0.0.1:3100/routing/42
curl -sS -D - -o /dev/null http://127.0.0.1:3100/redirect
curl -sS -D - -o /dev/null http://127.0.0.1:3100/data-not-found
```

预期：`/routing/new` 带 `X-Nami-Route-Match: static`；动态地址带 `dynamic`；重定向返回 `307`；`notFound` 返回 `404`。

### 5.5 SSG 产物与运行时读取

```bash
find examples/feature-showcase/dist/static -type f | sort
rg '__NAMI_DATA__|nami-root|static/js|static/css' \
  examples/feature-showcase/dist/static/content/index.html
curl -sS -D - -o /dev/null http://127.0.0.1:3100/content
curl -sS -D - -o /dev/null http://127.0.0.1:3100/content/not-generated
```

预期：已生成地址带 `X-Nami-Render-Mode: ssg`，服务端日志显示“静态文件读取成功”。未知 slug 不会临时执行 GSP；当前实现会进入错误隔离并由 Skeleton 插件返回 `200 + X-Nami-Render-Mode: skeleton-fallback`，而不是按 `fallback: false` 返回 404。

### 5.6 自定义 Koa 中间件

```bash
curl -sS http://127.0.0.1:3100/api/showcase/runtime
curl -sS http://127.0.0.1:3100/api/showcase/profile
curl -sS -D - http://127.0.0.1:3100/api/showcase/failure
```

这三个端点由 `ShowcaseLifecyclePlugin.addServerMiddleware` 提供，不依赖页面 Renderer。

## 6. 插件覆盖

| 插件                      | 示例中的真实作用                                                            | 观察位置                            |
| ------------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `showcase:lifecycle`      | 修改构建配置、输出构建日志、注册 Koa API、写响应头、wrapApp、记录客户端事件 | 构建/服务端日志、响应头、`/plugins` |
| `NamiRequestPlugin`       | 安装浏览器请求适配器、缓存、重试、超时                                      | `/client/runtime`                   |
| `NamiSkeletonPlugin`      | 路由加载 fallback、Skeleton 原子组件、渲染错误 HTML                         | `/stability`、未知 SSG、服务端日志  |
| `NamiErrorBoundaryPlugin` | 通过 wrapApp 安装全局边界，捕获逃逸的客户端 render 错误并恢复               | `/stability`                        |
| `NamiMonitorPlugin`       | 收集 render/error/performance 批次并上报本地接口                            | `/plugins`、服务端日志、Network     |

自定义插件的 `enforce: 'pre'` 用于展示顺序语义；`onBeforeRender`、`onAfterRender` 展示并行 Hook；`wrapApp` 展示 waterfall 组合；客户端 Hook 会写入 `window.__NAMI_SHOWCASE_EVENTS__`。

没有混用 `NamiCachePlugin` 与 ISR。前者是通用响应缓存，后者是带重建语义的页面缓存；把二者叠在同一路由上会让 `X-Nami-Cache` 的来源和 stale 行为难以判断。

## 7. 客户端与 Hydration

`entry-client.tsx` 把完整的 `routes`、`plugins`、`config`、loading/error fallback 和 Service Worker URL 交给 `initNamiClient`：

1. 读取并归一化注水数据。
2. 根据是否存在服务端 DOM 选择 `hydrateRoot` 或 `createRoot`。
3. 建立 Router、数据上下文、错误边界和性能采集。
4. 执行 `onClientInit`，完成后执行 `onHydrated`。
5. 路由切换时加载目标 chunk，并触发 `onRouteChange`。

`/client/runtime` 特意区分三种行为：

- `NamiLink` 的 hover/visible 预取主要加载路由 chunk。
- `prefetchRoute(..., { prefetchData: true })` 可以请求数据，但当前要用 `getPrefetchedData` 显式消费缓存。
- `useClientFetch` 与请求插件的 `useRequest` 是两套客户端请求抽象，不替代 SSR 的 GSSP。

顶部主导航使用普通 `<a>` 是有意设计：切换渲染模式时发起真实文档请求，才能准确观察 SSR/SSG/ISR 响应。SPA 导航 API 集中放在 `/client/runtime`，避免把“客户端切换后缺少服务端数据”误认为目标页面的正常首屏路径。

## 8. 构建产物

`pnpm build:showcase` 预期产生：

```text
dist/
├── client/
│   ├── asset-manifest.json
│   └── static/                     # 入口、runtime、路由 chunk、CSS、sw.js
├── server/
│   ├── entry-server.js
│   └── pages/                      # 服务端页面模块
├── static/                         # SSG HTML 与兼容读取路径
└── nami-manifest.json              # 路由与服务端模块清单
```

检查 `asset-manifest.json` 时，应能看到带 hash 的入口和样式；检查页面 chunk 时，应能看到路由级拆分，而不是所有页面只进入一个浏览器 Bundle。

## 9. 当前源码边界与示例中的兼容处理

本节非常重要：这些代码不是额外“炫技”，而是综合示例在当前框架实现上必须诚实处理的协议边界。

1. **SSR 注水 envelope**：部分 SSR/Streaming 路径当前注入裸 `initialData`，而 `initNamiClient` 期望 `{ props, renderMode, routePath }`。`normalizeInjectedData()` 在客户端启动前做兼容包装。
2. **SSG 输出路径**：Builder 为索引页写 `content/index.html`，当前 SSGRenderer 按 `/content` 查找 `content.html`。构建插件 `showcase:ssg-output-compatibility` 生成扁平别名，保证生产运行时可读取。
3. **SSG `fallback: false`**：它会限制 Builder 枚举出的文件，但当前 SSG 请求管线不会把“文件不存在”转换为路由级 404。访问未知 slug 不会运行 GSP，而是进入错误隔离；启用 Skeleton 插件后当前响应是 `200 + X-Nami-Render-Mode: skeleton-fallback`。
4. **ISR 构建文件与运行缓存**：Builder 会为 ISR 的 `getStaticPaths` 结果生成 HTML，但 ISRManager 启动时不读取这些文件预热缓存。新进程中已枚举和未枚举路径都会首次 `MISS`；`fallback` 字段当前也未参与 ISR 请求分支。页面保留该配置，是为了让这个断点可被观察，而不是宣称它已生效。
5. **ISR `notFound` / redirect**：当前 ISRRenderer 只读取 GSP 的 `props`，没有把 `notFound` 或 redirect 传给缓存中间件。未知商品因此被错误地作为 `200 MISS` 渲染并继续缓存为 `200 HIT`；实验保留该路径用于暴露问题，正确修复应返回非 2xx 并禁止缓存。
6. **原生开发管线**：CLI `nami dev` 会覆盖配置端口、绕过 Builder 中应用的 `config.webpack`/`modifyWebpackConfig`，也不执行 SSG 生成，所以无法完整运行本示例。默认 `pnpm dev:showcase` 采用“build + start”的可靠路径但没有 HMR；`dev:hmr` 仅作框架缺口诊断。
7. **Server webpack 虚拟模块**：服务端页面间接引用 `@nami/client` 时需要 `@nami/core-client-shim` 和 `@nami/generated-route-modules` alias；示例在生产 server webpack 配置中补齐。
8. **Streaming 的 React 单例**：Renderer 使用宿主 `react-dom/server`，业务 server bundle 若再打包一份 React 会产生 Hook dispatcher 不一致。示例 externalize React/ReactDOM 家族。
9. **可选 PostCSS loader**：当前 Webpack CSS rule 包含 `postcss-loader`，但仓库依赖未声明它。示例不需要 PostCSS，因此仅移除该 loader，保留 CSS 提取。
10. **staticServe 覆盖缓存头**：静态中间件 defer 到下游后，会对任意 2xx URL 写 `public, no-cache`，即使实际响应来自 SSR/SSG。因此当前看到的 SSR/SSG `Cache-Control` 不是各 Renderer 的最终设计值；ISR 会由后续 Nami 缓存头回写恢复自己的策略。
11. **Skeleton 的两条路径**：正常渲染前 Hook 会计算布局并写入上下文，但 Renderer 尚未自动把这个标记变成页面骨架；发生渲染错误时，`onRenderError` 返回的 `skeleton-fallback` 则会被错误隔离管线消费。客户端 loading fallback、Suspense 和 Skeleton 组件也都真实生效。
12. **Error Boundary 的客户端/服务端边界**：插件通过 `wrapApp` 安装的全局客户端边界已在 `/stability` 提供真实故障按钮；服务端渐进降级标记尚未被内核完整消费，因此示例关闭服务端降级。
13. **插件 `onRequest`**：类型层存在该 Hook，但当前服务端请求管线没有稳定触发点，本示例不伪造它；请求扩展使用 `addServerMiddleware`。
14. **客户端预取数据**：缓存目前不会自动注入目标页面，示例明确调用 `getPrefetchedData`，并在 UI 中提示这一点。
15. **监控去重**：框架客户端已有性能采集入口，Monitor 插件关闭自身 Web Vitals 监听，避免同一指标重复上报。
16. **Server bundle 体积**：页面为同构读取数据而引用了较宽的 `@nami/client` 入口，当前生产构建会出现 server entry/page 约 800 KiB 的性能警告，这是后续做 server-safe 子入口和 tree-shaking 的优化点。
17. **同服务监控端点停机**：Monitor 上报地址也是当前 Koa 服务。优雅停机时 HTTP server 先关闭，最后一个 beacon 可能重试失败；这不影响停机完成，生产环境通常使用独立采集端点。

面试时应区分“框架设计意图”“类型/API 已提供”“当前运行时真正消费”三个层级。这个示例只把已真实执行的能力写成成功路径，并把兼容层集中在入口和配置文件中。

## 10. 手工浏览器验收清单

自动化环境不一定有可用浏览器，提交前请在本机完成一次：

- 打开首页，逐项检查导航和响应式布局。
- 在 `/rendering/csr` 操作计数、表单和浏览器请求。
- 在 SSR 页面刷新，确认 View Source 已有业务文本，控制台无 Hydration warning。
- 在 Streaming 页禁用缓存并观察 Network waterfall，确认内容分两段补齐。
- 在 `/client/runtime` 检查 push/replace/back、NamiLink 预取和两套请求 API。
- 在 `/stability` 分别触发局部/插件全局 render error 和 503 请求，确认边界 reset 与健康请求都能恢复。
- 在 `/plugins` 检查 `onClientInit → onHydrated → onRouteChange` 时间线。
- 查看 Application → Service Workers，确认 `/sw.js` 注册；它不拦截 fetch。
- 检查 Console 没有重复 React、Hydration mismatch 或未捕获 Promise 错误。

## 11. 面试学习路线

1. 先能用 30 秒解释“路由是控制面，RenderContext/RenderResult 是数据面”。
2. 对照五种模式，回答数据何时取、HTML 在哪生成、浏览器如何接管、失败如何处理。
3. 用 SSR 页讲清 GSSP、ModuleLoader、序列化、manifest 和 Hydration。
4. 用 ISR 命令完整演示 MISS/HIT/STALE、后台重建与防击穿。
5. 用插件页讲 Hook 顺序、并行/瀑布语义、错误隔离和销毁。
6. 最后主动说明第 9 节的当前边界与改进方案，这比只背功能列表更能体现你真正读过源码。
