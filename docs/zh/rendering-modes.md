# 渲染模式原理

Nami 的渲染系统由四个正式 `RenderMode` 枚举和一个 SSR 的流式变体组成。源码中的枚举只有 `csr`、`ssr`、`ssg`、`isr` 四种；Streaming SSR 不是独立枚举。服务端 React 元素工厂已是 SSR 的必需依赖，因此是否选择流式变体由 SSR 路由的 `meta.streaming === true` 决定。

读这一章时要先区分三条链路：

1. **HTML 渲染链路**：`renderMiddleware` 匹配路由后创建具体 Renderer，产出页面 HTML。
2. **数据预取 API 链路**：`dataPrefetchMiddleware` 只处理 `GET /_nami/data/*`，返回 JSON，不等同于 HTML 渲染前的数据预取。
3. **构建期静态生成链路**：`NamiBuilder.generateStaticPages()` 在编译后装配 server bundle，并委托 `SSGRenderer.generateStatic()` 为 SSG/ISR 路由写出静态 HTML。

---

## 1. 源码地图

| 主题 | 源码 |
|------|------|
| 渲染模式枚举 | `packages/shared/src/types/render-mode.ts` |
| 渲染上下文和结果 | `packages/shared/src/types/context.ts` |
| 路由数据函数类型 | `packages/shared/src/types/route.ts` |
| 渲染模式常量 | `packages/shared/src/constants/render-modes.ts` |
| 数据注水与安全序列化 | `packages/shared/src/utils/serialize.ts` |
| 渲染器工厂 | `packages/core/src/renderer/index.ts` |
| 渲染器基类 | `packages/core/src/renderer/base-renderer.ts` |
| CSR 渲染器 | `packages/core/src/renderer/csr-renderer.ts` |
| SSR 渲染器 | `packages/core/src/renderer/ssr-renderer.ts` |
| SSG 渲染器 | `packages/core/src/renderer/ssg-renderer.ts` |
| ISR 渲染器 | `packages/core/src/renderer/isr-renderer.ts` |
| Streaming SSR 渲染器 | `packages/core/src/renderer/streaming-ssr-renderer.ts` |
| 服务端渲染中间件 | `packages/server/src/middleware/render-middleware.ts` |
| 路由数据预取 API | `packages/server/src/middleware/data-prefetch-middleware.ts` |
| ISR 缓存中间件 | `packages/server/src/middleware/isr-cache-middleware.ts` |
| 降级管理器 | `packages/core/src/error/degradation.ts` |
| 客户端注水读取 | `packages/client/src/data/data-hydrator.ts` |
| 客户端挂载入口 | `packages/client/src/entry-client.tsx` |
| 构建期 SSG/ISR 生成 | `packages/webpack/src/builder.ts` |

---

## 2. 总览

源码中的 `RenderMode` 定义：

```typescript
export enum RenderMode {
  CSR = 'csr',
  SSR = 'ssr',
  SSG = 'ssg',
  ISR = 'isr',
}
```

相关常量位于 `packages/shared/src/constants/render-modes.ts`：

| 常量 | 值 | 含义 |
|------|----|------|
| `SERVER_RENDER_MODES` | `[SSR, ISR]` | 运行期需要服务端参与的模式 |
| `STATIC_RENDER_MODES` | `[SSG, ISR]` | 构建期需要静态生成的模式 |
| `NEEDS_SERVER_BUNDLE` | `[SSR, SSG, ISR]` | 构建时需要 server bundle 的模式 |

这三个常量解释了一个常见疑问：SSG 运行期可以不做服务端渲染，但构建期仍需要 server bundle 来执行 `getStaticProps`、`getStaticPaths` 或页面渲染函数。

| 特性 | CSR | SSR | SSG | ISR | Streaming SSR |
|------|-----|-----|-----|-----|---------------|
| 是否是 `RenderMode` 枚举 | 是 | 是 | 是 | 是 | 否，属于 SSR 变体 |
| HTML 生成位置 | 请求时生成带临时骨架的 Shell | 每次请求服务端渲染 | 构建期生成 | 构建期 + 运行期重验证 | 每次请求服务端流式渲染 |
| 是否执行页面数据函数 | 服务端不执行 | HTML 链路执行 `getServerSideProps` | 构建期执行 `getStaticProps` | 缓存 miss/重验证执行 `getStaticProps` | 与 SSR 一样执行 `getServerSideProps` |
| 运行期是否需要服务端 | 否 | 是 | 读取静态文件时可不需要 React SSR | 是 | 是 |
| 首屏 HTML 是否已有内容 | 只有临时 loading 骨架，无业务内容 | 是 | 是 | 缓存命中时是 | 是，且可分块返回 |
| 典型缓存 | 短缓存 HTML 壳 | `private, no-cache` | 长缓存静态 HTML | SWR 缓存 | `private, no-cache` |

---

## 3. 渲染入口：`renderMiddleware`

源码位置：`packages/server/src/middleware/render-middleware.ts`

生产请求经过前置中间件后，最终由 `renderMiddleware` 处理页面 HTML：

```text
GET /page
  -> matchConfiguredRoute(ctx.path, config.routes)
  -> createRenderContext(ctx, matchResult, requestId)
  -> RendererFactory.create({ mode, config, ... })
  -> renderer.render(context) 或 renderer.renderToStream(context)
  -> applyPluginExtras(ctx, context, result)
  -> setResponse(ctx, result)
```

它只处理 `GET` 和 `HEAD`。其他方法直接 `await next()`。

### 路由匹配

`renderMiddleware` 默认使用 `matchConfiguredRoute()`。该函数位于 `packages/server/src/middleware/route-match.ts`，内部复用 `@nami/core` 的 `rankRoutes + matchPath`。这个匹配器也被 `dataPrefetchMiddleware` 和 `isrCacheMiddleware` 使用，避免三条链路匹配出不同路由。

### `RenderContext`

`createRenderContext()` 会为每次请求创建新的 `RenderContext`：

| 字段 | 来源 |
|------|------|
| `url` / `path` | Koa `ctx.url` / `ctx.path` |
| `query` | Koa `ctx.query`，只保留字符串或字符串数组 |
| `headers` | 请求头，小写 key |
| `route` | 命中的 `NamiRoute` |
| `params` | 动态路由参数 |
| `koaContext` | method、path、url、querystring、protocol、ip、origin、hostname、secure、cookies |
| `timing.startTime` | 创建上下文时的时间 |
| `requestId` | `requestContextMiddleware` 注入的请求 ID |
| `extra` | 每个请求独立的新对象 `{}`，供插件写入扩展字段 |

`extra` 是请求级对象，不跨请求共享。

### 选择渲染器

渲染模式取自：

```typescript
const renderMode = matchResult.route.renderMode || config.defaultRenderMode;
```

然后调用 `RendererFactory.create()`。对于 SSR，`renderMiddleware` 会额外传入：

```typescript
preferStreaming:
  renderMode === RenderMode.SSR && matchResult.route.meta?.streaming === true
```

`renderMiddleware` 把这项路由配置映射成 `preferStreaming`，`RendererFactory` 据此返回 `StreamingSSRRenderer`；未开启时返回普通 `SSRRenderer`。`appElementFactory` 不再是额外的流式分支条件，因为它本来就是所有 SSR 渲染器的必需参数。

### 流式响应选择

`renderMiddleware` 只有在以下条件同时满足时才调用 `renderToStream()`：

```typescript
renderMode === RenderMode.SSR
  && matchResult.route.meta?.streaming === true
  && ctx.method !== 'HEAD'
  && typeof streamingRenderer.renderToStream === 'function'
```

否则调用 `renderer.render(context)`。因此 `HEAD` 请求即使配置了 streaming，也不会输出流式 body。

---

## 4. 渲染器公共契约

源码位置：`packages/core/src/renderer/base-renderer.ts`

所有渲染器都继承 `BaseRenderer`，必须实现：

| 方法 | 作用 |
|------|------|
| `render(context)` | 把 `RenderContext` 转成 `RenderResult` |
| `prefetchData(context)` | 执行该模式的数据预取 |
| `getMode()` | 返回当前渲染模式 |

公共输出由 `createDefaultResult()` 统一生成：

```typescript
{
  html,
  statusCode,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Nami-Render-Mode': mode,
    'X-Nami-Render-Duration': String(duration),
    ...customHeaders,
  },
  cacheControl,
  meta,
}
```

`meta` 中包含：

| 字段 | 含义 |
|------|------|
| `renderMode` | 实际渲染模式 |
| `duration` | 总耗时 |
| `degraded` | 是否发生降级 |
| `degradeReason` | 降级原因 |
| `dataFetchDuration` | 数据预取耗时 |
| `renderDuration` | React 渲染耗时 |
| `cacheHit` / `cacheStale` | ISR 缓存状态 |

### 插件钩子

渲染器通过 `BaseRenderer.callPluginHook()` 触发插件钩子。传入的是短名：

| Renderer 内短名 | `PluginManager.callHook()` 映射到 |
|-----------------|-----------------------------------|
| `beforeRender` | `onBeforeRender` |
| `afterRender` | `onAfterRender` |
| `renderError` | `onRenderError` |

`renderMiddleware` 不再重复触发这些钩子，避免同一个生命周期执行两次。

---

## 5. CSR

源码位置：`packages/core/src/renderer/csr-renderer.ts`

CSR 的服务端工作只是生成 HTML 壳：

```text
CSRRenderer.render()
  -> callPluginHook('beforeRender')
  -> generateShellHTML()
  -> createDefaultResult(..., RenderMode.CSR)
  -> callPluginHook('afterRender')
```

HTML 壳包含：

1. `<!DOCTYPE html>`、`meta charset`、`viewport`
2. 标题和描述
3. `<meta name="renderer" content="csr">`
4. CSS 资源链接
5. 含 `data-nami-csr-shell="loading"` 临时骨架的 `<div id="nami-root">...</div>`
6. 客户端 JS Bundle

临时骨架覆盖 Bundle 下载、客户端初始化和 React 首次提交前的等待时间；客户端 JS 成功运行后会替换根容器内容。它与 Level 3 无 JS 静态应急页不是同一类状态。

CSR 不在服务端执行页面数据函数：

```typescript
async prefetchData() {
  return { data: {}, errors: [], degraded: false, duration: 0 };
}
```

未声明 GSP `revalidate` 时的默认响应缓存：

```http
Cache-Control: public, max-age=60, s-maxage=120
```

CSR 是渲染器降级链的终点，`createFallbackRenderer()` 返回 `null`。

适用场景：

| 场景 | 原因 |
|------|------|
| 管理后台 | 通常不需要 SEO |
| 登录后页面 | 内容依赖用户态，首屏 SEO 价值低 |
| 内部工具 | 低服务端成本优先 |
| SSR/ISR 失败兜底 | 至少让客户端 JS 接管 |

---

## 6. SSR

源码位置：`packages/core/src/renderer/ssr-renderer.ts`

SSR 每次请求都在服务端执行数据预取和 React 渲染：

```text
SSRRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> withTimeout(executeSSR(), config.server.ssrTimeout)
       -> prefetchData(context)
       -> context.initialData = prefetchResult.data
       -> renderAppHTML(context)
       -> assembleHTML(renderedHTML, context)
       -> createDefaultResult(..., RenderMode.SSR)
  -> callPluginHook('afterRender')
```

### 服务端入口协议

SSR 只有一种服务端渲染入口协议：

| 入口 | 说明 |
|------|------|
| `entry-server.createAppElement(context)` | 返回 React 元素；CLI 将其解析为内部的 `appElementFactory`，框架再调用 `react-dom/server` |

应用负责依据 `context.route`、`context.params` 和 `context.initialData` 选择页面并创建元素树；框架负责普通 SSR/SSG/ISR 的 `renderToString()`、Streaming SSR 的流式输出，以及后续的 Document 组装，不再接受由应用直接返回 HTML 字符串的平行协议。

### 数据预取

`prefetchData()` 只在路由声明了 `getServerSideProps` 时执行。函数通过 `moduleLoader.getExportedFunction(route.component, route.getServerSideProps)` 从 server bundle 读取。

传入 `getServerSideProps` 的上下文：

| 字段 | 来源 |
|------|------|
| `params` | 路由动态参数 |
| `query` | 请求 query |
| `headers` | 请求头 |
| `path` | 请求 pathname |
| `url` | 完整 URL |
| `cookies` | `context.koaContext?.cookies ?? {}` |
| `requestId` | 请求 ID |

当前 HTML 渲染链路中，`SSRRenderer` 会先执行 `getServerSideProps`。如果返回 `redirect` 或 `notFound`，渲染器会在 React 渲染前短路，分别返回 30x 或稳定的静态 404；否则才把 `result.props ?? {}` 作为页面数据继续组装 HTML。默认 404 不注入 Hydration 数据或客户端 Bundle，避免空根节点在浏览器中重新 CSR 渲染原业务页。Streaming SSR 也会在开始流式输出前处理这类早期结果，避免已经写出 shell 后再尝试改状态码。

### HTML 组装与注水

React 页面片段生成后，框架始终通过 `assembleHTML()` 组装完整 Document：

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  ...
  <meta name="renderer" content="ssr">
  CSS links
</head>
<body>
  <div id="nami-root">React HTML</div>
  <script>window.__NAMI_DATA__=...</script>
  client JS scripts
</body>
</html>
```

注水脚本由 `packages/shared/src/utils/serialize.ts` 的 `generateDataScript()` 生成。它调用 `safeStringify()`，会把 `<`、`>`、`/`、`\u2028`、`\u2029` 转义为 Unicode 序列，避免 `</script>` 等内容截断脚本产生 XSS。

### 超时与错误

完整 SSR 流程被：

```typescript
withTimeout(this.executeSSR(...), this.ssrTimeout, ...)
```

包裹。`ssrTimeout` 来自 `config.server.ssrTimeout`，默认值在 `DEFAULT_SERVER_CONFIG` 中是 `5000ms`。超时或异常会被包装成 `RenderError` 抛给 `renderMiddleware`，再由 `renderMiddleware` 尝试降级。

默认缓存：

```http
Cache-Control: private, no-cache
```

---

## 7. SSG

源码位置：

- `packages/core/src/renderer/ssg-renderer.ts`
- `packages/webpack/src/builder.ts`

SSG 分为构建期和运行期。

### 构建期

当前 `nami build` 由 `NamiBuilder.generateStaticPages()` 发起静态生成，并直接复用 `SSGRenderer.generateStatic()`：

```text
nami build
  -> client/server Webpack 编译完成
  -> generateStaticPages(routes)
       -> 读取 dist/server/entry-server.js
       -> 校验并解析 createAppElement(context)
       -> 创建 ModuleLoader
       -> 读取 asset-manifest.json
       -> SSGRenderer.generateStatic(routes)
            -> 动态路由执行 getStaticPaths()
            -> 每个 path 执行 getStaticProps()
            -> createAppElement(context) → renderToString()
            -> 组装完整 Document、资源和注水数据
            -> 写入 dist/static 对应的 .html 与 .html.nami.json
```

静态路由直接生成一个路径；动态路由必须声明且能通过 `ModuleLoader` 解析
`getStaticPaths`。缺少声明、找不到导出或数据预取降级都会记入该路由的生成错误，
其余路由继续生成，最终由 Builder 汇总到构建结果。

这里的“动态”覆盖匹配器的完整段语法，而不只是裸 `:param`：

| 路由 token | `getStaticPaths.params` 键 | 值形态 |
|------------|----------------------------|--------|
| `:id` | `id` | 单个非空路径段 |
| `:id?` | `id`，可省略 | 可选单段 |
| `:id(\\d+)` | `id` | 必须满足约束 |
| `:path+` | `path` | 一个或多个 `/` 分隔段 |
| `*` | `'*'` | 非空剩余路径 |
| `(.*)` | `$0`（后续组依次 `$1`） | 可为空的多段值 |

构建期先把 params materialize 为逐段编码的 canonical URL，再用正式
`matchPath(route.path, url, { exact: true })` 做参数 round-trip。缺少必填参数、
参数类型错误、单段值含 `/`、不满足约束或生成 URL 无法精确匹配都会成为页面
生成错误；不同路由/params 若最终落到同一个绝对静态产物路径，也会报碰撞并使
build 失败。这些校验没有引入新的 URL→文件格式，映射仍是 `/` →
`index.html`、`/about` → `about.html`、`/blog/hello` →
`blog/hello.html`。

构建期不再尝试页面级 `render`、默认组件或最小 shell 等平行协议。它与 SSR/ISR 共享 `createAppElement(context)`，由框架统一掌控渲染与 Document，从而保证构建产物和运行期输出的资源、数据及挂载容器一致。

输出路径是：

```text
dist/static/index.html
dist/static/index.html.nami.json
dist/static/about.html
dist/static/about.html.nami.json
dist/static/blog/hello.html
dist/static/blog/hello.html.nami.json
```

`*.html.nami.json` 是响应 sidecar，记录版本、`page | redirect | not-found`
类型、状态码、响应头与可选 `revalidate`。运行期同时读取 HTML
和 sidecar，所以构建期 GSP 的 30x/404 不会被还原成 200；旧产物没有
sidecar 时仍按普通 200 SSG 页兼容，sidecar 存在但损坏则直接报错。
GSP 显式 redirect status 只允许 `301/302/303/307/308`；未显式设置时
permanent 解析为 `308`，临时重定向为 `307`。

### 运行期

`SSGRenderer.render()` 的运行期逻辑是读取静态文件：

```text
SSGRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> materializeStaticRoutePath(route.path, context.params)
  -> matchPath(..., { exact: true }) round-trip
  -> resolveStaticFilePath(canonicalPath)
  -> fileReader.readFile(filePath)
  -> readStaticPageMetadata(filePath)
  -> createDefaultResult(..., RenderMode.SSG)
  -> callPluginHook('afterRender')
```

动态 SSG 路由配置 `fallback: false` 时，未生成路径直接返回稳定静态
404，不注入 Hydration payload 或客户端 Bundle。其他静态文件缺失仍抛出
`RenderError`，上层进入降级流程。

`getStaticPaths.fallback` 当前支持矩阵：

| 模式 | 支持值 | 未预生成路径 |
|------|--------|------------------|
| SSG | `false` | 稳定静态 404 |
| ISR | `'blocking'` | 冷 `MISS`，同步执行 GSP + React 渲染并写入 CacheStore |

`true` 以及 SSG/ISR 的其他组合尚未实现；路由配置与
`getStaticPaths()` 返回值不一致或使用不支持的值时，构建直接记录生成错误。

默认响应缓存：

```http
Cache-Control: public, max-age=3600, s-maxage=86400
```

若 GSP 显式返回 `revalidate`（包括合法的 `0`），构建期会把对应
`s-maxage` / `stale-while-revalidate` 写入 sidecar，运行期使用该页面自己的值。

### `SSGRenderer.generateStatic()`

`SSGRenderer` 实现 `generateStatic(routes)`、`getStaticPaths`、`getStaticProps` 等构建能力。`NamiBuilder.generateStaticPages()` 负责装配 server bundle、`ModuleLoader`、asset manifest 和输出目录，然后调用它；二者现在是同一条主链路，而不是两套静态生成实现。

---

## 8. ISR

源码位置：

- `packages/server/src/middleware/isr-cache-middleware.ts`
- `packages/server/src/isr/isr-manager.ts`
- `packages/server/src/isr/stale-while-revalidate.ts`
- `packages/core/src/renderer/isr-renderer.ts`

ISR 是 SSG 与 SSR 的组合：页面结果可以被缓存，缓存过期后通过重验证更新。

### 默认生产链路

默认服务端链路中，缓存命中和后台重验证由 `isrCacheMiddleware` 处理：

```text
GET /article/1
  -> isrCacheMiddleware
       -> 只处理 GET
       -> 跳过 x-nami-isr-revalidate: 1 的内部请求
       -> matchConfiguredRoute(ctx.path, config.routes)
       -> route.renderMode === ISR && config.isr.enabled ?
       -> isrManager.getOrRevalidate(...)
```

默认缓存键是：

```typescript
ctx.url
```

这意味着默认 ISR 缓存层包含 pathname 与原始 query，但不包含 Cookie、Header 或租户身份，query 顺序也不会归一化。页面内容依赖额外维度或需要忽略营销参数时，应自定义 `generateCacheKey()`；需要失效同一路径的多个 URL 变体时使用 tag。

### SWR 状态

`ISRManager.getOrRevalidate()` 使用 `evaluateCacheFreshness()` 判断缓存状态：

```text
0 ───────────── revalidateAfter ───────────── revalidateAfter * staleMultiplier ─────▶
      Fresh                      Stale                                  Expired
```

默认 `staleMultiplier = 2`。

| 状态 | 行为 |
|------|------|
| `Fresh` | 直接返回缓存，`X-Nami-Cache: HIT` |
| `Stale` | 返回旧 HTML，后台发起内部重验证，`X-Nami-Cache: STALE` |
| `Expired` | 不返回旧 HTML，走同步渲染 |
| Miss | 同步渲染，等待缓存写入完成后再释放同 key singleflight |

有效 `revalidate = 0` 是旁路持久 ISR 缓存的特殊分支：不读取或写入
CacheStore，尽力删除旧 key，仅允许当前 Node 进程内的同 key in-flight Promise
合并。它不会生成一个 TTL=0 的持久条目。

后台重验证通过内部请求实现，请求头包含：

```http
x-nami-isr-revalidate: 1
X-Requested-With: nami-isr-revalidate
```

带该头的请求会绕过 `isrCacheMiddleware`，直接进入渲染层，避免后台重验证再次命中 stale 缓存。

普通成功页的冷渲染与后台重建都会把安全过滤后的 `statusCode` / 端到端 headers
写入 `CacheEntry` 并基于 HTML 生成 ETag，HIT/STALE 会恢复这些字段。后台若
得到合法 GSP redirect 或 `404 notFound`，会删除旧 key 且不缓存控制响应；
降级/普通失败才保留旧 stale。同步 singleflight 与后台队列去重都只在单进程
内有效，队列 `Promise.race()` 超时也只停止等待，不会取消底层 render/fetch。

### `ISRRenderer`

`ISRRenderer` 的职责不是处理缓存命中，而是在缓存 miss 或重验证时生成新的 HTML：

```text
ISRRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> handleCacheMiss()
       -> prefetchData(context)  // getStaticProps
       -> context.initialData = props
       -> redirect/notFound? 30x/404 + no-store 短路
       -> renderAppHTML(context)
       -> ensureDocumentHTML(...)
       -> createDefaultResult(..., RenderMode.ISR, cacheControl)
  -> callPluginHook('afterRender')
```

`prefetchData()` 执行的是 `getStaticProps`，不是 `getServerSideProps`。

ISRRenderer 返回的 `cacheControl` 包含：

```typescript
{
  revalidate: effectiveRevalidate,
  staleWhileRevalidate: effectiveRevalidate * 2,
  tags: extractCacheTags(context),
}
```

标签来源有两类：

| 来源 | 字段 |
|------|------|
| 路由配置 | `route.meta.cacheTags` |
| 插件或业务写入 | `context.extra.cacheTags` |

`isrCacheMiddleware` 与 `ISRRenderer.buildCacheKey()` 现在统一使用完整请求 URL（pathname + query），客户端 Hydration 的 `routePath` 也采用同一作用域。默认不会归一化 query 顺序，也不会纳入 Cookie、Header 或租户身份；需要其他缓存维度时应自定义 `generateCacheKey()`。

---

## 9. Streaming SSR

源码位置：

- `packages/core/src/renderer/streaming-ssr-renderer.ts`
- `packages/server/src/middleware/render-middleware.ts`
- `packages/core/src/renderer/index.ts`

Streaming SSR 基于 React 18 的 `renderToPipeableStream()`。它不是单独渲染模式，而是 SSR 的执行变体：

```typescript
{
  path: '/large-page',
  component: './pages/large-page',
  renderMode: RenderMode.SSR,
  meta: { streaming: true },
}
```

### 创建条件

`RendererFactory` 只有在以下条件成立时创建 `StreamingSSRRenderer`：

```typescript
mode === RenderMode.SSR
  && preferStreaming
```

其中 `preferStreaming` 来自路由 `meta.streaming === true`。`appElementFactory` 已是 SSR 创建时的必需参数，因此无需再作为分支条件；Streaming SSR 与普通 SSR 始终消费同一个 `createAppElement(context)` 返回的 React 元素树。

### `render()` 与 `renderToStream()`

`StreamingSSRRenderer` 有两个入口：

| 方法 | 行为 | 是否真正流式传输 |
|------|------|------------------|
| `render()` | 使用 `renderToPipeableStream()`，但收集完整字符串后返回 | 否 |
| `renderToStream()` | 返回 `StreamingRenderResult.stream`，由 Koa 设置为 `ctx.body` | 是 |

真正对浏览器逐块传输的是 `renderToStream()`。

### 流式响应流程

```text
renderToStream(context)
  -> callPluginHook('beforeRender')
  -> prefetchData(context)
  -> context.initialData = props
  -> buildHTMLShell(context)
       -> headHTML: doctype/head/body/<div id="nami-root">
       -> tailHTML: </div> + data script + JS + </body></html>
  -> renderToPipeableStream(appElement)
       -> onShellReady: 写 headHTML，然后 pipe React 内容
       -> onAllReady: 标记渲染完成
       -> passThrough end 后写 tailHTML
  -> 返回 { isStreaming: true, stream }
```

Nami 当前实现会先完成路由级 `prefetchData()`，再开始 `renderToPipeableStream()`。因此 Streaming SSR 的收益主要来自 React 渲染阶段和网络传输阶段，而不是把 `getServerSideProps` 本身流式化。

### 超时与降级

Streaming SSR 有两个超时概念：

| 超时 | 默认/来源 | 作用 |
|------|-----------|------|
| `ssrTimeout` | `config.server.ssrTimeout` | 包裹整个 `render()` 流程 |
| `streamTimeout` | 默认 `10000ms` | shell 长时间未 ready 时调用 `abort()` |

`createFallbackRenderer()` 会返回普通 `SSRRenderer`，形成渲染器级降级链：

```text
Streaming SSR -> SSR -> CSR
```

但在默认 `renderMiddleware` 的 catch 分支中，实际降级主要由 `DegradationManager.executeWithDegradation()` 接管。

---

## 10. 数据注水与客户端挂载

### 服务端注入

SSR、ISR、Streaming SSR 和构建期 SSG 的正常可注水 HTML 都使用同一个注水结构：

```html
<script>window.__NAMI_DATA__={...}</script>
```

变量名来自 `packages/shared/src/constants/defaults.ts`：

```typescript
export const NAMI_DATA_VARIABLE = '__NAMI_DATA__';
```

所有需要客户端 Hydration 的正常服务端 HTML 输出都调用 `BaseRenderer.createHydrationData(context)`，再由
`generateDataScript()` 安全序列化：

```typescript
{
  version: NAMI_DATA_PROTOCOL_VERSION,
  props: context.initialData ?? {},
  degraded: context.extra.__nami_data_degraded === true,
  renderMode: context.route.renderMode,
  // SSG 按构建产物 pathname 复用；SSR/ISR 精确绑定 pathname + query
  routePath: context.route.renderMode === RenderMode.SSG
    ? context.path
    : context.url,
}
```

因此页面数据与渲染元信息有稳定边界，SSR、Streaming SSR、SSG 和 ISR 不再各自决定注入形状。

### 客户端读取

客户端读取位于 `packages/client/src/data/data-hydrator.ts`：

```typescript
const rawData = hydrateData<ServerInjectedData>(NAMI_DATA_VARIABLE);
cachedData = normalizeServerData(rawData);
```

客户端挂载入口位于 `packages/client/src/entry-client.tsx`：

```typescript
const serverData = readServerData();
const renderMode = (serverData.renderMode || config.defaultRenderMode) as RenderMode;

<NamiApp
  initialData={serverData.props}
  initialDataDegraded={serverData.degraded}
  initialRoutePath={serverData.routePath}
  initialRenderMode={serverData.renderMode}
/>
```

客户端与服务端现在消费同一个 envelope：`serverData.props` 作为页面首屏数据，
`serverData.renderMode` 决定挂载方式，`serverData.routePath` 保存首屏路由。

### Hydration vs CSR 挂载

客户端仅在协议版本兼容、`renderMode !== 'csr'` 且容器已有子节点时 Hydration：

| 条件 | 挂载方式 |
|------|----------|
| `version === NAMI_DATA_PROTOCOL_VERSION`、非 CSR 且容器非空 | `hydrateApp()`，复用服务端 HTML |
| 协议不兼容、CSR 或容器为空 | `renderApp()`，客户端创建 DOM |

Hydration 完成后会调用 `cleanupServerData()`，删除 `window.__NAMI_DATA__` 并移除对应 script 标签，但首次读取的数据会保存在模块级缓存中。

---

## 11. 数据预取 API 与 HTML 链路的区别

源码位置：`packages/server/src/middleware/data-prefetch-middleware.ts`

`/_nami/data/*` 是客户端路由预取 JSON 的 API，不是 HTML 渲染的入口。

```text
GET /_nami/data/blog/hello
  -> dataPrefetchMiddleware
  -> matchConfiguredRoute('/blog/hello')
  -> SSR: 执行 getServerSideProps
  -> SSG/ISR: 执行 getStaticProps
  -> 返回 JSON / 204 / 404 / redirect 信息
```

与 HTML 链路相比：

| 行为 | HTML 渲染链路 | 数据预取 API |
|------|--------------|--------------|
| SSR 数据函数 | `SSRRenderer.prefetchData()` | `dataPrefetchMiddleware` 执行 |
| SSG/ISR 数据函数 | 构建期或 ISR miss/revalidate 执行 | `dataPrefetchMiddleware` 执行 |
| `redirect` / `notFound` | SSR / Streaming SSR 在请求期短路；SSG 构建控制文档与 sidecar；GSP 显式 redirect 仅允许 301/302/303/307/308；ISR 冷 MISS 返回控制响应，后台重建则删旧 key，两者都不缓存控制响应 | API 使用显式 `statusCode` 或默认 307/308，`notFound` 为 404 |
| 返回内容 | HTML / stream | JSON 或 204 |
| 路径前缀 | 页面原始路径 | `/_nami/data` |

---

## 12. 降级策略

源码位置：

- `packages/server/src/middleware/render-middleware.ts`
- `packages/core/src/error/degradation.ts`

`renderMiddleware` 将首次渲染交给 `DegradationManager`，由它统一执行：

| 等级 | 条件 | 返回 |
|------|------|------|
| Level 0 | 首次渲染成功 | 原始渲染结果 |
| Level 1 | `config.maxRetries > 0` | 重试后的结果 |
| Level 2 | `config.ssrToCSR` | 带临时骨架和客户端 JS 的 CSR Shell |
| Level 3 | 插件静态应急内容或 `context.route.skeleton` | 无客户端 JS 的静态应急页（兼容名 Skeleton） |
| Level 4 | `config.staticHTML` 存在 | 静态 HTML |
| Level 5 | 全部失败 | 503 页面 |

注意：`__csr_shell_skeleton` 属于正常/降级 CSR 的可恢复 loading；Level 3 的插件内容不会越过 Level 1/2，且 `context.route.skeleton` 当前只是触发内置静态应急 HTML 的条件，不会加载组件文件。路由 Chunk 与业务数据的骨架属于客户端 loading，不属于 Level 3。

---

## 13. 选型建议

| 页面特征 | 推荐模式 |
|----------|----------|
| 不需要 SEO，登录后使用，强用户态 | CSR |
| 需要 SEO，数据每次请求都要最新 | SSR |
| 内容几乎不变，适合 CDN 分发 | SSG |
| 内容会更新，但允许分钟级延迟 | ISR |
| 页面很大，使用 Suspense，希望更早输出 shell | SSR + `meta.streaming: true` |

决策路径：

```text
是否需要 SEO？
  否 -> CSR
  是 -> 数据是否必须每次请求实时？
          是 -> 页面是否适合流式输出？
                  是 -> SSR + streaming
                  否 -> SSR
          否 -> 内容是否只在发布时变化？
                  是 -> SSG
                  否 -> ISR
```

---

## 14. 常见误区

### 误区一：Streaming SSR 是第五个 `RenderMode`

不是。源码的 `RenderMode` 枚举只有四个值。Streaming SSR 是 SSR 路由在满足条件时由 `RendererFactory` 选择的实现。

### 误区二：SSG 完全不需要 server bundle

运行期可以不做服务端渲染，但构建期需要 server bundle 执行页面模块、`getStaticProps`、`getStaticPaths`，并通过 `createAppElement(context)` 生成 React 元素树。这也是 `NEEDS_SERVER_BUNDLE` 包含 SSG 的原因。

### 误区三：`/_nami/data/*` 就是 SSR 的数据预取流程

不是。它是客户端路由预取 JSON 的 API。HTML SSR 请求的数据预取发生在 `SSRRenderer.prefetchData()` 中。

### 误区四：所有渲染模式都会以同样方式处理 `redirect` / `notFound`

不是执行时机相同，但控制语义已统一：SSR / Streaming SSR 把 GSSP
结果在请求期短路为 30x/404；SSG 把 GSP 结果写成重定向/静态 404 HTML
与 sidecar，运行期恢复状态码和头；GSP 显式 redirect status 限于
`301/302/303/307/308`。ISR 冷 MISS 直接返回控制响应，并以
`X-Nami-Cache: SKIP` + `private, no-store` 禁止缓存；后台内部重建遇到控制响应
时携带 `private, no-store` 并驱动队列删除旧 key，原用户响应仍标记为 `STALE`。
降级/普通失败与控制响应不同，会保留旧 stale。

### 误区五：ISR 的完整 URL 缓存键会自动归一化 query

不会。默认 key 是原始完整 URL，所以 `?a=1&b=2` 与 `?b=2&a=1` 是两个条目；它也不包含 Cookie、Header 或租户身份。需要其他语义时应自定义 `generateCacheKey()`。

### 误区六：`window.__NAMI_DATA__` 只是页面 props

不是。对正常可注水输出，框架统一注入 `{ version: 1, props, degraded, renderMode, routePath }`。页面消费
`props` 和可选的降级状态；客户端用 `version` 做协议兼容判断，并用渲染模式与路径
选择 Hydration/CSR 挂载、限定首屏数据作用域。应用入口不应自行覆盖这一结构。稳定静态 404 是例外，不注入该结构或客户端 Bundle。

---

## 下一步

- 服务端中间件顺序：阅读 [服务器与中间件](./server-and-middleware.md)
- ISR 缓存存储与失效：阅读 [ISR 与缓存](./isr-and-caching.md)
- 构建期双 Bundle 与静态生成：阅读 [构建系统](./webpack-build.md)
