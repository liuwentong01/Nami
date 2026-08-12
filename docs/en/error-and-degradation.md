# Error Handling and Degradation Internals

Nami's error handling is layered: the type system describes errors, server middleware isolates request-level exceptions, render middleware converts render failures into degraded responses, the client Error Boundary prevents browser blank screens, and Hydration utilities report SSR/client mismatch issues.

Two states that can both look like skeletons must be distinguished up front. Skeletons in the CSR shell, route chunks, and business data requests are recoverable **loading UI**. Level 3 is a **static emergency fallback** used after client takeover is unavailable; it does not wait for React to replace it.

This chapter focuses on "what the current source code actually executes", especially distinguishing defined utility classes from logic already wired into the main path.

---

## 1. Source Map

| Topic                                          | Source                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Error codes, severity levels, error classes    | `packages/shared/src/types/error.ts`                          |
| Error message templates                        | `packages/shared/src/constants/error-codes.ts`                |
| Default degradation config                     | `packages/shared/src/constants/defaults.ts`                   |
| `FallbackConfig`                               | `packages/shared/src/types/config.ts`                         |
| Unified error handler                          | `packages/core/src/error/error-handler.ts`                    |
| Error reporter                                 | `packages/core/src/error/error-reporter.ts`                   |
| Degradation manager                            | `packages/core/src/error/degradation.ts`                      |
| CSR shell and build-time static emergency HTML | `packages/core/src/html/csr-shell-loading.ts`                 |
| Renderer base class and plugin hooks           | `packages/core/src/renderer/base-renderer.ts`                 |
| Error wrapping in renderers                    | `packages/core/src/renderer/*.ts`                             |
| Server assembly order                          | `packages/server/src/app.ts`                                  |
| Error isolation middleware                     | `packages/server/src/middleware/error-isolation.ts`           |
| Render middleware degradation entry            | `packages/server/src/middleware/render-middleware.ts`         |
| Client app root component                      | `packages/client/src/app.tsx`                                 |
| Client error boundary                          | `packages/client/src/error/client-error-boundary.tsx`         |
| Hydration mismatch reporting                   | `packages/client/src/hydration/hydration-mismatch.ts`         |
| Client entry                                   | `packages/client/src/entry-client.tsx`                        |
| Default route loading skeleton                 | `packages/client/src/router/route-loading-fallback.tsx`       |
| `index.html` / `emergency.html` generation     | `packages/webpack/src/plugins/html-inject-plugin.ts`          |
| Skeleton plugin                                | `packages/plugin-skeleton/src/skeleton-plugin.ts`             |
| Error boundary plugin                          | `packages/plugin-error-boundary/src/error-boundary-plugin.ts` |

---

## 2. Error Model

Source location: `packages/shared/src/types/error.ts`

### Error Codes

`ErrorCode` is divided by module:

| Range       | Module               | Examples                                             |
| ----------- | -------------------- | ---------------------------------------------------- |
| `1000-1999` | Render errors        | `RENDER_SSR_FAILED`, `RENDER_HYDRATION_MISMATCH`     |
| `2000-2999` | Data prefetch errors | `DATA_FETCH_FAILED`, `DATA_GSP_FAILED`               |
| `3000-3999` | Cache errors         | `CACHE_READ_FAILED`, `CACHE_REDIS_CONNECTION_FAILED` |
| `4000-4999` | Route errors         | `ROUTE_NOT_FOUND`, `ROUTE_INVALID_CONFIG`            |
| `5000-5999` | Plugin errors        | `PLUGIN_LOAD_FAILED`, `PLUGIN_HOOK_FAILED`           |
| `6000-6999` | Build errors         | `BUILD_COMPILE_FAILED`                               |
| `7000-7999` | Server errors        | `SERVER_START_FAILED`, `SERVER_MIDDLEWARE_FAILED`    |
| `8000-8999` | Client errors        | `CLIENT_INIT_FAILED`, `CLIENT_ROUTING_FAILED`        |
| `9000-9999` | Config errors        | `CONFIG_VALIDATION_FAILED`, `CONFIG_NOT_FOUND`       |

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

This is a numeric enum. Level 0 to Level 5 in the documentation correspond to `None` through `ServiceUnavailable` here. The `Skeleton` name is retained for compatibility; Level 3 now has static-emergency semantics with no client takeover.

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

| Class            | Default error code         | Default severity |
| ---------------- | -------------------------- | ---------------- |
| `RenderError`    | `RENDER_SSR_FAILED`        | `Error`          |
| `DataFetchError` | `DATA_FETCH_FAILED`        | `Warning`        |
| `ConfigError`    | `CONFIG_VALIDATION_FAILED` | `Fatal`          |

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

| Capability              | Behavior                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| Enable switch           | `monitor.enabled`                                                         |
| Sampling                | `monitor.sampleRate`                                                      |
| Deduplication           | Set based on error code and message                                       |
| Server sending          | `setImmediate()` + `globalThis.fetch()`                                   |
| Client sending          | Prefer `navigator.sendBeacon()`, fallback to `fetch({ keepalive: true })` |
| Development environment | Skips reporting by default                                                |

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

| Placeholder      | Value                                                            |
| ---------------- | ---------------------------------------------------------------- |
| `{{statusCode}}` | `500`                                                            |
| `{{message}}`    | Real error in development, "Internal server error" in production |
| `{{requestId}}`  | Current request ID                                               |

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

`DegradationManager` owns the flow from the first render attempt:

```text
degradationManager.executeWithDegradation(renderFn, ...)
  -> Level 0 performs the first render attempt
  -> on failure, continue through Levels 1 to 5
  -> plugin emergency HTML is only a Level 3 candidate
  -> setResponse(ctx, degradationResult.result)
```

Important details:

1. `onRenderError` is triggered inside each Renderer so the middleware does not invoke it twice.
2. Streaming SSR reuses the same `renderToStream()` function for the initial attempt and retries.
3. `__csr_shell_skeleton` written by `plugin-skeleton` is used by normal and degraded CSR; `__skeleton_fallback` is consumed only by `DegradationManager` at Level 3 and cannot bypass retry or CSR.
4. `__degradation_*` fields written by `plugin-error-boundary` are not currently consumed by `renderMiddleware`; they are more like the plugin's own extension protocol/log information.

---

## 7. `applyPluginExtras`

Source location: `packages/server/src/middleware/render-middleware.ts`

After successful rendering, the middleware reads several convention fields from `context.extra`:

| Field                                              | Behavior                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `__cache_hit === true` + `__cache_content: string` | The Renderer returns it before data fetching; compatibility handling also sets the hit header |
| `__custom_headers`                                 | Merged into `result.headers`                                                                  |
| `__retry_attempted === true`                       | Sets `X-Nami-Retry: 1`                                                                        |
| Any extra                                          | Finally attached to `ctx.state.namiExtra`                                                     |

Renderers and `DegradationManager` additionally consume:

| Field                          | Behavior                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `__csr_shell_skeleton: string` | A recoverable loading fragment for normal CSR and Level 2; invalid fragments safely fall back to the built-in skeleton |
| `__skeleton_fallback: string`  | A Level 3 static emergency candidate                                                                                   |

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
Level 2: CSR fallback with a temporary skeleton
  fails ->
Level 3: static emergency fallback (compatibility name: Skeleton)
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
config.maxRetries > 0;
```

Each retry still calls the same `renderFn(context)`. After success, it marks:

```typescript
result.meta.degraded = true;
result.meta.degradeReason = `Retry attempt ${attempt} succeeded`;
```

### Level 2: CSR Fallback

Condition:

```typescript
config.ssrToCSR === true;
```

Returns a recoverable CSR shell:

```html
<div id="nami-root">
  <div data-nami-csr-shell="loading">...</div>
</div>
<script defer src="...client entry..."></script>
```

`#nami-root` is no longer empty. It displays a temporary skeleton while the client bundle downloads and runs; the first successful React commit replaces the shell content. Normal CSR uses this mechanism in `CSRRenderer`, while SSR→CSR Level 2 uses it in `DegradationManager`.

Shell content is resolved as follows:

1. Prefer `context.extra.__csr_shell_skeleton`. `NamiSkeletonPlugin` prepares it in `onBeforeRender` for normal CSR; for SSR→CSR it fills the fragment from `onRenderError`, while successful SSR/SSG/ISR avoids generating unused markup.
2. If the custom value is empty after trimming, or contains `doctype`, `html`, `head`, `body`, or `script` tags, inline event handlers, or `javascript:` URLs, Core rejects it and uses the built-in skeleton. This extension point accepts only a safe fragment inserted into `#nami-root`, not a nested document or executable markup.
3. Without the skeleton plugin, Core still uses its built-in skeleton, so normal and degraded CSR do not fall back to an empty container before JavaScript starts.

CSS/JS asset resolution:

1. If `assetManifest` was passed when constructing `DegradationManager`, use `ScriptInjector` to inject real assets.
2. Otherwise, use placeholder paths:
   - `${publicPath}static/css/main.css`
   - `${publicPath}static/js/main.js`

`createNamiServer()` passes the optional build `assetManifest` to `DegradationManager`:

```typescript
new DegradationManager({
  publicPath: config.assets.publicPath,
  assetManifest: options.assetManifest,
});
```

Production startup should therefore provide the manifest so the shell references real content-hashed assets reliably. Placeholder paths remain a compatibility path when no manifest is available.

Internal header produced by `DegradationManager`:

```http
X-Nami-Degraded: csr-fallback
```

When `setResponse()` writes the final Koa response, it preserves an existing semantic
value such as `csr-fallback`, and only supplies `X-Nami-Degraded: 1` when the result
did not provide the header. Every degraded result receives
`Cache-Control: private, no-store, max-age=0`.

### Level 3: Static Emergency Fallback (`Skeleton`)

Condition:

```typescript
context.extra.__skeleton_fallback ||
  (context.extra.__degradation_level === DegradationLevel.Skeleton &&
    context.extra.__degradation_html) ||
  context.route.skeleton;
```

For compatibility with existing enum and internal result checks, this level remains `DegradationLevel.Skeleton`; its `RenderResult` preserves:

```http
X-Nami-Degraded: skeleton
X-Nami-Fallback-Type: static-emergency
```

Level 3 first uses `__skeleton_fallback` from the skeleton plugin. It only accepts `__degradation_html` from the error-boundary plugin when that plugin also marks `__degradation_level` as `Skeleton`, preventing Level 4/5 content and status semantics from being rewritten as Level 3/200. Candidates pass the same passive-HTML allowlist check as `emergency.html`; unsafe content falls back to Core's built-in emergency page. Without plugin HTML, `route.skeleton` enables the built-in fixed emergency HTML. The route's string path is still not loaded as a component.

This response does not inject the client entry and has no automatic recovery protocol. It provides explicit static content and a reload action only after retry and recoverable CSR are unavailable; it must not be treated as a “still loading” skeleton. `__csr_shell_skeleton` and `__skeleton_fallback` are therefore intentionally separate protocol fields.

### Level 4: Static HTML

Condition:

```typescript
config.staticHTML;
```

Directly returns `fallback.staticHTML`, status code `200`, and this internal
`RenderResult` header:

```http
X-Nami-Degraded: static-html
```

### Level 5: 503

After all strategies fail, it returns built-in 503 HTML. `Retry-After` and the
semantic `X-Nami-Degraded` value are both preserved:

```http
HTTP/1.1 503 Service Unavailable
X-Nami-Degraded: service-unavailable
Retry-After: 30
```

### When the Node Process Is Unreachable: Build-Time `emergency.html`

Levels 0–5 all require the request to reach the Nami service. If the Node process, container, or upstream itself is unreachable, the runtime degradation chain cannot execute. The client build therefore also emits:

```text
{config.outDir}/client/emergency.html
# default: dist/client/emergency.html
```

This file is independent of Level 3 and must be explicitly configured as the upstream-unavailable error page in a reverse proxy, load balancer, or CDN. Its content prefers a safe `config.fallback.staticHTML`; Core validates a passive tag, attribute, URL, and CSS allowlist and rejects scripts, event handlers, SVG/iframe/object content, dangerous URLs, external CSS URLs, and unbalanced tags. Invalid markup falls back to Core's built-in static error page. The final artifact contains no application JavaScript or inline script, only an explanation and a normal reload link that require neither Node nor React.

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

| Field        | Used by `DegradationManager` | Description                                                                                             |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ssrToCSR`   | Yes                          | Controls Level 2                                                                                        |
| `maxRetries` | Yes                          | Controls Level 1                                                                                        |
| `staticHTML` | Yes                          | Controls Level 4; the client build also prefers it for `emergency.html` after passive-HTML allowlist checks   |
| `timeout`    | No                           | Has default value and validation, but the degradation manager and renderer timeout logic do not read it |

SSR/Streaming SSR timeout comes from `config.server.ssrTimeout`, not `fallback.timeout`.

`createNamiServer()` passes `publicPath` and an optional `assetManifest` when initializing `DegradationManager`. Therefore, whether the CSR degradation page can reference real content-hash assets depends on whether the startup path injects `assetManifest` into `createNamiServer`.

---

## 10. Renderer Errors and Plugin Hooks

Source location: `packages/core/src/renderer/*.ts`

Each Renderer tries to trigger the `renderError` hook when it fails, but the error type passed to plugins is not completely consistent:

| Renderer               | `renderError` argument                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `SSRRenderer`          | `RenderError`, after `wrapError()` and before triggering the hook |
| `StreamingSSRRenderer` | `RenderError`                                                     |
| `ISRRenderer`          | Raw `error`, then `wrapError()`                                   |
| `CSRRenderer`          | Raw `error`                                                       |
| `SSGRenderer`          | Raw `error`                                                       |

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

```text
ClientErrorBoundary (framework outer boundary protecting plugin wrappers)
  → wrapApp wrappers
       → NamiApp internal ClientErrorBoundary
            → BrowserRouter
                 → NamiDataProvider
                      ├─ RouteChangeListener
                      ├─ NamiHead
                      └─ Routes → Suspense → Page
```

The `wrapApp` waterfall runs outside the complete `NamiApp` tree. The framework then adds an
outermost error boundary so client render errors introduced by plugin wrappers also reach the
error page. `NamiDataProvider` actually lives in the route tree inside `BrowserRouter`, so a
wrapper must not depend on page-level initial NamiData.

### Three Loading UI Layers

Three separate layers own client loading states:

| Layer          | Time covered                                                                   | Recommended content                                   | Recovery                                           |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| CSR HTML shell | Bundle download, client initialization, and time before the first React commit | `__csr_shell_skeleton` or Core's built-in skeleton    | Replaced by the first successful React commit      |
| Route chunk    | Loading a `React.lazy` route component                                         | `NamiRouter` Suspense fallback                        | Render the page when the chunk resolves            |
| Business data  | Page requests, pagination, and partial refreshes                               | A layout-specific local skeleton or refresh indicator | Update only the corresponding region after success |

`NamiRouter` interprets `loadingFallback` as follows:

- Omitted or `undefined`: CSR first render and subsequent client navigation use the framework's default `RouteLoadingFallback`; initial SSR/SSG/ISR hydration keeps it `null` so a skeleton cannot disturb existing server DOM.
- Explicit `null`: disable the route fallback in every scenario.
- A `ReactNode`: use that custom fallback in every scenario.

The business-data layer should not clear useful content during a background refresh. With SWR, show a local skeleton for `loading && data === undefined`; for `loading && data !== undefined`, keep the stale data and add a refreshing indicator. On failure, expose the error and a retry action, retaining old data when available. Only an actual page render exception belongs to the Error Boundary; a permanent skeleton must not hide it.

`ClientErrorBoundary` is a class component and uses React Error Boundary lifecycles:

| Method                                | Purpose                                |
| ------------------------------------- | -------------------------------------- |
| `getDerivedStateFromError(error)`     | Sets `hasError: true`                  |
| `componentDidCatch(error, errorInfo)` | Logs and calls `props.onError`         |
| `componentDidUpdate(prevProps)`       | Checks whether `resetKeys` changed     |
| `resetErrorBoundary()`                | Clears error state and calls `onReset` |

`fallback` supports:

```typescript
React.ReactNode | ((props: { error: Error; resetErrorBoundary: () => void }) => React.ReactNode);
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

Normal server output injects `{ version: 1, props, degraded, renderMode, routePath }`.
The client calls `hydrateApp()` only when `version` is compatible with the current
protocol, the render mode is not CSR, and the container already has server HTML:

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

A stable static 404 is not hydratable output: it has neither this payload nor a
client bundle and never starts Hydration. An unknown protocol version safely falls
back to CSR rather than being treated as hydratable data.

`reportMismatch()`:

1. Determines whether to report based on the sample rate.
2. Calls `detectMismatch()` for classification.
3. Constructs the payload.
4. If there is no `reportUrl`, only logs.
5. If `reportUrl` exists, prefers `sendBeacon`, then falls back to `fetch({ keepalive: true })`.

Hydration types:

| Type           | Meaning                    |
| -------------- | -------------------------- |
| `text-content` | Text mismatch              |
| `attribute`    | Attribute mismatch         |
| `element-type` | Node type mismatch         |
| `extra-node`   | Extra node on the client   |
| `missing-node` | Missing node on the client |
| `unknown`      | Could not classify         |

`createMismatchError()` can convert a Hydration error into:

```typescript
new NamiError(message, ErrorCode.RENDER_HYDRATION_MISMATCH, ErrorSeverity.Warning, context);
```

But the current `onRecoverableError` in `entry-client.tsx` calls `reportMismatch()` and does not use `createMismatchError()`.

---

## 13. Plugin Participation in Error Handling

### `@nami/plugin-skeleton`

Source location: `packages/plugin-skeleton/src/skeleton-plugin.ts`

This plugin registers:

| Hook             | Behavior                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `wrapApp`        | Wraps the app with `React.Suspense`; fallback is the skeleton component                         |
| `onBeforeRender` | Writes layout markers and prepares `__csr_shell_skeleton` for a recoverable CSR shell           |
| `onRenderError`  | Fills the shell fragment if necessary and writes static emergency HTML to `__skeleton_fallback` |

Normal CSR and Level 2 consume `__csr_shell_skeleton` while still loading JavaScript. Only after retry and CSR are unavailable does `DegradationManager` consume `__skeleton_fallback` at Level 3.

### `@nami/plugin-error-boundary`

Source location: `packages/plugin-error-boundary/src/error-boundary-plugin.ts`

This plugin registers:

| Hook            | Behavior                                                                |
| --------------- | ----------------------------------------------------------------------- |
| `wrapApp`       | Wraps the app with `RouteErrorBoundary`                                 |
| `onRenderError` | Writes `__degradation_*` fields according to retry/degradation strategy |
| `onError`       | Logs unhandled errors and calls external `onError`                      |

The current `renderMiddleware` consumes `__retry_attempted` and sets `X-Nami-Retry: 1`; `DegradationManager` only uses `__degradation_html` as the second Level 3 static-emergency candidate when `__degradation_level === Skeleton`. `__degradation_status` and `__degradation_reason` remain observational plugin fields and do not directly override the core response protocol. `DegradationManager` still decides the final level uniformly.

---

## 14. Typical Failure Paths

### SSR Data Function Throws

```text
SSRRenderer.prefetchData()
  -> getServerSideProps throws
  -> Renderer catch
  -> callPluginHook('renderError', context, renderError)
  -> throw RenderError
  -> DegradationManager catches the Level 0 error
       Level 1 retry
       Level 2 CSR fallback
       Level 3 plugin static emergency / route.skeleton
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

Note: the `skeleton` field is currently only used by `DegradationManager` as a marker for enabling Level 3. It does not automatically load `./components/ProductSkeleton`. To return plugin-generated Level 3 static-emergency HTML, use `@nami/plugin-skeleton` or write `context.extra.__skeleton_fallback` yourself in `onRenderError`.

---

## 16. Common Misconceptions

### Misconception 1: All server middleware errors are captured by `errorIsolation`

No. `errorIsolation` is after user middleware and plugin server middleware. It only protects the ISR cache layer and render layer.

### Misconception 2: `fallback.timeout` controls SSR timeout

Not currently. SSR/Streaming SSR timeout comes from `server.ssrTimeout`. `fallback.timeout` has a type, default value, and validation, but the main degradation execution does not read it.

### Misconception 3: `route.skeleton` automatically loads a skeleton component

No. `DegradationManager` only checks whether `route.skeleton` exists, then returns built-in fixed static emergency HTML. It neither loads the React component referenced by the string nor serves as the route-chunk loading fallback.

### Misconception 4: Degradation fields written by `plugin-error-boundary` directly override the core response

They do not. At Level 3, `DegradationManager` only treats `__degradation_html` as the secondary static-emergency candidate after `__skeleton_fallback` when `__degradation_level === Skeleton`, and applies the passive-HTML allowlist check. Plugin status and reason fields cannot bypass core retry, CSR, or cache protocols.

### Misconception 5: The `renderError` hook always receives `RenderError`

Not necessarily. SSR and Streaming SSR pass `RenderError`; ISR/CSR/SSG paths may pass the raw error.

### Misconception 6: The main render path automatically calls `ErrorHandler` and `ErrorReporter`

No. They are reusable core utilities. Whether reporting is wired depends on plugins, business integration, or custom middleware.

---

## Next Steps

- To understand how rendering mode failures enter this logic: read [Rendering Modes Internals](./rendering-modes.md)
- To understand ISR cache failure bypass: read [ISR and Caching Internals](./isr-and-caching.md)
- To understand the full middleware order: read [Server and Middleware](./server-and-middleware.md)
