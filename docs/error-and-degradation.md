# 错误处理与降级原理

Nami 的错误处理分为几层：类型系统用于描述错误，服务端中间件负责隔离请求级异常，渲染中间件负责把渲染失败转为降级响应，客户端 Error Boundary 负责避免浏览器白屏，Hydration 工具负责上报 SSR/客户端不一致问题。

这章重点说明“当前源码真正执行了什么”，尤其区分已定义的工具类和主链路已经接入的逻辑。

---

## 1. 源码地图

| 主题 | 源码 |
|------|------|
| 错误码、严重等级、错误类 | `packages/shared/src/types/error.ts` |
| 错误文案模板 | `packages/shared/src/constants/error-codes.ts` |
| 降级默认配置 | `packages/shared/src/constants/defaults.ts` |
| `FallbackConfig` | `packages/shared/src/types/config.ts` |
| 统一错误处理器 | `packages/core/src/error/error-handler.ts` |
| 错误上报器 | `packages/core/src/error/error-reporter.ts` |
| 降级管理器 | `packages/core/src/error/degradation.ts` |
| Renderer 基类与插件钩子 | `packages/core/src/renderer/base-renderer.ts` |
| 各渲染器错误包装 | `packages/core/src/renderer/*.ts` |
| 服务端装配顺序 | `packages/server/src/app.ts` |
| 错误隔离中间件 | `packages/server/src/middleware/error-isolation.ts` |
| 渲染中间件降级入口 | `packages/server/src/middleware/render-middleware.ts` |
| 客户端应用根组件 | `packages/client/src/app.tsx` |
| 客户端错误边界 | `packages/client/src/error/client-error-boundary.tsx` |
| Hydration 不匹配上报 | `packages/client/src/hydration/hydration-mismatch.ts` |
| 客户端入口 | `packages/client/src/entry-client.tsx` |
| 骨架屏插件 | `packages/plugin-skeleton/src/skeleton-plugin.ts` |
| 错误边界插件 | `packages/plugin-error-boundary/src/error-boundary-plugin.ts` |

---

## 2. 错误模型

源码位置：`packages/shared/src/types/error.ts`

### 错误码

`ErrorCode` 按模块划分：

| 范围 | 模块 | 例子 |
|------|------|------|
| `1000-1999` | 渲染错误 | `RENDER_SSR_FAILED`、`RENDER_HYDRATION_MISMATCH` |
| `2000-2999` | 数据预取错误 | `DATA_FETCH_FAILED`、`DATA_GSP_FAILED` |
| `3000-3999` | 缓存错误 | `CACHE_READ_FAILED`、`CACHE_REDIS_CONNECTION_FAILED` |
| `4000-4999` | 路由错误 | `ROUTE_NOT_FOUND`、`ROUTE_INVALID_CONFIG` |
| `5000-5999` | 插件错误 | `PLUGIN_LOAD_FAILED`、`PLUGIN_HOOK_FAILED` |
| `6000-6999` | 构建错误 | `BUILD_COMPILE_FAILED` |
| `7000-7999` | 服务端错误 | `SERVER_START_FAILED`、`SERVER_MIDDLEWARE_FAILED` |
| `8000-8999` | 客户端错误 | `CLIENT_INIT_FAILED`、`CLIENT_ROUTING_FAILED` |
| `9000-9999` | 配置错误 | `CONFIG_VALIDATION_FAILED`、`CONFIG_NOT_FOUND` |

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

它是数值枚举。文档里说的 Level 0 到 Level 5，对应这里的 `None` 到 `ServiceUnavailable`。

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

| 类 | 默认错误码 | 默认严重等级 |
|----|------------|--------------|
| `RenderError` | `RENDER_SSR_FAILED` | `Error` |
| `DataFetchError` | `DATA_FETCH_FAILED` | `Warning` |
| `ConfigError` | `CONFIG_VALIDATION_FAILED` | `Fatal` |

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

| 能力 | 行为 |
|------|------|
| 启用开关 | `monitor.enabled` |
| 采样 | `monitor.sampleRate` |
| 去重 | 基于错误码和 message 的 Set |
| 服务端发送 | `setImmediate()` + `globalThis.fetch()` |
| 客户端发送 | 优先 `navigator.sendBeacon()`，降级 `fetch({ keepalive: true })` |
| 开发环境 | 默认跳过上报 |

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
dataPrefetch
用户 middlewares
插件 middlewares
errorIsolation
isrCacheMiddleware
renderMiddleware
```

由此可以得到几个边界：

1. `errorIsolation` 只包住它后面的 `isrCacheMiddleware` 和 `renderMiddleware`。
2. `dataPrefetch`、用户自定义中间件、插件 server middleware 在 `errorIsolation` 之前，它们抛出的异常不会被 `errorIsolation` 的 500 HTML 捕获。
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

| 占位符 | 值 |
|--------|----|
| `{{statusCode}}` | `500` |
| `{{message}}` | 开发环境为真实错误，生产环境为“服务器内部错误” |
| `{{requestId}}` | 当前请求 ID |

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
});
```

这里降级到 CSR，但没有传 `pluginManager`。因此创建渲染器失败后的兜底渲染，与正常路径的插件钩子行为不同。

### 渲染失败

渲染调用被 `try/catch` 包裹。失败后：

```text
catch renderError
  -> 记录错误
  -> 如果 renderContext.extra.__skeleton_fallback 是 string
       返回 200 + X-Nami-Render-Mode: skeleton-fallback
  -> 否则调用 degradationManager.executeWithDegradation(...)
  -> setResponse(ctx, degradationResult.result)
```

重要细节：

1. 注释里提到 `onRenderError`，但中间件 catch 中不再手动触发插件钩子；插件钩子由各 Renderer 内部触发，避免重复。
2. 如果原请求是 Streaming SSR，失败后传给 `DegradationManager` 的重试函数是 `renderer.render(ctx)`，不是 `renderToStream()`。
3. `plugin-skeleton` 写入的 `__skeleton_fallback` 会被中间件直接消费。
4. `plugin-error-boundary` 写入的 `__degradation_*` 字段当前没有被 `renderMiddleware` 消费；它更像是插件自身的扩展协议/日志信息。

---

## 7. `applyPluginExtras`

源码位置：`packages/server/src/middleware/render-middleware.ts`

渲染成功后，中间件会读取 `context.extra` 的几个约定字段：

| 字段 | 行为 |
|------|------|
| `__cache_hit === true` + `__cache_content: string` | 用插件缓存内容替换 `result.html`，并设置 `X-Nami-Plugin-Cache: HIT` |
| `__custom_headers` | 合并进 `result.headers` |
| `__retry_attempted === true` | 设置 `X-Nami-Retry: 1` |
| 任意 extra | 最后挂到 `ctx.state.namiExtra` |

失败 catch 中额外消费：

| 字段 | 行为 |
|------|------|
| `__skeleton_fallback: string` | 直接返回骨架屏 HTML |

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
Level 2: CSR 降级
  失败 ->
Level 3: 骨架屏
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
config.maxRetries > 0
```

每次重试仍调用同一个 `renderFn(context)`。成功后会标记：

```typescript
result.meta.degraded = true;
result.meta.degradeReason = `重试第 ${attempt} 次成功`;
```

### Level 2：CSR 降级

条件：

```typescript
config.ssrToCSR === true
```

返回空壳 HTML：

```html
<div id="nami-root"></div>
```

并注入 CSS/JS 资源。资源解析逻辑：

1. 如果 `DegradationManager` 构造时传了 `assetManifest`，使用 `ScriptInjector` 注入真实资源。
2. 否则使用占位路径：
   - `${publicPath}static/css/main.css`
   - `${publicPath}static/js/main.js`

当前 `createNamiServer()` 中构造方式是：

```typescript
new DegradationManager({
  publicPath: config.assets.publicPath,
});
```

没有传 `assetManifest`，因此默认服务端降级 CSR 壳层使用占位资源路径。

响应头：

```http
X-Nami-Degraded: csr-fallback
```

### Level 3：骨架屏

条件：

```typescript
context.route.skeleton
```

当前实现只判断 `route.skeleton` 是否 truthy，并不会读取该字符串路径加载骨架屏组件。返回的是 `createSkeletonFallback()` 内置的固定骨架 HTML。

这与 `plugin-skeleton` 的 `__skeleton_fallback` 是两套机制：

| 机制 | 来源 | 内容 |
|------|------|------|
| `renderMiddleware` 优先骨架 | `context.extra.__skeleton_fallback` | 插件生成的 HTML |
| `DegradationManager` Level 3 | `context.route.skeleton` truthy | 内置固定骨架 HTML |

### Level 4：静态 HTML

条件：

```typescript
config.staticHTML
```

直接返回 `fallback.staticHTML`，状态码 `200`，响应头：

```http
X-Nami-Degraded: static-html
```

### Level 5：503

所有手段都失败后返回内置 503 HTML：

```http
HTTP/1.1 503 Service Unavailable
X-Nami-Degraded: service-unavailable
Retry-After: 30
```

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

| 字段 | 是否被 `DegradationManager` 使用 | 说明 |
|------|----------------------------------|------|
| `ssrToCSR` | 是 | 控制 Level 2 |
| `maxRetries` | 是 | 控制 Level 1 |
| `staticHTML` | 是 | 控制 Level 4 |
| `timeout` | 否 | 有默认值与校验，但降级管理器和 renderer 超时逻辑不读取它 |

SSR/Streaming SSR 的超时来自 `config.server.ssrTimeout`，不是 `fallback.timeout`。

---

## 10. Renderer 错误与插件钩子

源码位置：`packages/core/src/renderer/*.ts`

各 Renderer 失败时都会尝试触发 `renderError` 钩子，但传给插件的 error 类型不完全一致：

| Renderer | `renderError` 参数 |
|----------|--------------------|
| `SSRRenderer` | `RenderError`，先 `wrapError()` 再触发钩子 |
| `StreamingSSRRenderer` | `RenderError` |
| `ISRRenderer` | 原始 `error`，再 `wrapError()` |
| `CSRRenderer` | 原始 `error` |
| `SSGRenderer` | 原始 `error` |

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

```tsx
<ClientErrorBoundary fallback={errorFallback} onError={...}>
  <NamiDataProvider initialData={initialData ?? {}}>
    <NamiHead />
    <NamiRouter />
  </NamiDataProvider>
</ClientErrorBoundary>
```

`ClientErrorBoundary` 是 class 组件，使用 React Error Boundary 生命周期：

| 方法 | 作用 |
|------|------|
| `getDerivedStateFromError(error)` | 设置 `hasError: true` |
| `componentDidCatch(error, errorInfo)` | 记录日志并调用 `props.onError` |
| `componentDidUpdate(prevProps)` | 检查 `resetKeys` 是否变化 |
| `resetErrorBoundary()` | 清除错误状态并调用 `onReset` |

`fallback` 支持：

```typescript
React.ReactNode
| ((props: { error: Error; resetErrorBoundary: () => void }) => React.ReactNode)
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

客户端入口在 SSR/SSG/ISR 模式且容器已有服务端 HTML 时调用 `hydrateApp()`：

```typescript
hydrateApp(container, appElement, {
  onRecoverableError: (error) => {
    reportMismatch(error, { renderMode, appName: config.appName }, {
      reportUrl: config.monitor?.reportUrl,
      sampleRate: config.monitor?.sampleRate,
    });
  },
});
```

`reportMismatch()` 会：

1. 根据采样率判断是否上报。
2. 调用 `detectMismatch()` 分类。
3. 构造 payload。
4. 没有 `reportUrl` 时只记录日志。
5. 有 `reportUrl` 时优先 `sendBeacon`，失败再 `fetch({ keepalive: true })`。

Hydration 类型：

| 类型 | 含义 |
|------|------|
| `text-content` | 文本不一致 |
| `attribute` | 属性不一致 |
| `element-type` | 节点类型不一致 |
| `extra-node` | 客户端多出节点 |
| `missing-node` | 客户端缺少节点 |
| `unknown` | 未能分类 |

`createMismatchError()` 可以把 Hydration 错误转换为：

```typescript
new NamiError(
  message,
  ErrorCode.RENDER_HYDRATION_MISMATCH,
  ErrorSeverity.Warning,
  context,
)
```

但当前 `entry-client.tsx` 的 `onRecoverableError` 调用的是 `reportMismatch()`，没有使用 `createMismatchError()`。

---

## 13. 插件参与错误处理

### `@nami/plugin-skeleton`

源码位置：`packages/plugin-skeleton/src/skeleton-plugin.ts`

这个插件会注册：

| 钩子 | 行为 |
|------|------|
| `wrapApp` | 用 `React.Suspense` 包裹应用，fallback 是骨架组件 |
| `onBeforeRender` | 写入 `__skeleton_layout`、`__skeleton_enabled` |
| `onRenderError` | 生成骨架 HTML，写入 `__skeleton_fallback` |

`renderMiddleware` 的失败 catch 会优先读取 `__skeleton_fallback`。因此这个插件的服务端降级 HTML 是主链路实际消费的。

### `@nami/plugin-error-boundary`

源码位置：`packages/plugin-error-boundary/src/error-boundary-plugin.ts`

这个插件会注册：

| 钩子 | 行为 |
|------|------|
| `wrapApp` | 用 `RouteErrorBoundary` 包裹应用 |
| `onRenderError` | 根据重试/降级策略写入 `__degradation_*` 字段 |
| `onError` | 记录未处理错误并调用外部 `onError` |

当前 `renderMiddleware` 会消费 `__retry_attempted` 并设置 `X-Nami-Retry: 1`，但不会消费 `__degradation_html`、`__degradation_status`、`__degradation_reason` 等字段。真正返回给用户的最终降级响应仍由 `renderMiddleware` 自己的 `__skeleton_fallback` 判断和 `DegradationManager` 决定。

---

## 14. 典型故障链路

### SSR 数据函数抛错

```text
SSRRenderer.prefetchData()
  -> getServerSideProps 抛错
  -> Renderer catch
  -> callPluginHook('renderError', context, renderError)
  -> throw RenderError
  -> renderMiddleware catch
  -> __skeleton_fallback ? 直接骨架
  -> DegradationManager
       Level 1 重试
       Level 2 CSR fallback
       Level 3 route.skeleton
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
  -> RendererFactory.create({ mode: CSR, config })
  -> 后续按 CSR renderer 继续
```

这个路径没有传插件管理器。

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

需要注意：`skeleton` 字段当前在 `DegradationManager` 中只作为是否启用 Level 3 的标记，不会自动加载 `./components/ProductSkeleton`。要返回插件生成的骨架 HTML，请使用 `@nami/plugin-skeleton` 或自己在 `onRenderError` 中写入 `context.extra.__skeleton_fallback`。

---

## 16. 常见误区

### 误区一：所有服务端中间件错误都会被 `errorIsolation` 捕获

不是。`errorIsolation` 位于用户中间件和插件 server middleware 之后，只保护 ISR 缓存层和渲染层。

### 误区二：`fallback.timeout` 控制 SSR 超时

当前不是。SSR/Streaming SSR 超时来自 `server.ssrTimeout`。`fallback.timeout` 有类型、默认值和校验，但主降级执行没有读取它。

### 误区三：`route.skeleton` 会自动加载骨架组件

不会。`DegradationManager` 只判断 `route.skeleton` 是否存在，然后返回内置固定骨架 HTML。

### 误区四：`plugin-error-boundary` 写入的降级 HTML 一定会被服务端返回

当前 `renderMiddleware` 不消费 `__degradation_html`。被直接消费的是 `__skeleton_fallback`、`__cache_*`、`__custom_headers`、`__retry_attempted`。

### 误区五：`renderError` 钩子拿到的一定是 `RenderError`

不一定。SSR 和 Streaming SSR 会传 `RenderError`，ISR/CSR/SSG 路径可能传原始错误。

### 误区六：主渲染链路会自动调用 `ErrorHandler` 和 `ErrorReporter`

不会。它们是可复用 core 工具，是否接入上报取决于插件、业务集成或自定义中间件。

---

## 下一步

- 想了解渲染模式失败时如何进入这里：阅读 [渲染模式原理](./rendering-modes.md)
- 想了解 ISR 缓存失败旁路：阅读 [ISR 与缓存原理](./isr-and-caching.md)
- 想了解完整中间件顺序：阅读 [服务器与中间件](./server-and-middleware.md)
