# 渲染模式原理

Nami 的渲染系统由四个正式 `RenderMode` 枚举和一个 SSR 的流式变体组成。源码中的枚举只有 `csr`、`ssr`、`ssg`、`isr` 四种；Streaming SSR 不是独立枚举，而是 SSR 路由在 `meta.streaming === true` 且运行时具备 `appElementFactory` 时选择的渲染器变体。

读这一章时要先区分三条链路：

1. **HTML 渲染链路**：`renderMiddleware` 匹配路由后创建具体 Renderer，产出页面 HTML。
2. **数据预取 API 链路**：`dataPrefetchMiddleware` 只处理 `GET /_nami/data/*`，返回 JSON，不等同于 HTML 渲染前的数据预取。
3. **构建期静态生成链路**：`NamiBuilder.generateStaticPages()` 在 `nami build` 后读取 server bundle，为 SSG/ISR 路由写出静态 HTML。

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
| HTML 生成位置 | 请求时生成空壳 | 每次请求服务端渲染 | 构建期生成 | 构建期 + 运行期重验证 | 每次请求服务端流式渲染 |
| 是否执行页面数据函数 | 服务端不执行 | HTML 链路执行 `getServerSideProps` | 构建期执行 `getStaticProps` | 缓存 miss/重验证执行 `getStaticProps` | 与 SSR 一样执行 `getServerSideProps` |
| 运行期是否需要服务端 | 否 | 是 | 读取静态文件时可不需要 React SSR | 是 | 是 |
| 首屏 HTML 是否已有内容 | 否 | 是 | 是 | 缓存命中时是 | 是，且可分块返回 |
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

真正是否创建 `StreamingSSRRenderer` 还要看 `RendererFactory`：只有 `preferStreaming === true` 且存在 `appElementFactory` 时，才会返回流式渲染器；否则仍返回普通 `SSRRenderer`。

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
5. 空容器 `<div id="nami-root"></div>`
6. 客户端 JS Bundle

CSR 不在服务端执行页面数据函数：

```typescript
async prefetchData() {
  return { data: {}, errors: [], degraded: false, duration: 0 };
}
```

默认响应缓存：

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
       -> ensureDocumentHTML(renderedHTML, context)
       -> createDefaultResult(..., RenderMode.SSR)
  -> callPluginHook('afterRender')
```

### 服务端入口协议

SSR 支持两种服务端渲染入口：

| 入口 | 说明 |
|------|------|
| `htmlRenderer(context, initialData)` | 兼容 `entry-server.renderToHTML()`，直接返回 HTML 字符串 |
| `appElementFactory(context)` | 返回 React 元素，框架内部动态导入 `react-dom/server` 并调用 `renderToString()` |

`renderAppHTML()` 优先使用 `htmlRenderer`。如果没有 `htmlRenderer`，才使用 `appElementFactory`。

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

当前 HTML 渲染链路中，SSRRenderer 会把 `result.props ?? {}` 作为页面数据。它会在日志里记录 `redirect` / `notFound` 是否存在，但 HTML 链路没有把它们转换成 307/404 响应；`redirect` / `notFound` 的 HTTP 语义目前体现在 `dataPrefetchMiddleware` 的 JSON API 链路中。

### HTML 组装与注水

如果 `htmlRenderer` 返回的是完整 HTML 文档，`ensureDocumentHTML()` 直接透传；否则 `assembleHTML()` 组装文档：

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

当前 `nami build` 的静态生成主要由 `NamiBuilder.generateStaticPages()` 完成，而不是单独执行 `SSGRenderer.generateStatic()`：

```text
nami build
  -> client/server Webpack 编译完成
  -> generateStaticPages(routes)
       -> 读取 dist/server/entry-server.js
       -> 创建 ModuleLoader
       -> 遍历 SSG/ISR 路由
       -> 动态路由执行 getStaticPaths()
       -> 每个 path 执行 getStaticProps()
       -> renderToHTML / pageModule.render / pageModule.default / 兜底 shell
       -> 写入 dist/static/{path}/index.html
```

对于动态路由，`generateStaticPages()` 只在 `route.path.includes(':') && route.getStaticPaths` 时执行 `getStaticPaths`。如果动态路由找不到对应函数，会记录 warn 并跳过该路由。

构建期渲染策略按优先级：

| 优先级 | 条件 | 行为 |
|--------|------|------|
| 1 | `serverBundle.renderToHTML` 是函数 | 调用 `renderToHTML(actualPath, props)` |
| 2 | `pageModule.render` 是函数 | 调用 `pageModule.render({ path, props })` |
| 3 | `pageModule.default` 是函数 | `React.createElement(default, props)` 后 `renderToString()` |
| 4 | 都不存在 | 生成带 `window.__NAMI_DATA__` 的最小 HTML 壳 |

输出路径是：

```text
dist/static/index.html
dist/static/about/index.html
dist/static/blog/hello/index.html
```

### 运行期

`SSGRenderer.render()` 的运行期逻辑是读取静态文件：

```text
SSGRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> resolveStaticFilePath(context.path)
  -> fileReader.readFile(filePath)
  -> createDefaultResult(..., RenderMode.SSG)
  -> callPluginHook('afterRender')
```

静态文件不存在时抛出 `RenderError`，上层进入降级流程。

默认响应缓存：

```http
Cache-Control: public, max-age=3600, s-maxage=86400
```

### `SSGRenderer.generateStatic()`

`SSGRenderer` 自身也实现了 `generateStatic(routes)`、`getStaticPaths`、`getStaticProps` 等构建能力，但当前 CLI 构建主链路使用的是 `NamiBuilder.generateStaticPages()`。文档和排查时应以 Builder 链路为准。

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
ctx.path
```

这意味着默认 ISR 缓存层不包含 query、Cookie 或 Header。如果页面内容依赖这些因素，需要自定义缓存键，否则不同变体可能共用同一份缓存。

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
| Miss | 同步渲染并异步写入缓存 |

后台重验证通过内部请求实现，请求头包含：

```http
x-nami-isr-revalidate: 1
X-Requested-With: nami-isr-revalidate
```

带该头的请求会绕过 `isrCacheMiddleware`，直接进入渲染层，避免后台重验证再次命中 stale 缓存。

### `ISRRenderer`

`ISRRenderer` 的职责不是处理缓存命中，而是在缓存 miss 或重验证时生成新的 HTML：

```text
ISRRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> handleCacheMiss()
       -> prefetchData(context)  // getStaticProps
       -> context.initialData = props
       -> renderAppHTML(context)
       -> ensureDocumentHTML(...)
       -> createDefaultResult(..., RenderMode.ISR, cacheControl)
  -> callPluginHook('afterRender')
```

`prefetchData()` 执行的是 `getStaticProps`，不是 `getServerSideProps`。

ISRRenderer 返回的 `cacheControl` 包含：

```typescript
{
  revalidate,
  staleWhileRevalidate: revalidate * 2,
  tags: extractCacheTags(context),
}
```

标签来源有两类：

| 来源 | 字段 |
|------|------|
| 路由配置 | `route.meta.cacheTags` |
| 插件或业务写入 | `context.extra.cacheTags` |

需要区分两套缓存键逻辑：`isrCacheMiddleware` 默认用 `ctx.path`，而 `ISRRenderer.buildCacheKey()` 会把排序后的 query 拼入 key。默认生产链路通常先经过 middleware，因此实际缓存命中行为以 middleware 的默认 key 为准。

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
  && appElementFactory
```

如果 SSR 只提供 `htmlRenderer`，不会进入 Streaming SSR，因为流式渲染需要 React 元素树。

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

SSR、ISR、Streaming SSR 和构建期兜底 HTML 都可能注入：

```html
<script>window.__NAMI_DATA__={...}</script>
```

变量名来自 `packages/shared/src/constants/defaults.ts`：

```typescript
export const NAMI_DATA_VARIABLE = '__NAMI_DATA__';
```

`generateDataScript(context.initialData)` 注入的是 `initialData` 对象本身，也就是 `getServerSideProps` / `getStaticProps` 返回的 `props`。

### 客户端读取

客户端读取位于 `packages/client/src/data/data-hydrator.ts`：

```typescript
const rawData = hydrateData<ServerInjectedData>(NAMI_DATA_VARIABLE);
cachedData = rawData;
```

客户端挂载入口位于 `packages/client/src/entry-client.tsx`：

```typescript
const serverData = readServerData();
const renderMode = (serverData.renderMode || config.defaultRenderMode) as RenderMode;

<NamiApp initialData={serverData.props} />
```

这意味着当前类型层面把 `window.__NAMI_DATA__` 描述为可包含 `props`、`renderMode`、`routePath`，但渲染器默认注入的是 `props` 对象本身。如果业务希望客户端按 `serverData.props` 读取，需要确保注入数据结构与客户端读取约定一致。这是当前实现中需要特别注意的地方，文档不要把类型注释当成所有渲染器的实际输出形状。

### Hydration vs CSR 挂载

客户端根据 `renderMode !== 'csr'` 且容器已有子节点决定是否 Hydration：

| 条件 | 挂载方式 |
|------|----------|
| 非 CSR 且 `container.childNodes.length > 0` | `hydrateApp()`，复用服务端 HTML |
| CSR 或容器为空 | `renderApp()`，客户端创建 DOM |

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
| `redirect` / `notFound` | 当前 Renderer 主要只取 `props` | API 会转换为 307/308 或 404 |
| 返回内容 | HTML / stream | JSON 或 204 |
| 路径前缀 | 页面原始路径 | `/_nami/data` |

---

## 12. 降级策略

源码位置：

- `packages/server/src/middleware/render-middleware.ts`
- `packages/core/src/error/degradation.ts`

渲染抛错后，`renderMiddleware` 首先检查插件是否提供了骨架屏 HTML：

```typescript
if (typeof renderContext.extra.__skeleton_fallback === 'string') {
  ctx.status = 200;
  ctx.set('X-Nami-Render-Mode', 'skeleton-fallback');
  ctx.body = skeletonHtml;
  return;
}
```

否则进入 `DegradationManager.executeWithDegradation()`：

| 等级 | 条件 | 返回 |
|------|------|------|
| Level 0 | 原始渲染重试成功 | 原始渲染结果 |
| Level 1 | `config.maxRetries > 0` | 重试后的结果 |
| Level 2 | `config.ssrToCSR` | CSR 空壳 |
| Level 3 | `context.route.skeleton` 存在 | 内置骨架屏 HTML |
| Level 4 | `config.staticHTML` 存在 | 静态 HTML |
| Level 5 | 全部失败 | 503 页面 |

注意：`context.route.skeleton` 当前只是触发内置骨架 HTML 的条件，不是加载并渲染 skeleton 组件文件。

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

运行期可以不做服务端渲染，但构建期需要 server bundle 执行页面模块、`getStaticProps`、`getStaticPaths` 或 `renderToHTML`。这也是 `NEEDS_SERVER_BUNDLE` 包含 SSG 的原因。

### 误区三：`/_nami/data/*` 就是 SSR 的数据预取流程

不是。它是客户端路由预取 JSON 的 API。HTML SSR 请求的数据预取发生在 `SSRRenderer.prefetchData()` 中。

### 误区四：HTML 链路会自动处理 `redirect` / `notFound`

当前 Renderer 的 HTML 链路主要使用数据函数返回的 `props`；`redirect` / `notFound` 的 HTTP 响应处理在 `dataPrefetchMiddleware` 中更完整。写业务时不要假设 HTML SSR 已经完全等同 Next.js 的语义。

### 误区五：ISR 默认按完整 URL 缓存

默认 `isrCacheMiddleware` 使用 `ctx.path` 作为缓存键，不包含 query。`ISRRenderer` 内部 helper 会拼 query，但默认生产缓存命中先经过 middleware，因此需要按 middleware 行为理解。

### 误区六：`window.__NAMI_DATA__` 一定是 `{ props, renderMode }`

类型允许这种结构，但渲染器默认注入的是 `context.initialData` 本身。客户端 `entry-client.tsx` 读取 `serverData.props`，因此项目如果依赖结构化注水，需要保证 server bundle 输出和客户端读取协议一致。

---

## 下一步

- 服务端中间件顺序：阅读 [服务器与中间件](./server-and-middleware.md)
- ISR 缓存存储与失效：阅读 [ISR 与缓存](./isr-and-caching.md)
- 构建期双 Bundle 与静态生成：阅读 [构建系统](./webpack-build.md)
