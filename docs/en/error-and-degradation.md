# Error Handling and Degradation Internals

Nami's error handling is layered: the type system describes errors, server middleware isolates request-level exceptions, render middleware converts render failures into degraded responses, the client Error Boundary prevents browser blank screens, and Hydration utilities report SSR/client mismatch issues.

This chapter focuses on "what the current source code actually executes", especially distinguishing defined utility classes from logic already wired into the main path.

---

## 1. Source Map

| Topic | Source |
|------|------|
| Error codes, severity levels, error classes | `packages/shared/src/types/error.ts` |
| Error message templates | `packages/shared/src/constants/error-codes.ts` |
| Default degradation config | `packages/shared/src/constants/defaults.ts` |
| `FallbackConfig` | `packages/shared/src/types/config.ts` |
| Unified error handler | `packages/core/src/error/error-handler.ts` |
| Error reporter | `packages/core/src/error/error-reporter.ts` |
| Degradation manager | `packages/core/src/error/degradation.ts` |
| Renderer base class and plugin hooks | `packages/core/src/renderer/base-renderer.ts` |
| Error wrapping in renderers | `packages/core/src/renderer/*.ts` |
| Server assembly order | `packages/server/src/app.ts` |
| Error isolation middleware | `packages/server/src/middleware/error-isolation.ts` |
| Render middleware degradation entry | `packages/server/src/middleware/render-middleware.ts` |
| Client app root component | `packages/client/src/app.tsx` |
| Client error boundary | `packages/client/src/error/client-error-boundary.tsx` |
| Hydration mismatch reporting | `packages/client/src/hydration/hydration-mismatch.ts` |
| Client entry | `packages/client/src/entry-client.tsx` |
| Skeleton plugin | `packages/plugin-skeleton/src/skeleton-plugin.ts` |
| Error boundary plugin | `packages/plugin-error-boundary/src/error-boundary-plugin.ts` |

---

## 2. Error Model

Source location: `packages/shared/src/types/error.ts`

### Error Codes

`ErrorCode` is divided by module:

| Range | Module | Examples |
|------|------|------|
| `1000-1999` | Render errors | `RENDER_SSR_FAILED`, `RENDER_HYDRATION_MISMATCH` |
| `2000-2999` | Data prefetch errors | `DATA_FETCH_FAILED`, `DATA_GSP_FAILED` |
| `3000-3999` | Cache errors | `CACHE_READ_FAILED`, `CACHE_REDIS_CONNECTION_FAILED` |
| `4000-4999` | Route errors | `ROUTE_NOT_FOUND`, `ROUTE_INVALID_CONFIG` |
| `5000-5999` | Plugin errors | `PLUGIN_LOAD_FAILED`, `PLUGIN_HOOK_FAILED` |
| `6000-6999` | Build errors | `BUILD_COMPILE_FAILED` |
| `7000-7999` | Server errors | `SERVER_START_FAILED`, `SERVER_MIDDLEWARE_FAILED` |
| `8000-8999` | Client errors | `CLIENT_INIT_FAILED`, `CLIENT_ROUTING_FAILED` |
| `9000-9999` | Config errors | `CONFIG_VALIDATION_FAILED`, `CONFIG_NOT_FOUND` |

`packages/shared/src/constants/error-codes.ts` provides `ERROR_MESSAGES` and `formatErrorMessage()` to format error codes into human-readable text.

### Severity Levels

```typescript
export enum ErrorSeverity {
  Fatal = 'fatal',
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}
```

### Degradation Levels

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

This is a numeric enum. Level 0 to Level 5 in the documentation correspond to `None` through `ServiceUnavailable` here.

### Error Classes

`NamiError`:

```typescript
class NamiError extends Error {
  code: ErrorCode;
  severity: ErrorSeverity;
  context: Record<string, unknown>;
  timestamp: number;
  toJSON(): Record<string, unknown>;
}
```

Derived classes:

| Class | Default error code | Default severity |
|----|------------|--------------|
| `RenderError` | `RENDER_SSR_FAILED` | `Error` |
| `DataFetchError` | `DATA_FETCH_FAILED` | `Warning` |
| `ConfigError` | `CONFIG_VALIDATION_FAILED` | `Fatal` |

---

## 3. ErrorHandler and ErrorReporter

Source locations:

- `packages/core/src/error/error-handler.ts`
- `packages/core/src/error/error-reporter.ts`

`ErrorHandler` is a reusable utility:

```typescript
const result = errorHandler.handle(error, {
  url: '/products/1',
  requestId: 'req-123',
});

result.recoverable;
result.severity;
result.error;
```

It:

1. Normalizes any error into `NamiError`.
2. Classifies by error code and severity.
3. Determines whether it is recoverable.
4. Logs the error.

Recoverable errors include SSR failures/timeouts, Hydration mismatch, data prefetch failures, cache failures, plugin hook failures, and more. `Fatal` errors are not recoverable.

`ErrorReporter` handles reporting:

| Capability | Behavior |
|------|------|
| Enable switch | `monitor.enabled` |
| Sampling | `monitor.sampleRate` |
| Deduplication | Set based on error code and message |
| Server sending | `setImmediate()` + `globalThis.fetch()` |
| Client sending | Prefer `navigator.sendBeacon()`, fallback to `fetch({ keepalive: true })` |
| Development environment | Skips reporting by default |

Note: these two classes are exported core utilities. In the server main render path, the degradation catch in `render-middleware.ts` does not first call `ErrorHandler.handle()`, and `error-isolation.ts` does not automatically call `ErrorReporter.report()`. If the business needs unified reporting, it can be wired through a plugin, `errorIsolationMiddleware({ onError })`, or an upper service integration.

---

## 4. Server Error Protection Layers

The actual server order follows `packages/server/src/app.ts`:

```text
shutdownAware
timing
security
requestContext
healthCheck
staticServe
user middlewares
plugin middlewares
dataPrefetch
errorIsolation
isrCacheMiddleware
renderMiddleware
```

This gives several boundaries:

1. `errorIsolation` only wraps the `isrCacheMiddleware` and `renderMiddleware` after it.
2. User custom middleware, plugin server middleware, and `dataPrefetch` are all before `errorIsolation`; exceptions thrown by them are not captured by `errorIsolation`'s 500 HTML.
3. `renderMiddleware` has its own internal `try/catch`; render failures usually go through degradation first and are not thrown further to `errorIsolation`.
4. Koa's global `app.on('error')` is a fallback logging channel and does not construct Nami degradation HTML.

---

## 5. `errorIsolationMiddleware`

Source location: `packages/server/src/middleware/error-isolation.ts`

Config:

```typescript
export interface ErrorIsolationOptions {
  errorPageHTML?: string;
  onError?: (error: Error, ctx: Koa.Context) => void | Promise<void>;
}
```

Execution logic:

```text
try
  await next()
catch error
  -> normalize to Error
  -> read requestId and logger
  -> log method/url/user-agent/ip/stack
  -> execute onError, with onError itself also wrapped by try/catch
  -> ctx.status = 500
  -> ctx.type = text/html
  -> ctx.set('X-Nami-Error', 'true')
  -> return errorPageHTML or default 500 HTML
```

Custom error pages support placeholders:

| Placeholder | Value |
|--------|----|
| `{{statusCode}}` | `500` |
| `{{message}}` | Real error in development, "Internal server error" in production |
| `{{requestId}}` | Current request ID |

The default error page is pure static HTML and does not depend on JS/CSS. In development, it displays the error message and stack. In production, it avoids leaking internal details.

---

## 6. Degradation Entry in `renderMiddleware`

Source location: `packages/server/src/middleware/render-middleware.ts`

Main flow:

```text
only handle GET / HEAD
  -> matchConfiguredRoute(ctx.path, config.routes)
  -> createRenderContext(ctx, matchResult, requestId)
  -> RendererFactory.create(...)
  -> renderer.render(...) or streamingRenderer.renderToStream(...)
  -> applyPluginExtras(...)
  -> setResponse(...)
```

### Renderer Creation Failure

If `RendererFactory.create()` throws:

```typescript
renderer = RendererFactory.create({
  mode: RenderMode.CSR,
  config,
  pluginManager,
  assetManifest,
});
```

This degrades to CSR and passes in `pluginManager` and the `assetManifest` from the middleware closure. Note that if development mode `runtimeProvider` just read an updated manifest, the fallback path on creation failure will not use that runtime manifest again. It uses the manifest passed during middleware initialization.

### Render Failure

The render call is wrapped by `try/catch`. After failure:

```text
catch renderError
  -> log error
  -> if renderContext.extra.__skeleton_fallback is string
       return 200 + X-Nami-Render-Mode: skeleton-fallback
  -> otherwise call degradationManager.executeWithDegradation(...)
  -> setResponse(ctx, degradationResult.result)
```

Important details:

1. The comments mention `onRenderError`, but the middleware catch no longer manually triggers plugin hooks. Plugin hooks are triggered inside each Renderer to avoid duplication.
2. If the original request is Streaming SSR, the retry function passed to `DegradationManager` after failure is `renderer.render(ctx)`, not `renderToStream()`.
3. `__skeleton_fallback` written by `plugin-skeleton` is consumed directly by the middleware.
4. `__degradation_*` fields written by `plugin-error-boundary` are not currently consumed by `renderMiddleware`; they are more like the plugin's own extension protocol/log information.

---

## 7. `applyPluginExtras`

Source location: `packages/server/src/middleware/render-middleware.ts`

After successful rendering, the middleware reads several convention fields from `context.extra`:

| Field | Behavior |
|------|------|
| `__cache_hit === true` + `__cache_content: string` | Replaces `result.html` with plugin-cached content and sets `X-Nami-Plugin-Cache: HIT` |
| `__custom_headers` | Merged into `result.headers` |
| `__retry_attempted === true` | Sets `X-Nami-Retry: 1` |
| Any extra | Finally attached to `ctx.state.namiExtra` |

The failure catch additionally consumes:

| Field | Behavior |
|------|------|
| `__skeleton_fallback: string` | Directly returns skeleton HTML |

This is why, when plugins collaborate on server responses through `context.extra`, they must use field names actually consumed by the middleware.

---

## 8. DegradationManager

Source location: `packages/core/src/error/degradation.ts`

`DegradationManager.executeWithDegradation()` tries Level 0 to Level 5:

```text
Level 0: normal render
  fails ->
Level 1: retry
  fails ->
Level 2: CSR fallback
  fails ->
Level 3: skeleton
  fails ->
Level 4: static HTML
  fails ->
Level 5: 503
```

Returns:

```typescript
export interface DegradationResult {
  result: RenderResult;
  level: DegradationLevel;
  errors: Error[];
}
```

### Level 0: Normal Render

Directly calls the passed `renderFn(context)`. On success, returns `DegradationLevel.None`.

### Level 1: Retry

Condition:

```typescript
config.maxRetries > 0
```

Each retry still calls the same `renderFn(context)`. After success, it marks:

```typescript
result.meta.degraded = true;
result.meta.degradeReason = `Retry attempt ${attempt} succeeded`;
```

### Level 2: CSR Fallback

Condition:

```typescript
config.ssrToCSR === true
```

Returns an empty shell HTML:

```html
<div id="nami-root"></div>
```

And injects CSS/JS assets. Asset resolution logic:

1. If `assetManifest` was passed when constructing `DegradationManager`, use `ScriptInjector` to inject real assets.
2. Otherwise, use placeholder paths:
   - `${publicPath}static/css/main.css`
   - `${publicPath}static/js/main.js`

The current construction in `createNamiServer()` is:

```typescript
new DegradationManager({
  publicPath: config.assets.publicPath,
});
```

It does not pass `assetManifest`, so the default server degradation CSR shell uses placeholder asset paths.

Response header:

```http
X-Nami-Degraded: csr-fallback
```

### Level 3: Skeleton

Condition:

```typescript
context.route.skeleton
```

The current implementation only checks whether `route.skeleton` is truthy. It does not read that string path to load a skeleton component. It returns the built-in fixed skeleton HTML from `createSkeletonFallback()`.

This is a separate mechanism from `plugin-skeleton`'s `__skeleton_fallback`:

| Mechanism | Source | Content |
|------|------|------|
| `renderMiddleware` priority skeleton | `context.extra.__skeleton_fallback` | HTML generated by the plugin |
| `DegradationManager` Level 3 | `context.route.skeleton` truthy | Built-in fixed skeleton HTML |

### Level 4: Static HTML

Condition:

```typescript
config.staticHTML
```

Directly returns `fallback.staticHTML`, status code `200`, and response header:

```http
X-Nami-Degraded: static-html
```

### Level 5: 503

After all strategies fail, it returns built-in 503 HTML:

```http
HTTP/1.1 503 Service Unavailable
X-Nami-Degraded: service-unavailable
Retry-After: 30
```

---

## 9. Degradation Config

Source locations:

- `packages/shared/src/types/config.ts`
- `packages/shared/src/constants/defaults.ts`

Type:

```typescript
export interface FallbackConfig {
  ssrToCSR: boolean;
  timeout: number;
  staticHTML?: string;
  maxRetries: number;
}
```

Default values:

```typescript
export const DEFAULT_FALLBACK_CONFIG = {
  ssrToCSR: true,
  timeout: 5000,
  maxRetries: 0,
};
```

Current actual usage:

| Field | Used by `DegradationManager` | Description |
|------|----------------------------------|------|
| `ssrToCSR` | Yes | Controls Level 2 |
| `maxRetries` | Yes | Controls Level 1 |
| `staticHTML` | Yes | Controls Level 4 |
| `timeout` | No | Has default value and validation, but the degradation manager and renderer timeout logic do not read it |

SSR/Streaming SSR timeout comes from `config.server.ssrTimeout`, not `fallback.timeout`.

`createNamiServer()` passes `publicPath` and an optional `assetManifest` when initializing `DegradationManager`. Therefore, whether the CSR degradation page can reference real content-hash assets depends on whether the startup path injects `assetManifest` into `createNamiServer`.

---

## 10. Renderer Errors and Plugin Hooks

Source location: `packages/core/src/renderer/*.ts`

Each Renderer tries to trigger the `renderError` hook when it fails, but the error type passed to plugins is not completely consistent:

| Renderer | `renderError` argument |
|----------|--------------------|
| `SSRRenderer` | `RenderError`, after `wrapError()` and before triggering the hook |
| `StreamingSSRRenderer` | `RenderError` |
| `ISRRenderer` | Raw `error`, then `wrapError()` |
| `CSRRenderer` | Raw `error` |
| `SSGRenderer` | Raw `error` |

The plugin type `RenderErrorHook` is:

```typescript
(context: RenderContext, error: Error) => void | Promise<void>
```

Therefore, plugins should not assume they always receive `RenderError`. If they need to read `code`, they should first check:

```typescript
if (error instanceof NamiError) {
  console.log(error.code);
}
```

### `createFallbackRenderer()`

`BaseRenderer` defines the fallback renderer chain:

```text
Streaming SSR -> SSR -> CSR
SSR           -> CSR
SSG           -> CSR
ISR           -> CSR
CSR           -> null
```

But the catch branch in the current `renderMiddleware` does not directly call `renderer.createFallbackRenderer()`. It delegates to `DegradationManager.executeWithDegradation()`. Therefore, documentation must not describe `createFallbackRenderer()` as a step that automatically runs on every render failure in the server main path.

---

## 11. Client Error Boundary

Source locations:

- `packages/client/src/app.tsx`
- `packages/client/src/error/client-error-boundary.tsx`

Client root component structure:

```tsx
<ClientErrorBoundary fallback={errorFallback} onError={...}>
  <NamiDataProvider initialData={initialData ?? {}}>
    <NamiHead />
    <NamiRouter />
  </NamiDataProvider>
</ClientErrorBoundary>
```

`ClientErrorBoundary` is a class component and uses React Error Boundary lifecycles:

| Method | Purpose |
|------|------|
| `getDerivedStateFromError(error)` | Sets `hasError: true` |
| `componentDidCatch(error, errorInfo)` | Logs and calls `props.onError` |
| `componentDidUpdate(prevProps)` | Checks whether `resetKeys` changed |
| `resetErrorBoundary()` | Clears error state and calls `onReset` |

`fallback` supports:

```typescript
React.ReactNode
| ((props: { error: Error; resetErrorBoundary: () => void }) => React.ReactNode)
```

The source comments mention a "React component form", but the implementation only distinguishes `typeof fallback === 'function'` and non-function. Function components can be used as render functions.

Default UI:

1. Title "Something went wrong on this page".
2. Displays `error.message` in development.
3. Displays "Please refresh the page and try again" in production.
4. Provides a "Retry" button that calls `resetErrorBoundary()`.

`ClientErrorBoundary` catches errors in browser-side rendering, lifecycle methods, and constructors. It cannot catch event handler errors, async callback errors, or server SSR errors.

---

## 12. Hydration Mismatch

Source locations:

- `packages/client/src/entry-client.tsx`
- `packages/client/src/hydration/hydration-mismatch.ts`

The client entry calls `hydrateApp()` in SSR/SSG/ISR modes when the container already has server HTML:

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

`reportMismatch()`:

1. Determines whether to report based on the sample rate.
2. Calls `detectMismatch()` for classification.
3. Constructs the payload.
4. If there is no `reportUrl`, only logs.
5. If `reportUrl` exists, prefers `sendBeacon`, then falls back to `fetch({ keepalive: true })`.

Hydration types:

| Type | Meaning |
|------|------|
| `text-content` | Text mismatch |
| `attribute` | Attribute mismatch |
| `element-type` | Node type mismatch |
| `extra-node` | Extra node on the client |
| `missing-node` | Missing node on the client |
| `unknown` | Could not classify |

`createMismatchError()` can convert a Hydration error into:

```typescript
new NamiError(
  message,
  ErrorCode.RENDER_HYDRATION_MISMATCH,
  ErrorSeverity.Warning,
  context,
)
```

But the current `onRecoverableError` in `entry-client.tsx` calls `reportMismatch()` and does not use `createMismatchError()`.

---

## 13. Plugin Participation in Error Handling

### `@nami/plugin-skeleton`

Source location: `packages/plugin-skeleton/src/skeleton-plugin.ts`

This plugin registers:

| Hook | Behavior |
|------|------|
| `wrapApp` | Wraps the app with `React.Suspense`; fallback is the skeleton component |
| `onBeforeRender` | Writes `__skeleton_layout`, `__skeleton_enabled` |
| `onRenderError` | Generates skeleton HTML and writes `__skeleton_fallback` |

The failure catch in `renderMiddleware` reads `__skeleton_fallback` first. Therefore, this plugin's server degradation HTML is actually consumed by the main path.

### `@nami/plugin-error-boundary`

Source location: `packages/plugin-error-boundary/src/error-boundary-plugin.ts`

This plugin registers:

| Hook | Behavior |
|------|------|
| `wrapApp` | Wraps the app with `RouteErrorBoundary` |
| `onRenderError` | Writes `__degradation_*` fields according to retry/degradation strategy |
| `onError` | Logs unhandled errors and calls external `onError` |

The current `renderMiddleware` consumes `__retry_attempted` and sets `X-Nami-Retry: 1`, but it does not consume `__degradation_html`, `__degradation_status`, `__degradation_reason`, and similar fields. The final degraded response actually returned to the user is still decided by `renderMiddleware`'s own `__skeleton_fallback` check and `DegradationManager`.

---

## 14. Typical Failure Paths

### SSR Data Function Throws

```text
SSRRenderer.prefetchData()
  -> getServerSideProps throws
  -> Renderer catch
  -> callPluginHook('renderError', context, renderError)
  -> throw RenderError
  -> renderMiddleware catch
  -> __skeleton_fallback ? direct skeleton
  -> DegradationManager
       Level 1 retry
       Level 2 CSR fallback
       Level 3 route.skeleton
       Level 4 staticHTML
       Level 5 503
```

### ISR Cache Layer Exception

```text
isrCacheMiddleware
  -> cacheStore.get/set throws
  -> catch cacheError
  -> await next()
  -> ctx.set('X-Nami-Cache', 'BYPASS')
```

The ISR cache is a performance optimization layer. Cache failures do not make the page fail by default; they bypass to real rendering.

### Renderer Creation Failure

```text
RendererFactory.create(mode) throws
  -> renderMiddleware catch
  -> RendererFactory.create({ mode: CSR, config, pluginManager, assetManifest })
  -> continue with CSR renderer
```

This path passes the plugin manager and uses the `assetManifest` provided when the middleware was initialized. If development mode `runtimeProvider` just read an updated manifest, the fallback path will not use that runtime manifest again.

### Client Component Render Failure

```text
page component render throws
  -> ClientErrorBoundary.getDerivedStateFromError
  -> componentDidCatch
  -> NamiApp.onError
  -> entry-client handleError
  -> pluginManager.runParallelHook('onError', error, { source: 'client-error-boundary' })
  -> display fallback or default error UI
```

---

## 15. Config Example

```typescript
export default defineConfig({
  fallback: {
    ssrToCSR: true,
    maxRetries: 1,
    staticHTML: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>Service temporarily unavailable</title></head>
        <body><h1>The page is temporarily unavailable. Please try again later.</h1></body>
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

Note: the `skeleton` field is currently only used by `DegradationManager` as a marker for enabling Level 3. It does not automatically load `./components/ProductSkeleton`. To return plugin-generated skeleton HTML, use `@nami/plugin-skeleton` or write `context.extra.__skeleton_fallback` yourself in `onRenderError`.

---

## 16. Common Misconceptions

### Misconception 1: All server middleware errors are captured by `errorIsolation`

No. `errorIsolation` is after user middleware and plugin server middleware. It only protects the ISR cache layer and render layer.

### Misconception 2: `fallback.timeout` controls SSR timeout

Not currently. SSR/Streaming SSR timeout comes from `server.ssrTimeout`. `fallback.timeout` has a type, default value, and validation, but the main degradation execution does not read it.

### Misconception 3: `route.skeleton` automatically loads a skeleton component

No. `DegradationManager` only checks whether `route.skeleton` exists, then returns built-in fixed skeleton HTML.

### Misconception 4: Degradation HTML written by `plugin-error-boundary` is definitely returned by the server

Currently, `renderMiddleware` does not consume `__degradation_html`. The fields directly consumed are `__skeleton_fallback`, `__cache_*`, `__custom_headers`, and `__retry_attempted`.

### Misconception 5: The `renderError` hook always receives `RenderError`

Not necessarily. SSR and Streaming SSR pass `RenderError`; ISR/CSR/SSG paths may pass the raw error.

### Misconception 6: The main render path automatically calls `ErrorHandler` and `ErrorReporter`

No. They are reusable core utilities. Whether reporting is wired depends on plugins, business integration, or custom middleware.

---

## Next Steps

- To understand how rendering mode failures enter this logic: read [Rendering Modes Internals](./rendering-modes.md)
- To understand ISR cache failure bypass: read [ISR and Caching Internals](./isr-and-caching.md)
- To understand the full middleware order: read [Server and Middleware](./server-and-middleware.md)
