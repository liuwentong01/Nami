# 错误处理与降级原理

Nami 的错误处理分为几层：类型系统用于描述错误，服务端中间件负责隔离请求级异常，渲染中间件负责把渲染失败转为降级响应，客户端 Error Boundary 负责避免浏览器白屏，Hydration 工具负责上报 SSR/客户端不一致问题。

这里必须先区分两种视觉上都可能使用“骨架”的状态：CSR Shell、路由 Chunk 和业务数据请求中的骨架是可恢复的 **loading UI**；Level 3 则是客户端接管也不可用后的 **静态应急兜底**，不会等待 React 自动替换。

这章重点说明“当前源码真正执行了什么”，尤其区分已定义的工具类和主链路已经接入的逻辑。

---

## 1. 源码地图

| 主题                                 | 源码                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| 错误码、严重等级、错误类             | `packages/shared/src/types/error.ts`                          |
| 错误文案模板                         | `packages/shared/src/constants/error-codes.ts`                |
| 降级默认配置                         | `packages/shared/src/constants/defaults.ts`                   |
| `FallbackConfig`                     | `packages/shared/src/types/config.ts`                         |
| 统一错误处理器                       | `packages/core/src/error/error-handler.ts`                    |
| 错误上报器                           | `packages/core/src/error/error-reporter.ts`                   |
| 降级管理器                           | `packages/core/src/error/degradation.ts`                      |
| CSR Shell 与构建期静态应急 HTML      | `packages/core/src/html/csr-shell-loading.ts`                 |
| Renderer 基类与插件钩子              | `packages/core/src/renderer/base-renderer.ts`                 |
| 各渲染器错误包装                     | `packages/core/src/renderer/*.ts`                             |
| 服务端装配顺序                       | `packages/server/src/app.ts`                                  |
| 错误隔离中间件                       | `packages/server/src/middleware/error-isolation.ts`           |
| 渲染中间件降级入口                   | `packages/server/src/middleware/render-middleware.ts`         |
| 客户端应用根组件                     | `packages/client/src/app.tsx`                                 |
| 客户端错误边界                       | `packages/client/src/error/client-error-boundary.tsx`         |
| Hydration 不匹配上报                 | `packages/client/src/hydration/hydration-mismatch.ts`         |
| 客户端入口                           | `packages/client/src/entry-client.tsx`                        |
| 默认路由加载骨架                     | `packages/client/src/router/route-loading-fallback.tsx`       |
| `index.html` / `emergency.html` 生成 | `packages/webpack/src/plugins/html-inject-plugin.ts`          |
| 骨架屏插件                           | `packages/plugin-skeleton/src/skeleton-plugin.ts`             |
| 错误边界插件                         | `packages/plugin-error-boundary/src/error-boundary-plugin.ts` |

---

## 2. 错误模型

源码位置：`packages/shared/src/types/error.ts`

### 错误码

`ErrorCode` 按模块划分：

| 范围        | 模块         | 例子                                                 |
| ----------- | ------------ | ---------------------------------------------------- |
| `1000-1999` | 渲染错误     | `RENDER_SSR_FAILED`、`RENDER_HYDRATION_MISMATCH`     |
| `2000-2999` | 数据预取错误 | `DATA_FETCH_FAILED`、`DATA_GSP_FAILED`               |
| `3000-3999` | 缓存错误     | `CACHE_READ_FAILED`、`CACHE_REDIS_CONNECTION_FAILED` |
| `4000-4999` | 路由错误     | `ROUTE_NOT_FOUND`、`ROUTE_INVALID_CONFIG`            |
| `5000-5999` | 插件错误     | `PLUGIN_LOAD_FAILED`、`PLUGIN_HOOK_FAILED`           |
| `6000-6999` | 构建错误     | `BUILD_COMPILE_FAILED`                               |
| `7000-7999` | 服务端错误   | `SERVER_START_FAILED`、`SERVER_MIDDLEWARE_FAILED`    |
| `8000-8999` | 客户端错误   | `CLIENT_INIT_FAILED`、`CLIENT_ROUTING_FAILED`        |
| `9000-9999` | 配置错误     | `CONFIG_VALIDATION_FAILED`、`CONFIG_NOT_FOUND`       |

`packages/shared/src/constants/error-codes.ts` 提供 `ERROR_MESSAGES` 与 `formatErrorMessage()`，用于把错误码格式化成人类可读文本。

### 严重等级

```typescript
export enum ErrorSeverity {
  Fatal = 'fatal',
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}
```

### 降级等级

```typescript
export enum DegradationLevel {
  None = 0,
  Retry = 1,
  CSRFallback = 2,
  Skeleton = 3,
  StaticHTML = 4,
  ServiceUnavailable = 5,
}
```

它是数值枚举。文档里说的 Level 0 到 Level 5，对应这里的 `None` 到 `ServiceUnavailable`。`Skeleton` 名称为兼容保留；当前 Level 3 的运行语义是无客户端接管的静态应急兜底。

### 错误类

`NamiError`：

```typescript
class NamiError extends Error {
  code: ErrorCode;
  severity: ErrorSeverity;
  context: Record<string, unknown>;
  timestamp: number;
  toJSON(): Record<string, unknown>;
}
```

派生类：

| 类               | 默认错误码                 | 默认严重等级 |
| ---------------- | -------------------------- | ------------ |
| `RenderError`    | `RENDER_SSR_FAILED`        | `Error`      |
| `DataFetchError` | `DATA_FETCH_FAILED`        | `Warning`    |
| `ConfigError`    | `CONFIG_VALIDATION_FAILED` | `Fatal`      |

---

## 3. ErrorHandler 与 ErrorReporter

源码位置：

- `packages/core/src/error/error-handler.ts`
- `packages/core/src/error/error-reporter.ts`

`ErrorHandler` 是一个可复用工具：

```typescript
const result = errorHandler.handle(error, {
  url: '/products/1',
  requestId: 'req-123',
});

result.recoverable;
result.severity;
result.error;
```

它会：

1. 把任意错误规范化为 `NamiError`。
2. 根据错误码和严重等级分类。
3. 判断是否可恢复。
4. 记录日志。

可恢复错误集合包含 SSR 失败/超时、Hydration mismatch、数据预取失败、缓存失败、插件钩子失败等。`Fatal` 级别错误不可恢复。

`ErrorReporter` 负责上报：

| 能力       | 行为                                                             |
| ---------- | ---------------------------------------------------------------- |
| 启用开关   | `monitor.enabled`                                                |
| 采样       | `monitor.sampleRate`                                             |
| 去重       | 基于错误码和 message 的 Set                                      |
| 服务端发送 | `setImmediate()` + `globalThis.fetch()`                          |
| 客户端发送 | 优先 `navigator.sendBeacon()`，降级 `fetch({ keepalive: true })` |
| 开发环境   | 默认跳过上报                                                     |

注意：这两个类是 core 导出的工具。服务端主渲染链路里，`render-middleware.ts` 的降级 catch 并没有先调用 `ErrorHandler.handle()`，`error-isolation.ts` 也没有自动调用 `ErrorReporter.report()`。如果业务需要统一上报，可以通过插件、`errorIsolationMiddleware({ onError })` 或上层服务集成接入。

---

## 4. 服务端错误防护层级

实际服务端顺序以 `packages/server/src/app.ts` 为准：

```text
shutdownAware
timing
security
requestContext
healthCheck
staticServe
用户 middlewares
插件 middlewares
dataPrefetch
errorIsolation
isrCacheMiddleware
renderMiddleware
```

由此可以得到几个边界：

1. `errorIsolation` 只包住它后面的 `isrCacheMiddleware` 和 `renderMiddleware`。
2. 用户自定义中间件、插件 server middleware、`dataPrefetch` 都在 `errorIsolation` 之前；它们抛出的异常不会被 `errorIsolation` 的 500 HTML 捕获。
3. `renderMiddleware` 内部有自己的 `try/catch`，渲染失败通常会先走降级，不会再抛到 `errorIsolation`。
4. Koa 的全局 `app.on('error')` 是兜底日志通道，不负责构造 Nami 的降级 HTML。

---

## 5. `errorIsolationMiddleware`

源码位置：`packages/server/src/middleware/error-isolation.ts`

配置：

```typescript
export interface ErrorIsolationOptions {
  errorPageHTML?: string;
  onError?: (error: Error, ctx: Koa.Context) => void | Promise<void>;
}
```

执行逻辑：

```text
try
  await next()
catch error
  -> 规范化为 Error
  -> 读取 requestId、logger
  -> 记录 method/url/user-agent/ip/stack
  -> 执行 onError，且 onError 自身也被 try/catch 包裹
  -> ctx.status = 500
  -> ctx.type = text/html
  -> ctx.set('X-Nami-Error', 'true')
  -> 返回 errorPageHTML 或默认 500 HTML
```

自定义错误页支持占位符：

| 占位符           | 值                                             |
| ---------------- | ---------------------------------------------- |
| `{{statusCode}}` | `500`                                          |
| `{{message}}`    | 开发环境为真实错误，生产环境为“服务器内部错误” |
| `{{requestId}}`  | 当前请求 ID                                    |

默认错误页是纯静态 HTML，不依赖 JS/CSS。开发环境会展示错误 message 和 stack，生产环境避免泄露内部细节。

---

## 6. `renderMiddleware` 的降级入口

源码位置：`packages/server/src/middleware/render-middleware.ts`

主流程：

```text
仅处理 GET / HEAD
  -> matchConfiguredRoute(ctx.path, config.routes)
  -> createRenderContext(ctx, matchResult, requestId)
  -> RendererFactory.create(...)
  -> renderer.render(...) 或 streamingRenderer.renderToStream(...)
  -> applyPluginExtras(...)
  -> setResponse(...)
```

### 创建渲染器失败

如果 `RendererFactory.create()` 抛错：

```typescript
renderer = RendererFactory.create({
  mode: RenderMode.CSR,
  config,
  pluginManager,
  assetManifest,
});
```

这里降级到 CSR，并会传入 `pluginManager` 和中间件闭包里的 `assetManifest`。需要注意的是：如果开发模式下 `runtimeProvider` 刚读到了更新的 manifest，创建失败的兜底路径不会再使用这份 runtime manifest，而是使用中间件初始化时传入的 manifest。

### 渲染失败

`DegradationManager` 从第一次渲染开始统一接管：

```text
degradationManager.executeWithDegradation(renderFn, ...)
  -> Level 0 执行首次渲染
  -> 失败后按 Level 1 到 Level 5 依次降级
  -> 插件应急 HTML 仅作为 Level 3 的候选内容
  -> setResponse(ctx, degradationResult.result)
```

重要细节：

1. `onRenderError` 由各 Renderer 内部触发，避免中间件重复调用。
2. Streaming SSR 的首次渲染和重试复用同一个 `renderToStream()` 函数。
3. `plugin-skeleton` 写入的 `__csr_shell_skeleton` 供正常/降级 CSR 使用；`__skeleton_fallback` 只由 `DegradationManager` 在 Level 3 消费，不会跳过重试或 CSR。
4. `plugin-error-boundary` 写入的 `__degradation_*` 字段当前没有被 `renderMiddleware` 消费；它更像是插件自身的扩展协议/日志信息。

---

## 7. `applyPluginExtras`

源码位置：`packages/server/src/middleware/render-middleware.ts`

渲染成功后，中间件会读取 `context.extra` 的几个约定字段：

| 字段                                               | 行为                                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `__cache_hit === true` + `__cache_content: string` | Renderer 在数据预取前返回缓存；这里保留兼容替换并设置命中头 |
| `__custom_headers`                                 | 合并进 `result.headers`                                     |
| `__retry_attempted === true`                       | 设置 `X-Nami-Retry: 1`                                      |
| 任意 extra                                         | 最后挂到 `ctx.state.namiExtra`                              |

Renderer 与 `DegradationManager` 还会消费：

| 字段                           | 行为                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `__csr_shell_skeleton: string` | 作为正常 CSR 与 Level 2 的可恢复 loading 片段；无效片段安全回退到内置骨架 |
| `__skeleton_fallback: string`  | 作为 Level 3 静态应急候选                                                 |

这也是为什么插件通过 `context.extra` 进行服务端响应协作时，必须使用中间件真正消费的字段名。

---

## 8. DegradationManager

源码位置：`packages/core/src/error/degradation.ts`

`DegradationManager.executeWithDegradation()` 按 Level 0 到 Level 5 尝试：

```text
Level 0: 正常渲染
  失败 ->
Level 1: 重试
  失败 ->
Level 2: 带临时骨架的 CSR 降级
  失败 ->
Level 3: 静态应急兜底（兼容名称 Skeleton）
  失败 ->
Level 4: 静态 HTML
  失败 ->
Level 5: 503
```

返回：

```typescript
export interface DegradationResult {
  result: RenderResult;
  level: DegradationLevel;
  errors: Error[];
}
```

### Level 0：正常渲染

直接调用传入的 `renderFn(context)`。成功则返回 `DegradationLevel.None`。

### Level 1：重试

条件：

```typescript
config.maxRetries > 0;
```

每次重试仍调用同一个 `renderFn(context)`。成功后会标记：

```typescript
result.meta.degraded = true;
result.meta.degradeReason = `重试第 ${attempt} 次成功`;
```

### Level 2：CSR 降级

条件：

```typescript
config.ssrToCSR === true;
```

返回仍可由浏览器恢复的 CSR Shell：

```html
<div id="nami-root">
  <div data-nami-csr-shell="loading">...</div>
</div>
<script defer src="...client entry..."></script>
```

`#nami-root` 不再是空容器。它先展示临时骨架，同时继续下载和执行客户端 JS；React 首次成功提交后会替换这段内容。正常 CSR 由 `CSRRenderer` 使用同一机制，SSR→CSR 的 Level 2 则由 `DegradationManager` 使用。

Shell 内容解析顺序：

1. 优先读取 `context.extra.__csr_shell_skeleton`。`NamiSkeletonPlugin` 默认为正常 CSR 在 `onBeforeRender` 准备该片段；SSR→CSR 时由 `onRenderError` 补充，成功的 SSR/SSG/ISR 不生成无用片段。
2. 自定义值 trim 后为空，包含 `doctype`、`html`、`head`、`body`、`script` 标签、内联事件处理器或 `javascript:` URL 时拒绝使用，回退到 Core 内置骨架。Shell 扩展点只接受放进 `#nami-root` 的安全 HTML 片段，不能嵌套完整文档或可执行内容。
3. 没有安装骨架插件时同样使用内置骨架，因此正常/降级 CSR 在 JS 启动前都不会退回空容器。

CSS/JS 资源解析逻辑：

1. 如果 `DegradationManager` 构造时传了 `assetManifest`，使用 `ScriptInjector` 注入真实资源。
2. 否则使用占位路径：
   - `${publicPath}static/css/main.css`
   - `${publicPath}static/js/main.js`

`createNamiServer()` 会把可选的构建 `assetManifest` 传给 `DegradationManager`：

```typescript
new DegradationManager({
  publicPath: config.assets.publicPath,
  assetManifest: options.assetManifest,
});
```

因此生产启动链路应传入 manifest，才能稳定引用带 content hash 的真实资源；占位路径只是在 manifest 不可用时的兼容路径。

`DegradationManager` 产出的内部响应头：

```http
X-Nami-Degraded: csr-fallback
```

写入最终 Koa 响应时，`setResponse()` 会保留已有的语义值（例如 `csr-fallback`），仅在降级结果没有提供该头时补充 `X-Nami-Degraded: 1`；所有降级结果都会设置 `Cache-Control: private, no-store, max-age=0`。

### Level 3：静态应急兜底（`Skeleton`）

条件：

```typescript
context.extra.__skeleton_fallback ||
  (context.extra.__degradation_level === DegradationLevel.Skeleton &&
    context.extra.__degradation_html) ||
  context.route.skeleton;
```

为了兼容既有枚举和内部结果判断，这一级仍名为 `DegradationLevel.Skeleton`，其 `RenderResult` 保留：

```http
X-Nami-Degraded: skeleton
X-Nami-Fallback-Type: static-emergency
```

Level 3 优先使用骨架插件生成的 `__skeleton_fallback`；仅当错误边界插件同时把 `__degradation_level` 标记为 `Skeleton` 时，才兼容它的 `__degradation_html`，避免把 Level 4/5 的错误页和状态误写成 Level 3/200。候选内容通过与 `emergency.html` 相同的被动 HTML 允许列表检查，不安全时回退 Core 内置应急页。没有插件内容时，`route.skeleton` 作为开关触发内置固定应急 HTML。`route.skeleton` 的字符串路径当前仍不会被加载为组件。

这份响应不注入客户端入口，也没有自动恢复协议。它只在重试和可恢复 CSR 都不可用后提供明确的静态内容与重新加载入口，不能当成“页面仍在加载”的骨架。`__csr_shell_skeleton` 与 `__skeleton_fallback` 因而是两个有意分离的协议字段。

### Level 4：静态 HTML

条件：

```typescript
config.staticHTML;
```

直接返回 `fallback.staticHTML`，状态码 `200`，内部 `RenderResult` 响应头：

```http
X-Nami-Degraded: static-html
```

### Level 5：503

所有手段都失败后返回内置 503 HTML；`Retry-After` 和语义化的 `X-Nami-Degraded` 都会保留：

```http
HTTP/1.1 503 Service Unavailable
X-Nami-Degraded: service-unavailable
Retry-After: 30
```

### Node 进程不可达：构建期 `emergency.html`

Level 0–5 都要求请求已经进入 Nami 服务。若 Node 进程、容器或上游服务本身不可达，运行时降级链无法执行。为此，客户端构建会额外输出：

```text
{config.outDir}/client/emergency.html
# 默认：dist/client/emergency.html
```

该文件与 Level 3 独立，必须在反向代理、负载均衡器或 CDN 中显式配置为上游不可达时的错误页。内容优先使用安全的 `config.fallback.staticHTML`；框架会按被动标签、属性、URL 和 CSS 允许列表校验，拒绝脚本、事件属性、SVG/iframe/object、危险 URL、外部 CSS URL 与不平衡标签，校验失败时回退到 Core 内置静态错误页。最终产物不包含业务 JS 或 inline script，只提供无需 Node/React 的说明和普通重新加载链接。

---

## 9. 降级配置

源码位置：

- `packages/shared/src/types/config.ts`
- `packages/shared/src/constants/defaults.ts`

类型：

```typescript
export interface FallbackConfig {
  ssrToCSR: boolean;
  timeout: number;
  staticHTML?: string;
  maxRetries: number;
}
```

默认值：

```typescript
export const DEFAULT_FALLBACK_CONFIG = {
  ssrToCSR: true,
  timeout: 5000,
  maxRetries: 0,
};
```

当前真实使用情况：

| 字段         | 是否被 `DegradationManager` 使用 | 说明                                                                        |
| ------------ | -------------------------------- | --------------------------------------------------------------------------- |
| `ssrToCSR`   | 是                               | 控制 Level 2                                                                |
| `maxRetries` | 是                               | 控制 Level 1                                                                |
| `staticHTML` | 是                               | 控制 Level 4；客户端构建也会在通过被动 HTML 允许列表检查后优先用于 `emergency.html` |
| `timeout`    | 否                               | 有默认值与校验，但降级管理器和 renderer 超时逻辑不读取它                    |

SSR/Streaming SSR 的超时来自 `config.server.ssrTimeout`，不是 `fallback.timeout`。

`createNamiServer()` 初始化 `DegradationManager` 时会传入 `publicPath` 和可选的 `assetManifest`。因此 CSR 降级页是否能引用真实 content hash 资源，取决于启动链路是否把 `assetManifest` 注入到 `createNamiServer`。

---

## 10. Renderer 错误与插件钩子

源码位置：`packages/core/src/renderer/*.ts`

各 Renderer 失败时都会尝试触发 `renderError` 钩子，但传给插件的 error 类型不完全一致：

| Renderer               | `renderError` 参数                         |
| ---------------------- | ------------------------------------------ |
| `SSRRenderer`          | `RenderError`，先 `wrapError()` 再触发钩子 |
| `StreamingSSRRenderer` | `RenderError`                              |
| `ISRRenderer`          | 原始 `error`，再 `wrapError()`             |
| `CSRRenderer`          | 原始 `error`                               |
| `SSGRenderer`          | 原始 `error`                               |

插件类型 `RenderErrorHook` 是：

```typescript
(context: RenderContext, error: Error) => void | Promise<void>
```

因此插件不要假设拿到的一定是 `RenderError`。需要读取 `code` 时，应先判断：

```typescript
if (error instanceof NamiError) {
  console.log(error.code);
}
```

### `createFallbackRenderer()`

`BaseRenderer` 定义了降级渲染器链：

```text
Streaming SSR -> SSR -> CSR
SSR           -> CSR
SSG           -> CSR
ISR           -> CSR
CSR           -> null
```

但当前 `renderMiddleware` 的 catch 分支没有直接调用 `renderer.createFallbackRenderer()`，而是交给 `DegradationManager.executeWithDegradation()`。所以文档中不能把 `createFallbackRenderer()` 写成服务端主链路里每次渲染失败都会自动执行的步骤。

---

## 11. 客户端错误边界

源码位置：

- `packages/client/src/app.tsx`
- `packages/client/src/error/client-error-boundary.tsx`

客户端根组件结构：

```text
ClientErrorBoundary（框架最外层，兜住插件 wrapper）
  → wrapApp wrappers
       → NamiApp 内部 ClientErrorBoundary
            → BrowserRouter
                 → NamiDataProvider
                      ├─ RouteChangeListener
                      ├─ NamiHead
                      └─ Routes → Suspense → Page
```

`wrapApp` waterfall 在 `NamiApp` 完整树外执行，框架随后再加一层最外侧错误边界，确保插件 wrapper 自身的客户端 render error 也能进入错误页。`NamiDataProvider` 实际位于 `BrowserRouter` 内部的路由树中，wrapper 因此不应依赖页面级初始 NamiData。

### 三层 loading UI

客户端加载状态由三层分别负责：

| 层级           | 覆盖时间                                        | 推荐内容                                | 恢复方式                 |
| -------------- | ----------------------------------------------- | --------------------------------------- | ------------------------ |
| CSR HTML Shell | Bundle 下载、客户端初始化、React 首次 commit 前 | `__csr_shell_skeleton` 或 Core 内置骨架 | React 首次成功提交后替换 |
| 路由 Chunk     | `React.lazy` 路由组件加载                       | `NamiRouter` 的 Suspense fallback       | Chunk 完成后渲染页面     |
| 业务数据       | 页面内部请求、分页或局部刷新                    | 与业务布局匹配的局部骨架/刷新状态       | 请求成功后更新对应区域   |

`NamiRouter` 的 `loadingFallback` 约定为：

- 省略或传 `undefined`：CSR 首屏与后续客户端导航使用框架默认 `RouteLoadingFallback`；SSR/SSG/ISR 首次 Hydration 保持 `null`，避免骨架干扰已有服务端 DOM。
- 显式传 `null`：所有场景都关闭路由 fallback。
- 传 `ReactNode`：所有场景都使用自定义 fallback。

业务数据层不应因为后台刷新就清空已有内容。以 SWR 为例：`loading && data === undefined` 时显示局部骨架；`loading && data !== undefined` 时保留旧数据并显示“刷新中”；失败时显示错误与重试操作，有旧数据则继续保留。页面 render 真正抛错时才交给 Error Boundary，而不是用永久骨架掩盖错误。

`ClientErrorBoundary` 是 class 组件，使用 React Error Boundary 生命周期：

| 方法                                  | 作用                           |
| ------------------------------------- | ------------------------------ |
| `getDerivedStateFromError(error)`     | 设置 `hasError: true`          |
| `componentDidCatch(error, errorInfo)` | 记录日志并调用 `props.onError` |
| `componentDidUpdate(prevProps)`       | 检查 `resetKeys` 是否变化      |
| `resetErrorBoundary()`                | 清除错误状态并调用 `onReset`   |

`fallback` 支持：

```typescript
React.ReactNode | ((props: { error: Error; resetErrorBoundary: () => void }) => React.ReactNode);
```

源码注释里提到“React 组件形式”，但实现只判断 `typeof fallback === 'function'` 与非 function 两类。函数组件形式可以作为 render function 使用。

默认 UI：

1. 标题“页面出现了问题”。
2. 开发环境显示 `error.message`。
3. 生产环境显示“请刷新页面重试”。
4. 提供“重试”按钮调用 `resetErrorBoundary()`。

`ClientErrorBoundary` 捕获的是浏览器端渲染、生命周期、constructor 中的错误；不能捕获事件处理函数、异步回调或服务端 SSR 错误。

---

## 12. Hydration 不匹配

源码位置：

- `packages/client/src/entry-client.tsx`
- `packages/client/src/hydration/hydration-mismatch.ts`

正常服务端输出会注入 `{ version: 1, props, degraded, renderMode, routePath }`。客户端只在 `version` 与当前协议兼容、渲染模式非 CSR，且容器已有服务端 HTML 时调用 `hydrateApp()`：

```typescript
hydrateApp(container, appElement, {
  onRecoverableError: (error) => {
    reportMismatch(
      error,
      { renderMode, appName: config.appName },
      {
        reportUrl: config.monitor?.reportUrl,
        sampleRate: config.monitor?.sampleRate,
      },
    );
  },
});
```

稳定静态 404 不是可注水输出：它不带这份 payload 或客户端 Bundle，也不启动 Hydration。未知协议版本会安全回退到 CSR，不会将其当作可注水数据。

`reportMismatch()` 会：

1. 根据采样率判断是否上报。
2. 调用 `detectMismatch()` 分类。
3. 构造 payload。
4. 没有 `reportUrl` 时只记录日志。
5. 有 `reportUrl` 时优先 `sendBeacon`，失败再 `fetch({ keepalive: true })`。

Hydration 类型：

| 类型           | 含义           |
| -------------- | -------------- |
| `text-content` | 文本不一致     |
| `attribute`    | 属性不一致     |
| `element-type` | 节点类型不一致 |
| `extra-node`   | 客户端多出节点 |
| `missing-node` | 客户端缺少节点 |
| `unknown`      | 未能分类       |

`createMismatchError()` 可以把 Hydration 错误转换为：

```typescript
new NamiError(message, ErrorCode.RENDER_HYDRATION_MISMATCH, ErrorSeverity.Warning, context);
```

但当前 `entry-client.tsx` 的 `onRecoverableError` 调用的是 `reportMismatch()`，没有使用 `createMismatchError()`。

---

## 13. 插件参与错误处理

### `@nami/plugin-skeleton`

源码位置：`packages/plugin-skeleton/src/skeleton-plugin.ts`

这个插件会注册：

| 钩子             | 行为                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `wrapApp`        | 用 `React.Suspense` 包裹应用，fallback 是骨架组件                   |
| `onBeforeRender` | 写入布局标记，并为可恢复 CSR Shell 准备 `__csr_shell_skeleton`      |
| `onRenderError`  | 必要时补充 Shell 片段，并把静态应急 HTML 写入 `__skeleton_fallback` |

正常 CSR 与 Level 2 消费 `__csr_shell_skeleton` 并继续加载 JS；`DegradationManager` 只会在重试和 CSR 都不可用后，于 Level 3 消费 `__skeleton_fallback`。

### `@nami/plugin-error-boundary`

源码位置：`packages/plugin-error-boundary/src/error-boundary-plugin.ts`

这个插件会注册：

| 钩子            | 行为                                         |
| --------------- | -------------------------------------------- |
| `wrapApp`       | 用 `RouteErrorBoundary` 包裹应用             |
| `onRenderError` | 根据重试/降级策略写入 `__degradation_*` 字段 |
| `onError`       | 记录未处理错误并调用外部 `onError`           |

当前 `renderMiddleware` 会消费 `__retry_attempted` 并设置 `X-Nami-Retry: 1`；`DegradationManager` 仅在 `__degradation_level === Skeleton` 时把 `__degradation_html` 作为 Level 3 的次选静态应急候选。`__degradation_status`、`__degradation_reason` 仍只用于插件观测，不直接覆盖核心响应协议。最终降级层级仍统一由 `DegradationManager` 决定。

---

## 14. 典型故障链路

### SSR 数据函数抛错

```text
SSRRenderer.prefetchData()
  -> getServerSideProps 抛错
  -> Renderer catch
  -> callPluginHook('renderError', context, renderError)
  -> throw RenderError
  -> DegradationManager 捕获 Level 0 错误
       Level 1 重试
       Level 2 CSR fallback
       Level 3 plugin static emergency / route.skeleton
       Level 4 staticHTML
       Level 5 503
```

### ISR 缓存层异常

```text
isrCacheMiddleware
  -> cacheStore.get/set 抛错
  -> catch cacheError
  -> await next()
  -> ctx.set('X-Nami-Cache', 'BYPASS')
```

ISR 缓存是性能优化层。缓存故障默认不会让页面失败，而是旁路到真实渲染。

### 创建 Renderer 失败

```text
RendererFactory.create(mode) 抛错
  -> renderMiddleware catch
  -> RendererFactory.create({ mode: CSR, config, pluginManager, assetManifest })
  -> 后续按 CSR renderer 继续
```

这个路径会传入插件管理器，并使用中间件初始化时传入的 `assetManifest`；如果开发模式下 `runtimeProvider` 刚读到更新的 manifest，兜底路径不会再使用这份 runtime manifest。

### 客户端组件渲染失败

```text
页面组件 render 抛错
  -> ClientErrorBoundary.getDerivedStateFromError
  -> componentDidCatch
  -> NamiApp.onError
  -> entry-client handleError
  -> pluginManager.runParallelHook('onError', error, { source: 'client-error-boundary' })
  -> 显示 fallback 或默认错误 UI
```

---

## 15. 配置示例

```typescript
export default defineConfig({
  fallback: {
    ssrToCSR: true,
    maxRetries: 1,
    staticHTML: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>服务暂不可用</title></head>
        <body><h1>页面暂时不可用，请稍后重试</h1></body>
      </html>
    `,
  },
  routes: [
    {
      path: '/products/:id',
      component: './pages/product',
      renderMode: 'ssr',
      getServerSideProps: 'getServerSideProps',
      skeleton: './components/ProductSkeleton',
    },
  ],
});
```

需要注意：`skeleton` 字段当前在 `DegradationManager` 中只作为是否启用 Level 3 的标记，不会自动加载 `./components/ProductSkeleton`。要返回插件生成的 Level 3 静态应急 HTML，请使用 `@nami/plugin-skeleton` 或自己在 `onRenderError` 中写入 `context.extra.__skeleton_fallback`。

---

## 16. 常见误区

### 误区一：所有服务端中间件错误都会被 `errorIsolation` 捕获

不是。`errorIsolation` 位于用户中间件和插件 server middleware 之后，只保护 ISR 缓存层和渲染层。

### 误区二：`fallback.timeout` 控制 SSR 超时

当前不是。SSR/Streaming SSR 超时来自 `server.ssrTimeout`。`fallback.timeout` 有类型、默认值和校验，但主降级执行没有读取它。

### 误区三：`route.skeleton` 会自动加载骨架组件

不会。`DegradationManager` 只判断 `route.skeleton` 是否存在，然后返回内置固定静态应急 HTML。它既不会加载字符串指向的 React 组件，也不是路由 Chunk 的 loading fallback。

### 误区四：`plugin-error-boundary` 写入的降级字段会直接覆盖核心响应

不会直接覆盖。`DegradationManager` 只有在插件明确写入 `__degradation_level === Skeleton` 时，才在 Level 3 把 `__degradation_html` 作为 `__skeleton_fallback` 之后的次选静态应急内容，并执行被动 HTML 允许列表检查；插件写入的状态码和原因不会绕开核心重试、CSR 或缓存协议。

### 误区五：`renderError` 钩子拿到的一定是 `RenderError`

不一定。SSR 和 Streaming SSR 会传 `RenderError`，ISR/CSR/SSG 路径可能传原始错误。

### 误区六：主渲染链路会自动调用 `ErrorHandler` 和 `ErrorReporter`

不会。它们是可复用 core 工具，是否接入上报取决于插件、业务集成或自定义中间件。

---

## 下一步

- 想了解渲染模式失败时如何进入这里：阅读 [渲染模式原理](./rendering-modes.md)
- 想了解 ISR 缓存失败旁路：阅读 [ISR 与缓存原理](./isr-and-caching.md)
- 想了解完整中间件顺序：阅读 [服务器与中间件](./server-and-middleware.md)
