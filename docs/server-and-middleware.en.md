# Server and middleware



The Nami server assembles the request processing pipeline based on Koa. To understand this chapter, the key is not to just remember "what middleware does", but to understand three things:



1. Koa middleware is an onion model, inbound requests are processed before `await next()`, and outbound responses are processed after `await next()`.
2. The "registration order" and "the location where the response is actually generated" are not always exactly the same. For example, the static resource middleware defaults to `defer: true`, which will first hand over control to the downstream.
3. Production servers, development servers, cluster mode, and graceful shutdown share some capabilities, but the entrances and pipelines are not exactly the same.



This chapter mainly corresponds to the following source code:



| Theme | Source Code |
|------|------|
| Koa application creation and production pipeline | `packages/server/src/app.ts` |
| Service startup, monitoring, graceful shutdown mounting | `packages/server/src/server.ts` |
| Shutdown awareness and graceful shutdown | `packages/server/src/middleware/graceful-shutdown.ts` |
| Request timing | `packages/server/src/middleware/timing.ts` |
| Security response header | `packages/server/src/middleware/security.ts` |
| Request context | `packages/server/src/middleware/request-context.ts` |
| Health Check | `packages/server/src/middleware/health-check.ts` |
| Static resources | `packages/server/src/middleware/static-serve.ts` |
| Routing data prefetch interface | `packages/server/src/middleware/data-prefetch-middleware.ts` |
| Route matching | `packages/server/src/middleware/route-match.ts` |
| Error isolation | `packages/server/src/middleware/error-isolation.ts` |
| ISR caching middleware | `packages/server/src/middleware/isr-cache-middleware.ts` |
| Core rendering middleware | `packages/server/src/middleware/render-middleware.ts` |
| ISR Manager and SWR Determination | `packages/server/src/isr/isr-manager.ts`, `packages/server/src/isr/stale-while-revalidate.ts` |
| Cluster main process and Worker | `packages/server/src/cluster/master.ts`, `packages/server/src/cluster/worker.ts` |
| Development Server | `packages/server/src/dev/dev-server.ts`, `packages/server/src/dev/hmr-middleware.ts` |



---



## 1. Koa onion model



The basic form of Koa middleware is:



```typescript
app.use(async (ctx, next) => {
  // Inbound phase: the request enters from the outer layer to the inner layer
  await next();
  // Outbound phase: after downstream completes, the response returns from the inner layer to the outer layer
});
```



When the request comes in, it is executed in the registration order; when the response is returned, it goes back to the outer layer in the reverse order. Nami uses this mechanism to achieve several key capabilities:



| Capabilities | Why rely on the onion model |
|------|--------------------|
| `timingMiddleware` | Record the high-precision start time inbound, calculate the complete link time outbound and write it to `X-Response-Time` |
| `securityMiddleware` | The downstream determines the response body and cache semantics first, and then uniformly fills in the security header and final `Cache-Control` when outgoing |
| `isrCacheMiddleware` | `await next()` triggers rendering when cache misses, reads after rendering is completed `ctx.body` writes to ISR cache |
| `errorIsolationMiddleware` | Wrap only downstream ISR and render layers with `try { await next() } catch { ... }` |



Special attention needs to be paid: If a certain middleware does not call `next()`, the request will be short-circuited and returned in the middleware. For example, if the health check hits `/_health`, it will not enter the static resources, data prefetching and rendering layers.



---



## 2. Overview of production middleware pipeline



The production server is created in `createNamiServer(config, options)` and the core pipeline is registered in `packages/server/src/app.ts` in the following order:



```text
request inbound
  │
  ▼
① shutdownAware
  │ When the shutdown mark is turned on, 503 will be issued directly and no subsequent middleware will be entered.
  ▼
② timing
  │ Inbound logging process.hrtime.bigint()
  ▼
③ security
  │ Write the security header in the outbound phase and write back ctx.state.namiCacheControl
  ▼
④ requestContext
  │ Generate or transparently transmit requestId and create request-level logger
  ▼
⑤ healthCheck
  │ Short circuit return when hitting /_health
  ▼
⑥staticServe
  │ Register here, but the default defer: true will let the downstream process it first, and then fall back and try to send static files.
  ▼
⑦ config.server.middlewares
  │ User-defined Koa middleware, located before plug-in middleware
  ▼
⑧ pluginManager.getServerMiddlewares()
  │ Plug-ins are registered through api.addServerMiddleware() and collected in order of plugin enforce
  ▼
⑨ dataPrefetch
  │ When GET /_nami/data/* is hit, the page data function is executed and JSON is returned
  ▼
⑩ errorIsolation
  │ try/catch wraps downstream ISR and render
  ▼
⑪ isrCacheMiddleware
  │ Only registered when config.isr.enabled; short-circuit returns HTML when hitting the ISR cache
  ▼
⑫ renderMiddleware
  │ Route matching, constructing RenderContext, selecting renderer, setting response
  │
  ▼
Respond to outbound
```



### Sequential design



| Location | Middleware | Sequence Reason |
|------|--------|----------|
| ① | `shutdownAware` | Outermost layer, new requests should return to `503` as soon as possible after receiving the shutdown signal to avoid continuing to occupy the exiting instance |
| ② | `timing` | Need to cover the complete request link except shutdown short circuit |
| ③ | `security` | Registered first, but the real write head is in the outbound stage, and the final downstream cache semantics can be obtained |
| ④ | `requestContext` | Subsequent health checks, data prefetching, rendering, and logging can all use the same `requestId` |
| ⑤ | `healthCheck` | Probe requests should not trigger static resource lookups, plug-in logic, or rendering |
| ⑥ | `staticServe` | Static resources are sent uniformly by the framework; the packaging layer will supplement the cache header for the 2xx response according to the final path |
| ⑦ | User middleware | The business can inject Koa logic before the plug-in, such as authentication, proxy, API mock |
| ⑧ | Plug-in middleware | Plug-ins provide server-side extensions in the `enforce: pre -> normal -> post` registration order |
| ⑨ | `dataPrefetch` | The data prefetch API is a routing data interface, located behind the business/plug-in middleware, and returns JSON after a hit |
| ⑩ | `errorIsolation` | Protect the core ISR and rendering layer of the framework and not swallow the exceptions of the user/plug-in middleware itself |
| ⑪ | `isrCache` | A cache hit must be made before rendering to skip the expensive React SSR /ISR rendering |
| ⑫ | `render` | The innermost layer is responsible for the final page response |



User middleware and plug-in middleware are upstream in `errorIsolation`, which is the actual behavior of the current source code. The exceptions they throw will not be caught by `errorIsolationMiddleware`, but continue to bubble out to Koa's `app.on('error')` for bottom-up processing; if the business wants to return a specific status code, it should capture and set `ctx.status` / `ctx.body` inside its own middleware.



---



## 3. Principle of each middleware



### ① `shutdownAware`: shutdown awareness



Source code location: `packages/server/src/middleware/graceful-shutdown.ts`



`createShutdownAwareMiddleware()` returns two things:



```typescript
{
  middleware,
  triggerShutdown,
}
```



There is only one closure variable inside:



```typescript
let isShuttingDown = false;
```



Under normal circumstances, the middleware directly `await next()`. Once `triggerShutdown()` is called, subsequent new requests will get directly:



| Response item | Value | Effect |
|--------|----|------|
| Status code | `503` | Tells the load balancer that the current instance is unavailable |
| `Connection` | `close` | Tell the client not to reuse the current connection |
| `Retry-After` | `5` | It is recommended that the client or agent try again later |
| Body | `{ status: 'shutting_down', message: 'The service is shutting down. Please try again later' }` | Clear shutdown status |



`triggerShutdown()` passed to `onSignalReceived` in `startServer()`. In other words, after the process receives `SIGTERM` or `SIGINT`, it will first turn on the shutdown awareness switch, and then call `server.close()` to stop receiving new TCP connections.



This middleware only affects "new requests coming into Koa after the shutdown flag is turned on". Requests that have entered the downstream will not be interrupted by it, but will be handed over to the graceful shutdown process to wait for completion.



### ② `timingMiddleware`: Request timing



Source code location: `packages/server/src/middleware/timing.ts`



Its inbound logic:



```typescript
const startTime = process.hrtime.bigint();
ctx.state.requestStartTime = startTime;
await next();
```



Outbound logic:



```typescript
const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
ctx.set('X-Response-Time', `${durationMs.toFixed(2)}ms`);
```



`process.hrtime.bigint()` is used here instead of `Date.now()` because it is a monotonic clock and is not affected by system time dialback or calibration, making it more suitable for time-consuming calculations. `ctx.state.requestStartTime` will also be passed to the downstream, so that other middleware or rendering layers can calculate the time-consuming phase based on the same starting point.



Since writing the response header occurs after `await next()`, `X-Response-Time` can only be written when the downstream returns normally, or the downstream error is converted into a response by the inner `errorIsolation`. If user/plugin middleware throws an error upstream in `errorIsolation` and bubbles it out, Koa's fallback error handling will not necessarily preserve this header.



### ③ `securityMiddleware`: Security response headers and cache headers



Source code location: `packages/server/src/middleware/security.ts`



This middleware is also "downstream first, then writes the header":



```typescript
await next();

if (
  typeof ctx.state.namiCacheControl === 'string'
  && ctx.state.namiCacheControl.length > 0
) {
  ctx.set('Cache-Control', ctx.state.namiCacheControl);
}

ctx.set('X-Frame-Options', 'SAMEORIGIN');
ctx.set('X-Content-Type-Options', 'nosniff');
ctx.set('X-XSS-Protection', '1; mode=block');
ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
ctx.set('Content-Security-Policy', DEFAULT_CSP);
ctx.remove('X-Powered-By');
```



The default security headers are as follows:



| Response header | Default value | Meaning |
|--------|--------|------|
| `X-Frame-Options` | `SAMEORIGIN` | Only allow same-origin pages to be embedded through iframes to reduce the risk of clickjacking |
| `X-Content-Type-Options` | `nosniff` | Disable browser MIME sniffing |
| `X-XSS-Protection` | `1; mode=block` | Enable old browser built-in XSS filters |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Tell the browser to enforce HTTPS on subdomains for one year |
| `Content-Security-Policy` | `DEFAULT_CSP` | Restrict resource sources such as scripts, styles, pictures, fonts, connections, etc. |



The default CSP is:



```text
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self';
media-src 'self';
object-src 'none';
frame-ancestors 'self'
```



`'unsafe-inline'` and `'unsafe-eval'` are for compatibility with SSR water injection scripts, development debugging and some runtime requirements. If a production project has stricter security requirements, the policy should be tightened through options such as `csp` / `cspEnabled` of `securityMiddleware(options)`.



`Strict-Transport-Security` is currently written uniformly in the response phase by default, without additional judgment `ctx.secure`. It is usually only adopted by browsers under HTTPS access; even if the header exists in the response during pure HTTP local debugging, it does not mean that the browser will establish an HSTS policy.



`Cache-Control` is not calculated in the security middleware. ISR middleware or rendering results will link the final cache semantics to `ctx.state.namiCacheControl`, `securityMiddleware` and then write it back once in the outbound phase to prevent the inner historical logic from overwriting the core cache protocol. Only non-empty strings will be written back, empty strings will not overwrite existing response headers.



### ④ `requestContextMiddleware`: Request context and log link



Source code location: `packages/server/src/middleware/request-context.ts`



Request context middleware does four things:



1. Read `x-request-id` from the request header.
2. If the upstream does not pass in, use `uuidv4()` to generate a new request ID.
3. Write `ctx.state.requestId` and `ctx.state.logger`.
4. Return `X-Request-Id` in the response header.



Downstream middleware can be used directly:



```typescript
const requestId = ctx.state.requestId;
const logger = ctx.state.logger;
```



`ctx.state.logger` is a child logger created based on `createLogger('@nami/server')` and will automatically carry `requestId`. Therefore, data prefetching, ISR, rendering, and error isolation logs can all be associated with the same request.



### ⑤ `healthCheckMiddleware`: Health check short circuit



Source code location: `packages/server/src/middleware/health-check.ts`



The default path is `HEALTH_CHECK_PATH` from `@nami/shared`:



```typescript
export const HEALTH_CHECK_PATH = '/_health';
```



Execution rules:



| Request | Behavior |
|------|------|
| `GET /_health` | Returns `200` JSON |
| `HEAD /_health` | Returns `200`, Koa will process the response body according to HEAD semantics |
| Other methods access `/_health` | Return `405 { error: 'Method Not Allowed' }` |
| Non-`/_health` path | `await next()` handed to downstream |



Default health response:



```json
{
  "status": "ok",
  "uptime": 12.34,
  "timestamp": "2026-04-30T00:00:00.000Z"
}
```



If you pass `checker` when creating middleware, it will perform a custom check before returning `ok`. When `checker` returns `false` or throws an error, respond with `503`:



| Scene | Status Code | Body |
|------|--------|------|
| `checker()` returns `false` | `503` | `{ status: 'unhealthy', uptime, timestamp }` |
| `checker()` throws exception | `503` | `{ status: 'error', error, uptime, timestamp }` |



`next()` is not called after a health check hit. This guarantees that K8s, load balancers, or monitoring probes will not trigger static file lookups, route data functions, or React rendering.



### ⑥ `staticServeMiddleware`: Static resource service



Source code location: `packages/server/src/middleware/static-serve.ts`



Static resource middleware is based on the `koa-static` wrapper. The production assembly will set `root` to `${process.cwd()}/{config.outDir}/client`, so when customizing `outDir`, the corresponding client product directory will also be read; when calling the middleware directly and separately, the default configuration is as follows:



| Options | Default | Description |
|------|--------|------|
| `root` | `${process.cwd()}/dist/client` | Client build product directory |
| `maxAge` | `31536000` | Number of seconds to cache resources with hash |
| `htmlMaxAge` | `0` | Base caching seconds for non-hash resources |
| `gzip` | `true` | Supports `.gz` precompressed files |
| `brotli` | `true` | Supports `.br` precompressed files |
| `defer` | `true` | Execute the downstream first, then try to send the file if the downstream is not processed |



The most misunderstood here is `defer: true`. Although `staticServeMiddleware` is registered before user middleware, plug-in middleware, `dataPrefetchMiddleware` and `renderMiddleware`, `koa-static` will first `await next()` and only try to send files from the client product directory when no response is produced downstream. The actual effect is:



```text
Static resource request /assets/main.abcdef12.js
  ├─ staticServe inbound
  ├─ First enter user middleware / plug-in middleware / dataPrefetch / errorIsolation / render
  ├─ render does not match the page route, return
  └─ staticServe falls back to find {outDir}/client/assets/main.abcdef12.js and send
```



This design allows static resources to exist as the framework's bottom-up capabilities, while avoiding unconditional preemption of subsequent business middleware. It should be noted that the current packaging layer does not additionally determine "whether the file is hit by `koa-static`", but checks whether the final `ctx.status` is 2xx after `koa-static` returns, and writes the cache header according to `ctx.path`. Therefore, it not only adds the cache policy to static files, but also adds the default `public, no-cache` to successfully generated pages downstream; if the rendering result or ISR middleware sets `ctx.state.namiCacheControl`, the outer layer `securityMiddleware` will rewrite the final cache semantics back in the later outbound phase.



| final `ctx.path` | matching rules | `Cache-Control` |
|------------------|----------|------------------|
| `/assets/main.abcdef12.js` | Contains more than 8 digits of hexadecimal hash: `/\.[a-f0-9]{8,}\.\w+$/i` | `public, max-age=31536000, immutable` |
| `/index.html`, `/dashboard`, `/asset-manifest.json`, etc. | Do not match hash rules | `public, no-cache` |



`koa-static` The bottom layer sends files through `koa-send`, supporting ETag, Last-Modified, Range requests and path security verification. Nami only supplements resource caching strategies outside of it.



### ⑦ `dataPrefetchMiddleware`: Routing data prefetch API



Source code location: `packages/server/src/middleware/data-prefetch-middleware.ts`



The data prefetch API is prefixed from `@nami/shared`:



```typescript
export const NAMI_DATA_API_PREFIX = '/_nami/data';
```



It only handles `GET /_nami/data/*`. Other methods or other paths will `await next()`.



Complete process:



1. Remove the `/_nami/data` prefix and normalize the remaining parts into page paths.
2. Call `matchConfiguredRoute(requestPath, config.routes)` to match the route.
3. Get the latest runtime via `runtimeProvider()`, or use `moduleLoader` injected at startup.
4. Select `getServerSideProps` or `getStaticProps` based on route `renderMode`.
5. Use `moduleLoader.getExportedFunction(route.component, exportName)` to find the page data function from the server bundle.
6. Execute the data function and convert the result into a JSON response.



Route matching uses `packages/server/src/middleware/route-match.ts`, which internally reuses `rankRoutes + matchPath` of `@nami/core`:



```typescript
const sortedRoutes = rankRoutes(routes);
for (const route of sortedRoutes) {
  const exact = route.exact !== false;
  const result = matchPath(route.path, requestPath, { exact });
}
```



In this way, `dataPrefetch`, `isrCache` and `render` use the same set of routing priorities to avoid the bifurcation of "the data interface hits route A, and the actual rendering hits route B".



#### SSR routing



When the route satisfies:



```typescript
route.renderMode === RenderMode.SSR && route.getServerSideProps
```



The middleware will load and execute `getServerSideProps`. Incoming parameters include:



| Field | Source |
|------|------|
| `params` | Routing dynamic parameters |
| `query` | Koa `ctx.query`, keep only strings or string arrays |
| `headers` | Request header, lowercase key |
| `path` | Page path without data API prefix |
| `url` | Page path + querystring |
| `cookies` | Key-value pair parsed from `Cookie` header |
| `requestId` | `ctx.state.requestId`, otherwise `'unknown'` |



Response rules:



| `getServerSideProps` Result | HTTP Response |
|--------------------------|----------|
| Function export does not exist | `404 { message: 'getServerSideProps not found' }` |
| `{ notFound: true }` | `404 { notFound: true }` |
| `{ redirect }` | `statusCode` takes priority, otherwise it will jump permanently to `308`, temporary jump to `307`, and the Body is `{ redirect }` |
| `{ props }` or empty result | `200`, Body is `props ?? {}` |



#### SSG / ISR routing



When the route satisfies:



```typescript
(route.renderMode === RenderMode.SSG || route.renderMode === RenderMode.ISR)
  && route.getStaticProps
```



The middleware will load and execute `getStaticProps`, and the current data API only passes in:



```typescript
{ params: matchResult.params }
```



Response rules:



| `getStaticProps` Result | HTTP Response |
|----------------------|----------|
| Function export does not exist | `404 { message: 'getStaticProps not found' }` |
| `{ notFound: true }` | `404 { notFound: true }` |
| `{ redirect }` | Permanent jump to `308`, temporary jump to `307`, Body is `{ redirect }` |
| `{ props }` or empty result | `200`, Body is `props ?? {}` |



If the route exists but no page data is needed, return:



```http
204 No Content
```



If `moduleLoader` is not available, the middleware will log debug and `await next()`. This is very important before the first compilation of the development server is completed or when the caller does not inject the server runtime to avoid the data API directly failing the entire request.



Data prefetching API and above-the-fold water injection are not the same thing:



| Mechanism | Location | Purpose |
|------|------|------|
| `/_nami/data/*` | Koa middleware | Client routing prefetch data |
| `window.__NAMI_DATA__` | HTML injection script | Above the fold SSR/SSG/ISR Bring server data to the browser hydration |



### ⑧ `config.server.middlewares`: User-defined middleware



Source code location: `packages/server/src/app.ts`, `packages/shared/src/types/config.ts`



Configuration type:



```typescript
server: {
  middlewares?: Array<import('koa').Middleware>;
}
```



Registration logic:



```typescript
if (config.server.middlewares && config.server.middlewares.length > 0) {
  for (const mw of config.server.middlewares) {
    app.use(mw);
  }
}
```



These middlewares are located after static resources, before plug-in middleware, before data prefetching, and before error isolation. Common uses:



| Purpose | Description |
|------|------|
| API mock | Intercept `/api/*` and return test data |
| Custom authentication | Check Cookie / Header before entering plug-in and rendering |
| Proxy | Forward specific paths to backend services |
| Grayscale mark | Written to `ctx.state` for subsequent plug-ins or rendering logic to read |



If you want a request not to go into page rendering, user middleware should set `ctx.status` / `ctx.body` and not call `next()`.



### ⑨ Plug-in middleware: `api.addServerMiddleware()`



Source code location:



- `packages/server/src/app.ts`
- `packages/core/src/plugin/plugin-manager.ts`
- `packages/core/src/plugin/plugin-api-impl.ts`



The plugin is called in the `setup(api)` stage:



```typescript
api.addServerMiddleware(async (ctx, next) => {
  await next();
});
```



`PluginAPIImpl` will store the middleware together with the plug-in name in the plug-in's own `middlewares` list. `PluginManager.getServerMiddlewares()` then collects all plug-in middleware in the order of plug-in registration.



Plug-ins will be sorted by `enforce` before registration:



```text
enforce: 'pre' -> normal plug-in -> enforce: 'post'
```



So the overall order of plugin middleware is also:



```text
pre plug-in middleware -> ordinary plug-in middleware -> post plug-in middleware
```



In the current production pipeline, plug-in middleware and user middleware are located upstream of `errorIsolation`. Exceptions inside plugin middleware are not caught by `errorIsolationMiddleware`; plugin authors should handle expected errors in their own middleware and avoid letting plugin extensions affect core rendering stability.



### ⑩ `errorIsolationMiddleware`: Framework core error boundary



Source code location: `packages/server/src/middleware/error-isolation.ts`



The core structure of error isolation middleware:



```typescript
try {
  await next();
} catch (error) {
  ctx.status = 500;
  ctx.type = 'text/html; charset=utf-8';
  ctx.set('X-Nami-Error', 'true');
  ctx.body = errorPageHTML ?? getDefaultErrorPage(requestId, isDev, error);
}
```



It wraps the downstream:



```text
errorIsolation
  └─ isrCacheMiddleware
       └─ renderMiddleware
```



After catching the exception:



1. Normalize non-`Error` throw values to `Error`.
2. Read `requestId` and the request-level logger from `ctx.state`.
3. Document the method, URL, User-Agent, IP, error message, and stack.
4. Optional execution of `onError(error, ctx)`, but the callback itself is also wrapped by try/catch.
5. Return static 500 HTML to prevent the error page from relying on React rendering again.



The default error page in the development environment will display error messages and stacks; in the production environment, only general errors and `requestId` will be displayed to avoid leaking internal information. The error message in the error page will be HTML escaped to reduce the risk of secondary XSS.



### ⑪ `isrCacheMiddleware`: ISR cache layer



Source code location:



- `packages/server/src/middleware/isr-cache-middleware.ts`
- `packages/server/src/isr/isr-manager.ts`
- `packages/server/src/isr/stale-while-revalidate.ts`



This middleware is only registered when `config.isr.enabled` is `true`. It only handles normal page `GET` requests, and will skip internal revalidation requests that pass the verification:



```typescript
if (ctx.method !== 'GET') await next();
if (isInternalRevalidateRequest(ctx, config)) await next();
```



The internal reauthentication request header comes from `@nami/shared`:



```typescript
export const NAMI_ISR_REVALIDATE_HEADER = 'x-nami-isr-revalidate';
```



ISR routing judgment conditions:



```typescript
route.renderMode === RenderMode.ISR && config.isr.enabled
```



The cache key defaults to:



```typescript
ctx.path
```



That is to say, query, cookie or header are not included by default. If the page content depends on these factors, you need to customize the cache key through `generateCacheKey`, otherwise different variants may share the same cache.



#### Hit process



`isrCacheMiddleware` calls:



```typescript
isrManager.getOrRevalidate(cacheKey, renderFn, revalidateSeconds, backgroundRevalidateFn)
```



`ISRManager` uses SWR semantics to determine cache status:



```text
0 ───────────── revalidateAfter ───────────── revalidateAfter * 2 ──────▶ Time
      Fresh Stale Expired
```



| Status | Judgment | Behavior |
|------|------|------|
| `Fresh` | Cache age `<= revalidateAfter` | Return cached HTML directly |
| `Stale` | Exceeded `revalidateAfter`, but not exceeded `revalidateAfter * staleMultiplier` | Return the old HTML while revalidating in the background |
| `Expired` | stale grace period exceeded | Do not return old HTML, re-render synchronously |
| Cache does not exist | No cache entry | Render synchronously and write to cache asynchronously |



The default `staleMultiplier` is `2`. For example `revalidate = 60`:



```text
0-60 seconds: Fresh, return directly to HIT
60-120 seconds: Stale, return old content and re-verify in the background
After 120 seconds: Expired, synchronous rendering
```



#### Cache hit response header



When there is a cache hit and not a cache miss, the middleware sets it directly:



| response header | value |
|--------|----|
| `Content-Type` | `text/html; charset=utf-8` |
| `X-Nami-Cache` | `HIT` or `STALE` |
| `X-Nami-Render-Mode` | `isr` |
| `Cache-Control` | `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}` |
| `ETag` | ETag in the cache entry, optional |
| `X-Nami-Cache-Age` | The number of seconds since the cache was created, optional |



On a cache miss, `renderFn` executes `await next()` into `renderMiddleware`. After rendering is complete, the ISR middleware reads:



```typescript
{
  html: typeof ctx.body === 'string' ? ctx.body : String(ctx.body || ''),
  tags: ctx.state.namiCacheTags,
}
```



It is then written to the cache by `ISRManager`. The write cache is asynchronous and does not block this response.



#### Background re-verification



In the Stale state, the middleware will not re-render directly in the current request, but will initiate an internal GET request through `revalidateByInternalRequest(ctx)`:



```typescript
fetch(internalURL, {
  method: 'GET',
  headers: {
    [NAMI_ISR_REVALIDATE_HEADER]: '1',
    'x-nami-isr-revalidate-token': process.env.NAMI_ISR_REVALIDATE_TOKEN,
    'X-Requested-With': 'nami-isr-revalidate',
  },
});
```



Internal URLs do not use `Host` for browser inbound requests. The source code will normalize the listening host to the local address (for example, `0.0.0.0`/`::` will use `127.0.0.1`), and the port will be `config.server.port` first. Otherwise, the local port of the current socket will be taken, and the path and querystring of the current request will be spliced.



The request carries `x-nami-isr-revalidate: 1`, but when it passes through the ISR middleware again, it needs to meet the trusted source verification: the request source IP must be a loopback address or match the explicitly configured local host; if `NAMI_ISR_REVALIDATE_TOKEN` is configured, it must also carry a matching token. After the verification is passed, the cache layer will be bypassed and the rendering middleware will be directly entered to generate new HTML to avoid the cycle of "backend re-validation and hitting the stale cache again".



When a cache query fails, the ISR middleware does not fail the page, but instead downgrades to direct `await next()` rendering, setting:



```http
X-Nami-Cache: BYPASS
```



### ⑫ `renderMiddleware`: core page rendering



Source code location: `packages/server/src/middleware/render-middleware.ts`



Rendering middleware only handles:



```text
GET / HEAD
```



Other methods directly `await next()`. The page rendering process is as follows:



```text
1. matchConfiguredRoute(ctx.path, config.routes)
2. createRenderContext(ctx, matchResult, requestId)
3. runtimeProvider() gets the latest server runtime (especially important in development mode)
4. RendererFactory.create({ mode, config, pluginManager, ... })
5. renderer.render(context) or streaming renderer.renderToStream(context)
6. applyPluginExtras(ctx, renderContext, result, logger)
7. setResponse(ctx, result, logger)
```



#### Route not matched



If `matchConfiguredRoute()` does not match the page route, the rendering middleware will not actively return 404, but:



```typescript
await next();
return;
```



Since it is the innermost layer of the production pipeline, this usually means that the request is eventually handled by the outer static resource middleware fallback, or ended by Koa's default 404 semantics.



#### `RenderContext`



`createRenderContext()` will construct the framework rendering context from the Koa context:



| Field | Content |
|------|------|
| `url` / `path` | Current request URL and pathname |
| `query` | Query parameters, only strings and string arrays |
| `headers` | Request header, lowercase key |
| `route` | Hitting `NamiRoute` |
| `params` | Dynamic routing parameters |
| `koaContext` | method, path, url, querystring, protocol, ip, origin, hostname, secure, cookies |
| `timing.startTime` | Rendering context creation time |
| `requestId` | Request ID |
| `extra` | A new object independent of each request, used to pass contract fields between plug-ins and middleware |



`extra` is initialized on each request to create `RenderContext` and `{}` is not shared across requests.



#### Renderer selection



Rendering mode taken from:



```typescript
matchResult.route.renderMode || config.defaultRenderMode
```



The renderer is then created via `RendererFactory.create()`. Important parameters passed in include:



| Parameters | Function |
|------|------|
| `config` | Global configuration |
| `pluginManager` | Let the renderer trigger the plug-in life cycle internally |
| `appElementFactory` | Create React element tree under new SSR protocol |
| `htmlRenderer` | Compatible with `entry-server.renderToHTML()` |
| `moduleLoader` | Load page data function |
| `isrManager` | ISR renderer usage |
| `preferStreaming` | Enables streaming preferences when SSR routes `meta.streaming === true` |



When creating a renderer fails, an error is logged and the CSR renderer is returned.



#### Streaming SSR



When both:



```typescript
renderMode === RenderMode.SSR
  && matchResult.route.meta?.streaming === true
  && ctx.method !== 'HEAD'
  && typeof renderer.renderToStream === 'function'
```



Rendering middleware will call `renderToStream(context)`. Otherwise the normal `renderer.render(context)` is called. When the response is written, if `RenderResult` tags `isStreaming` and contains `stream`, `ctx.body` will be set to the stream object.



#### Plug-in `extra` protocol



After the plug-in hook is triggered inside the renderer, the plug-in may write the contract field to `context.extra`. `renderMiddleware` is uniformly consumed in `applyPluginExtras()`:



| Field | Behavior |
|------|------|
| `__cache_hit === true` and `__cache_content` is a string | Replace `result.html` with the plugin cache contents and write `X-Nami-Plugin-Cache: HIT` |
| `__custom_headers` | Merged into `result.headers` |
| `__retry_attempted === true` | Write `X-Nami-Retry: 1` |
| Any `extra` | Hang to `ctx.state.namiExtra` for subsequent logical reading |



#### Response settings



`setResponse()` will:



1. Set `ctx.status = result.statusCode`.
2. Traverse `result.headers` and write the response header.
3. If `result.cacheControl` exists, generate `Cache-Control`:



   ```text
   s-maxage=${revalidate}, stale-while-revalidate=${staleWhileRevalidate}
   ```



4. If there is a cache tag, write `X-Nami-Cache-Tags`.
5. Write the cache semantics into `ctx.state.namiCacheControl` for the outer layer `securityMiddleware` to write back.
6. Write `ctx.body`: stream results are written as stream, and ordinary results are written as HTML strings.



#### Rendering failure downgrade



When an error occurs during the rendering process, the middleware will first log the error. Then try in order:



1. If the plug-in provides `renderContext.extra.__skeleton_fallback`, it will directly return the skeleton screen HTML, status code `200`, and response header `X-Nami-Render-Mode: skeleton-fallback`.
2. Otherwise, call `degradationManager.executeWithDegradation()` and press `config.fallback` to execute the framework downgrade strategy.
3. Write the downgrade results back through `setResponse()`.



If the rendering exception is not downgraded here and continues to be thrown, the outer `errorIsolationMiddleware` will return a 500 error page.



---



## 4. Request type and short-circuit path



### Health check request



```text
GET /_health
  -> shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck short circuit returns 200
  <- security writes security header
  <- timing writes X-Response-Time
```



### Data prefetch request



```text
GET /_nami/data/products/1
  -> shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck release
  -> staticServe is inbound, because defer enters the downstream first
  -> User/plugin middleware
  -> dataPrefetch matches the data API, executes the page data function and returns JSON
  <- staticServe usually does not overwrite the generated data response
  <- security / timing outbound supplementary header
```



### Static resource request



```text
GET /assets/main.abcdef12.js
  -> shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck release
  -> staticServe inbound, defer to downstream
  -> User/plugin middleware
  -> dataPrefetch release
  -> errorIsolation
  -> isrCache release
  -> render route does not match, let go
  <- staticServe sends files from {outDir}/client and sets long-term cache due to path hash
  <- security / timing outbound supplementary header
```



### ISR page cache hit



```text
GET /blog/hello
  -> ...front-end middleware
  -> errorIsolation
  -> isrCache matches the ISR route and hits the cache
     ├─ Fresh: Return directly to HIT
     └─ Stale: Return to STALE and re-verify in the background
  <- Do not enter renderMiddleware
```



### Normal SSR page



```text
GET /dashboard
  -> ...front-end middleware
  -> errorIsolation
  -> isrCache release
  -> renderMiddleware
     ├─ Route matching
     ├─ Construct RenderContext
     ├─ Create SSRRenderer
     ├─ Perform data prefetching and React rendering
     ├─Consumption plugin extra
     └─Write HTML response
```



---



## 5. Service startup and graceful shutdown



### `startServer()` Start process



Source code location: `packages/server/src/server.ts`



`startServer(config, options)` is the production startup entry. Process:



```text
1. Read config.server.port/host/cluster
2. If cluster is configured and is currently the main process:
   -> startMaster()
   -> The main process only manages Workers and does not create Koa app
3. Single process or Worker process:
   -> createNamiServer(config, options)
   -> app.listen(port, host)
   -> If it is a Worker, send worker:ready to the main process
   -> If gracefulShutdown is enabled, register setupGracefulShutdown()
   -> Trigger pluginManager.runParallelHook('onServerStart', { port, host })
   ->Execute options.onReady()
```



The default server configuration comes from `packages/shared/src/constants/defaults.ts`:



```typescript
export const DEFAULT_SERVER_CONFIG = {
  port: 3000,
  host: '0.0.0.0',
  ssrTimeout: 5000,
  gracefulShutdown: true,
  gracefulShutdownTimeout: 30000,
};
```



### Graceful shutdown process



Source code location: `packages/server/src/middleware/graceful-shutdown.ts`



`setupGracefulShutdown()` registers the `SIGTERM` and `SIGINT` handlers. Core process:



```text
SIGTERM/SIGINT
  │
  ▼
Set internal isShutingDown to prevent repeated triggering
  │
  ▼
Call onSignalReceived()
  │ That is, triggerShutdown() returned by createNamiServer
  │ Let shutdownAware start returning 503 for new requests
  ▼
server.close()
  │ Stop accepting new TCP connections and continue processing established connections.
  ▼
Promise.race([closePromise, timeoutPromise])
  │ The default wait time is 30000ms at most
  ▼
onShutdown()
  ├─ isrManager.close()
  ├─ pluginManager.dispose()
  └─ options.onShutdown()
  ▼
process.exit(0)
```



The number of active requests is counted through HTTP server events:



```typescript
let activeConnections = 0;

server.on('request', (_req, res) => {
  activeConnections++;
  res.on('finish', () => {
    activeConnections--;
  });
});
```



This count is mainly used for logging and troubleshooting. Really stop receiving new connections depending on `server.close()`; wait for shutdown and timeout depending on `Promise.race()`.



When deploying to K8s, `terminationGracePeriodSeconds` should be greater than `gracefulShutdownTimeout`. The default timeout is 30 seconds, and it is recommended that K8s set it to 35 seconds or higher to leave margin for the Node process to clean up and exit.



---



## 6. Cluster mode



### Enablement method



As long as `server.cluster` exists in the configuration, `startServer()` will enter the cluster judgment:



```typescript
server: {
  cluster: {
    workers: 0,
  },
}
```



`workers` semantics come from `packages/server/src/cluster/master.ts`:



| Configuration | Actual Number of Workers |
|------|----------------|
| Do not configure `cluster` | Single process |
| `workers: 0` or not passed | Number of CPU cores |
| `workers: 4` | Fixed 4 |
| `workers: -1` | Decrease the number of CPU cores by 1, at least 1 |



### Main process responsibilities



Source code location: `packages/server/src/cluster/master.ts`



The main process does not handle HTTP requests, it is responsible for:



1. Calculate the number of Workers.
2. `cluster.fork()` creates Worker.
3. Wait for the Worker to send `worker:ready`.
4. Call `onAllWorkersReady()` after all Workers are ready.
5. Monitor the Worker for abnormal exit and restart according to restrictions.
6. After receiving `SIGTERM` / `SIGINT`, send `SIGTERM` to all Workers.



The main process uses the `worker:ready` message to determine readiness, instead of relying only on the cluster's `online` event. The reason is that `online` only indicates that the process fork is successful, and there is no guarantee that Koa has succeeded in `app.listen()`; `worker:ready` is sent by the Worker after the listening port is successful.



### Worker Responsibilities



Source code location:



- `packages/server/src/server.ts`
- `packages/server/src/cluster/worker.ts`



The Worker process creates a Koa application and binds the port. Sent after successful startup:



```typescript
process.send({
  type: 'worker:ready',
  workerId,
  pid,
  port,
});
```



Each Worker has its own Node.js process, event loop, and memory space. When using in-memory ISR cache, the caches of each worker are not shared with each other; if the production environment is deployed with multiple workers or multiple machines and the ISR content is required to be consistent, a shared cache adapter such as Redis should be used.



### Abnormal restart



The main process listens to `cluster.on('exit')`. It will not restart in the following situations:



| Exit status | Restart or not |
|----------|----------|
| `code === 0` | No, it is considered a normal exit |
| `signal === 'SIGTERM'` | No, usually graceful shutdown |
| Non-0 exit code and non-SIGTERM | Yes, restart according to frequency limit |



Default restart protection:



| Options | Default | Effect |
|------|--------|------|
| `restartDelay` | `1000ms` | Delayed restart after crash |
| `maxRestarts` | `10` | Maximum number of consecutive restarts within a window |
| `restartWindow` | `60000ms` | Restart counting window |



If the Worker crashes continuously within the window and exceeds the upper limit, the main process will stop restarting to avoid infinite restarts that consume CPU.



### Main process shuts down



After the main process receives `SIGTERM` or `SIGINT`, it will execute:



```typescript
worker.process.kill('SIGTERM');
```



The Worker executes its own `setupGracefulShutdown()` after receiving the signal. The main process will wait 35 seconds before timing out `process.exit(1)`. This 35 seconds is 5 seconds longer than the default Worker graceful shutdown timeout of 30 seconds.



---



## 7. Development Server



Source code location:



- `packages/server/src/dev/dev-server.ts`
- `packages/server/src/dev/hmr-middleware.ts`



The development server used by `nami dev` does not simply call `createNamiServer()`, but creates its own Koa app and assembles a development-specific pipeline:



```text
webpack-dev-middleware
  -> webpack-hot-middleware
  -> timing
  -> requestContext
  -> healthCheck
  -> dataPrefetch
  -> errorIsolation
  -> renderMiddleware
```



Compared to production server:



| Capabilities | Production Server | Development Server |
|------|------------|------------|
| Static resources | `koa-static` reads `dist/client` | `webpack-dev-middleware` compiles product response from memory |
| HMR | None | `webpack-hot-middleware`, default SSE path `/__webpack_hmr` |
| Security header | Register `securityMiddleware` | Do not register |
| Downtime aware | Register `shutdownAware` | Do not register |
| Graceful shutdown | `startServer()` Register according to configuration | `DevServer.close()` Manually close watcher and HTTP server |
| ISR cache | Register when `config.isr.enabled` | Do not register ISR cache layer |
| User/plug-in Koa middleware | Register `config.server.middlewares` and plug-in `addServerMiddleware()` | These two types of middleware are not registered by default |
| server bundle updates | injected at startup or provided by runtime | latest runtime readable per request via `runtimeProvider` |



### Webpack dev middleware



The development server dynamically imports `webpack`, creates a client compiler, and registers:



```typescript
createWebpackDevMiddleware(clientCompiler, {
  publicPath: clientWebpackConfig.output?.publicPath || '/',
});
```



It is responsible for intercepting client JS, CSS, source map and other build product requests. The products come from the Webpack memory file system and do not need to be written to disk.



### HMR middleware



`createHMRMiddleware()` Adapts Express-style `webpack-hot-middleware` to Koa middleware. The core links of HMR are:



```text
Browser EventSource connection /__webpack_hmr
  -> Webpack compilation completed
  -> hot middleware pushes update messages through SSE
  -> Client HMR runtime downloads and replaces the update module
```



The adaptation layer needs to handle the particularity of SSE: the response will not be very fast after the SSE connection is established `finish`, so in addition to monitoring `finish` / `close`, the source code also intercepts `res.writeHead` to determine whether the response header has been sent. The adapter also has a 30-second timeout to prevent Promises from hanging forever.



### SSR development mode



If `serverWebpackConfig` is passed in, the development server will start the server compiler's watch:



```typescript
activeServerCompiler.watch({ aggregateTimeout: 300 }, callback);
```



After the server bundle is recompiled, `renderMiddleware` can get the latest `appElementFactory`, `htmlRenderer`, and `moduleLoader` through `runtimeProvider` before each request to avoid SSR from using old entries or old page modules.



---



## 8. Deployment considerations



### K8s



```yaml
spec:
  containers:
    - name: nami-app
      command: ["nami", "start"]
      ports:
        - containerPort: 3000
      livenessProbe:
        httpGet:
          path: /_health
          port: 3000
        initialDelaySeconds: 10
        periodSeconds: 10
      readinessProbe:
        httpGet:
          path: /_health
          port: 3000
        initialDelaySeconds: 5
        periodSeconds: 5
      env:
        - name: NODE_ENV
          value: "production"
  terminationGracePeriodSeconds: 35
```



If Nami's own cluster mode is enabled, the command can be carried with the corresponding configuration or CLI parameters; if the container platform is used for horizontal expansion, there is usually no need to fork too many Workers in each Pod.



### PM2



```javascript
module.exports = {
  apps: [{
    name: 'nami-app',
    script: 'nami',
    args: 'start',
    instances: 'max',
    exec_mode: 'cluster',
    kill_timeout: 35000,
  }],
};
```



When using PM2 cluster mode, it is not recommended to enable Nami's `server.cluster` at the same time. Otherwise, a two-tier cluster will be formed: PM2 forks multiple processes, and each process forks multiple Workers through the Node cluster. The number of processes and port competition are more difficult to control.



### Multi-machine/Multi-Worker ISR



The default ISR cache adapter is `memory`. It is suitable for local development, single process or scenarios that do not require high consistency. When deploying multiple workers or multiple machines, if the memory cache is still used, the following will appear:



| Problem | Reason |
|------|------|
| Different instances return different HTML | Each process has its own cache |
| Background revalidation only updates this process | The revalidation queue and cache storage are not shared |
| Incomplete invalidation by tag | Invalidation operation only affects the current cache backend |



It is recommended to use the Redis cache adapter for production multi-instance deployment and ensure that all instances are connected to the same set of Redis.



---



## 9. Quick checklist



| Phenomenon | Priority Check |
|------|----------|
| `/_health` is slow or triggers rendering | Whether the health check path has been changed, or the upstream proxy has not directly requested `/_health` |
| The page does not have `X-Request-Id` | `requestContextMiddleware` is bypassed, or if the exception occurs before it |
| Static resource caching does not meet expectations | Whether the file name contains more than 8 digits of hexadecimal hash, and whether it is processed in advance by downstream middleware |
| Data prefetch API returns 204 | The route exists, but does not correspond to `getServerSideProps` / `getStaticProps` |
| Data prefetch API goes into page rendering | `moduleLoader` is missing and middleware downgraded to `await next()` |
| Plug-in middleware exception does not return the frame 500 pages | Plug-in middleware is located upstream of `errorIsolation`, and the plug-in needs to handle expected exceptions by itself |
| ISR always `MISS` | Whether routing is `RenderMode.ISR`, whether `config.isr.enabled` is `true`, whether cache write fails |
| The ISR background revalidation loop hits the old cache | Check whether the internal request header `x-nami-isr-revalidate: 1` is forwarded by the proxy |
| onReady is not triggered after the cluster is started | Whether the Worker sends `worker:ready` and whether the port is successfully bound |
| K8s rolling update still has 5xx | Whether `terminationGracePeriodSeconds` is greater than `gracefulShutdownTimeout`, and whether load balancing respects `/_health` |



---



## Next step



- To learn about ISR storage and invalidation strategies: read [ISR and Caching](./isr-and-caching.en.md)
- To learn about renderers and degradation chains: read [Error handling and degradation](./error-and-degradation.en.md)
- To learn how build products provide server runtime: read [Build System](./webpack-build.en.md)
