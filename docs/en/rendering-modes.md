# Rendering Mode Principles



Nami's rendering system consists of four formal `RenderMode` enumerations and a streaming variant of SSR. There are only four enumerations in the source code: `csr`, `ssr`, `ssg`, and `isr`; Streaming SSR is not an independent enumeration, but the renderer variant selected when the SSR route is `meta.streaming === true`. All SSR variants use the mandatory `createAppElement(context)` server-entry contract.



When reading this chapter, you need to distinguish three links:



1. **HTML rendering link**: `renderMiddleware` creates a specific Renderer after matching the route and outputs the page HTML.
2. **Data prefetch API link**: `dataPrefetchMiddleware` only processes `GET /_nami/data/*` and returns JSON, which is not equivalent to data prefetching before HTML rendering.
3. **Build-time static generation path**: after compilation, `NamiBuilder.generateStaticPages()` wires the server bundle and delegates to `SSGRenderer.generateStatic()` to write static HTML for SSG/ISR routes.



---



## 1. Source code map



| Theme | Source Code |
|------|------|
| Rendering mode enumeration | `packages/shared/src/types/render-mode.ts` |
| Rendering context and results | `packages/shared/src/types/context.ts` |
| Routing data function type | `packages/shared/src/types/route.ts` |
| Rendering mode constants | `packages/shared/src/constants/render-modes.ts` |
| Data hydration and secure serialization | `packages/shared/src/utils/serialize.ts` |
| Renderer Factory | `packages/core/src/renderer/index.ts` |
| Renderer base class | `packages/core/src/renderer/base-renderer.ts` |
| CSR Renderer | `packages/core/src/renderer/csr-renderer.ts` |
| SSR Renderer | `packages/core/src/renderer/ssr-renderer.ts` |
| SSG Renderer | `packages/core/src/renderer/ssg-renderer.ts` |
| ISR Renderer | `packages/core/src/renderer/isr-renderer.ts` |
| Streaming SSR Renderer | `packages/core/src/renderer/streaming-ssr-renderer.ts` |
| Server-side rendering middleware | `packages/server/src/middleware/render-middleware.ts` |
| Routing data prefetch API | `packages/server/src/middleware/data-prefetch-middleware.ts` |
| ISR caching middleware | `packages/server/src/middleware/isr-cache-middleware.ts` |
| Downgrade Manager | `packages/core/src/error/degradation.ts` |
| Client hydration data reading | `packages/client/src/data/data-hydrator.ts` |
| Client mounting entry | `packages/client/src/entry-client.tsx` |
| Build phase SSG/ISR generated | `packages/webpack/src/builder.ts` |



---



## 2. Overview



`RenderMode` definition in source code:



```typescript
export enum RenderMode {
  CSR = 'csr',
  SSR = 'ssr',
  SSG = 'ssg',
  ISR = 'isr',
}
```



The relevant constants are located at `packages/shared/src/constants/render-modes.ts`:



| constant | value | meaning |
|------|----|------|
| `SERVER_RENDER_MODES` | `[SSR, ISR]` | Mode that requires server participation during runtime |
| `STATIC_RENDER_MODES` | `[SSG, ISR]` | Patterns that need to be statically generated during build |
| `NEEDS_SERVER_BUNDLE` | `[SSR, SSG, ISR]` | Requires server bundle mode when building |



These three constants explain a common question: SSG does not need to perform server-side rendering during runtime, but the build phase still requires the server bundle to execute `getStaticProps`, `getStaticPaths`, and `createAppElement(context)`.



| Features | CSR | SSR | SSG | ISR | Streaming SSR |
|------|-----|-----|-----|-----|---------------|
| Is the `RenderMode` enumeration | Yes | Yes | Yes | Yes | No, SSR variant |
| HTML generation location | Generate a temporary-skeleton shell on request | Server-side rendering for each request | Build-time generation | Build-time + runtime revalidation | Server-side streaming rendering for each request |
| Whether to execute the page data function | Not executed by the server | HTML link execution `getServerSideProps` | Construction period execution `getStaticProps` | Cache miss/revalidation execution `getStaticProps` | Executed the same as SSR `getServerSideProps` |
| Is the server required during runtime | No | Yes | React SSR is not required when reading static files | Yes | Yes |
| Whether the first screen HTML already contains content | Temporary loading skeleton only; no business content | Yes | Yes | Yes when the cache is hit | Yes, and it can be returned in chunks |
| Typical cache | Short cache HTML shell | `private, no-cache` | Long cache static HTML | SWR cache | `private, no-cache` |



---



## 3. Rendering entry: `renderMiddleware`



Source code location: `packages/server/src/middleware/render-middleware.ts`



After the production request passes through the front-end middleware, the page HTML is finally processed by `renderMiddleware`:



```text
GET /page
  -> matchConfiguredRoute(ctx.path, config.routes)
  -> createRenderContext(ctx, matchResult, requestId)
  -> RendererFactory.create({ mode, config, ... })
  -> renderer.render(context) or renderer.renderToStream(context)
  -> applyPluginExtras(ctx, context, result)
  -> setResponse(ctx, result)
```



It only handles `GET` and `HEAD`. Other methods directly `await next()`.



### Route matching



`renderMiddleware` defaults to `matchConfiguredRoute()`. This function is located in `packages/server/src/middleware/route-match.ts` and internally reuses `rankRoutes + matchPath` of `@nami/core`. This matcher is also used by `dataPrefetchMiddleware` and `isrCacheMiddleware` to prevent the three links from matching different routes.



### `RenderContext`



`createRenderContext()` will create a new `RenderContext` for each request:



| Field | Source |
|------|------|
| `url` / `path` | Koa `ctx.url` / `ctx.path` |
| `query` | Koa `ctx.query`, keep only strings or string arrays |
| `headers` | Request header, lowercase key |
| `route` | Hitting `NamiRoute` |
| `params` | Dynamic routing parameters |
| `koaContext` | method, path, url, querystring, protocol, ip, origin, hostname, secure, cookies |
| `timing.startTime` | The time when the context was created |
| `requestId` | `requestContextMiddleware` Injected request ID |
| `extra` | New object `{}` independent for each request, for plug-ins to write extended fields |



`extra` is a request-level object and is not shared across requests.



### Select renderer



Rendering mode taken from:



```typescript
const renderMode = matchResult.route.renderMode || config.defaultRenderMode;
```



Then call `RendererFactory.create()`. For SSR, `renderMiddleware` is additionally passed in:



```typescript
preferStreaming:
  renderMode === RenderMode.SSR && matchResult.route.meta?.streaming === true
```



For a valid SSR runtime, `appElementFactory` is mandatory. `RendererFactory` returns
`StreamingSSRRenderer` when `preferStreaming === true`; otherwise it returns the
ordinary `SSRRenderer`. A missing factory is a renderer-creation error rather than
a reason to silently switch from streaming to ordinary SSR.



### Streaming response selection



`renderMiddleware` calls `renderToStream()` only if the following conditions are met simultaneously:



```typescript
renderMode === RenderMode.SSR
  && matchResult.route.meta?.streaming === true
  && ctx.method !== 'HEAD'
  && typeof streamingRenderer.renderToStream === 'function'
```



Otherwise `renderer.render(context)` is called. Therefore, the `HEAD` request will not output the streaming body even if streaming is configured.



---



## 4. Renderer public contract



Source code location: `packages/core/src/renderer/base-renderer.ts`



All renderers inherit `BaseRenderer` and must implement:



| Method | Function |
|------|------|
| `render(context)` | Convert `RenderContext` to `RenderResult` |
| `prefetchData(context)` | Perform data prefetching in this mode |
| `getMode()` | Returns the current rendering mode |



Public output is generated uniformly by `createDefaultResult()`:



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



`meta` contains:



| Field | Meaning |
|------|------|
| `renderMode` | Actual rendering mode |
| `duration` | Total time taken |
| `degraded` | Whether downgrade occurred |
| `degradeReason` | Reason for downgrade |
| `dataFetchDuration` | Data prefetching time |
| `renderDuration` | React rendering time |
| `cacheHit` / `cacheStale` | ISR cache status |



### Plug-in hook



The renderer triggers plugin hooks via `BaseRenderer.callPluginHook()`. The short name is passed in:



| Renderer internal short name | `PluginManager.callHook()` mapped to |
|------------------|-----------------------------------|
| `beforeRender` | `onBeforeRender` |
| `afterRender` | `onAfterRender` |
| `renderError` | `onRenderError` |



`renderMiddleware` will no longer trigger these hooks repeatedly to avoid executing the same life cycle twice.



---



## 5. CSR



Source code location: `packages/core/src/renderer/csr-renderer.ts`



The server side job of CSR is just to generate HTML shell:



```text
CSRRenderer.render()
  -> callPluginHook('beforeRender')
  -> generateShellHTML()
  -> createDefaultResult(..., RenderMode.CSR)
  -> callPluginHook('afterRender')
```



HTML shell contains:



1. `<!DOCTYPE html>`, `meta charset`, `viewport`
2. Title and description
3. `<meta name="renderer" content="csr">`
4. CSS resource link
5. `<div id="nami-root">...</div>` containing a temporary `data-nami-csr-shell="loading"` skeleton
6. Client JS Bundle

The temporary skeleton covers bundle download, client initialization, and the time before the first React commit. Successful client JavaScript replaces the root contents. This is distinct from the no-JavaScript Level 3 static emergency page.



CSR does not execute page data functions on the server side:



```typescript
async prefetchData() {
  return { data: {}, errors: [], degraded: false, duration: 0 };
}
```



Default response cache when GSP does not declare `revalidate`:



```http
Cache-Control: public, max-age=60, s-maxage=120
```



The CSR is the end of the renderer downgrade chain, `createFallbackRenderer()` returns `null`.



Applicable scenarios:



| Scene | Reason |
|------|------|
| Management backend | Usually no SEO required |
| Post-login page | Content relies on user mode, first-screen SEO value is low |
| Internal tools | Low server cost first |
| SSR/ISR Fails | At least let client JS take over |



---



## 6. SSR



Source code location: `packages/core/src/renderer/ssr-renderer.ts`



SSR performs data prefetching and React rendering on the server side for each request:



```text
SSRRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> resolvePluginCacheHit(context)
  -> withTimeout(executeSSR(), config.server.ssrTimeout)
       -> prefetchData(context)
       -> context.initialData = prefetchResult.data
       -> redirect/notFound? return early
       -> renderAppHTML(context)
            -> appElementFactory(context)
            -> renderToString(element)
       -> assembleHTML(renderedHTML, context)
       -> createDefaultResult(..., RenderMode.SSR)
  -> callPluginHook('afterRender')
```



### Server entry protocol



The server entry has one rendering contract:

| Entry export | Description |
|------|------|
| `createAppElement(context)` | Returns the React element tree. The CLI resolves it as `appElementFactory`, and the selected renderer calls React's string or streaming API. |

The application does not return an HTML string or a complete document. Keeping the
entry at the React-tree boundary lets ordinary SSR, Streaming SSR, SSG, and ISR use
the same component tree while Nami consistently controls rendering, the outer
Document, manifest assets, and serialized hydration data.



### Data prefetching



`prefetchData()` is only executed when the route declares `getServerSideProps`. Functions read from the server bundle via `moduleLoader.getExportedFunction(route.component, route.getServerSideProps)`.



Pass in the context of `getServerSideProps`:



| Field | Source |
|------|------|
| `params` | Routing dynamic parameters |
| `query` | Request query |
| `headers` | Request header |
| `path` | Request pathname |
| `url` | Full URL |
| `cookies` | `context.koaContext?.cookies ?? {}` |
| `requestId` | Request ID |



In the current HTML rendering path, `SSRRenderer` executes `getServerSideProps` first. A `redirect` short-circuits to 30x, while `notFound` returns a stable static 404 before business React rendering. The default 404 intentionally includes neither Hydration data nor a client bundle, preventing an empty root from rebuilding the original business route with CSR. Streaming SSR handles the same early results before any shell bytes are written.



### HTML assembly and water injection



After React produces the application markup, `assembleHTML()` always assembles the
framework-owned document:



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



The water injection script is generated by `generateDataScript()` of `packages/shared/src/utils/serialize.ts`. It calls `safeStringify()`, which will escape `<`, `>`, `/`, `\u2028`, `\u2029` into Unicode sequences to avoid `</script>` and other content truncation scripts to generate XSS.



### Timeouts and errors



The complete SSR process is:



```typescript
withTimeout(this.executeSSR(...), this.ssrTimeout, ...)
```



package. `ssrTimeout` comes from `config.server.ssrTimeout`, the default value in `DEFAULT_SERVER_CONFIG` is `5000ms`. Timeouts or exceptions will be wrapped into `RenderError` and thrown to `renderMiddleware`, and then `renderMiddleware` will try to downgrade.



Default cache:



```http
Cache-Control: private, no-cache
```



---



## 7. SSG



Source code location:



- `packages/core/src/renderer/ssg-renderer.ts`
- `packages/webpack/src/builder.ts`



SSG is divided into build phase and run phase.



### Construction period



`NamiBuilder.generateStaticPages()` delegates the build-time work to
`SSGRenderer.generateStatic()`, so static generation and runtime rendering share
the same element-factory and document-assembly contracts:



```text
nami build
  -> client/server Webpack compilation completed
  -> generateStaticPages(routes)
       -> read createAppElement from dist/server/entry-server.js
       -> create ModuleLoader and read asset-manifest.json
       -> create SSGRenderer
       -> SSGRenderer.generateStatic(routes)
            -> traverse SSG/ISR routes
            -> dynamic routes execute getStaticPaths()
            -> execute getStaticProps() for each path
            -> createAppElement(context) + renderToString()
            -> framework Document/assets/hydration assembly
            -> write matching *.html and *.html.nami.json files
```



For a static route, the renderer generates one path. A dynamic route requires a
configured `getStaticPaths` export resolvable through `ModuleLoader`. A missing
declaration, unresolved export, or degraded data-prefetch result is recorded as a
generation error; other routes continue, and the Builder includes the failures in
the build result.

Here “dynamic” covers the matcher's complete segment syntax, not only a bare
`:param`:

| Route token | `getStaticPaths.params` key | Value shape |
|-------------|-----------------------------|-------------|
| `:id` | `id` | One non-empty segment |
| `:id?` | Optional `id` | Optional single segment |
| `:id(\\d+)` | `id` | Must satisfy the constraint |
| `:path+` | `path` | One or more `/`-separated segments |
| `*` | `'*'` | Non-empty remaining path |
| `(.*)` | `$0` (then `$1`, and so on) | Multi-segment value that may be empty |

The build first materializes params into a segment-encoded canonical URL, then runs
formal `matchPath(route.path, url, { exact: true })` parameter round-trip validation.
A missing required parameter, wrong parameter type, `/` in a single-segment value,
constraint mismatch, or generated URL that cannot match exactly becomes a page error.
If two routes/param sets resolve to the same absolute artifact path, the collision is
also a build failure. These checks do not introduce a new URL-to-file format: `/`
still maps to `index.html`, `/about` to `about.html`, and `/blog/hello` to
`blog/hello.html`.

There is no Builder-specific page renderer or hidden-shell fallback. The compiled
server entry must export `createAppElement(context)` and the client asset manifest
must exist.



The output path is:



```text
dist/static/index.html
dist/static/index.html.nami.json
dist/static/about.html
dist/static/about.html.nami.json
dist/static/blog/hello.html
dist/static/blog/hello.html.nami.json
```

Each `*.html.nami.json` response sidecar records its version,
`page | redirect | not-found` kind, status, headers, and optional `revalidate`.
The runtime reads the HTML and sidecar together, so build-time GSP redirects/404s
do not become 200 responses. A legacy artifact without a sidecar remains compatible
as a normal 200 SSG page; an existing but invalid sidecar fails loudly.
An explicit GSP redirect status is limited to `301/302/303/307/308`; when omitted,
permanent resolves to `308` and temporary to `307`.



### Runtime



The runtime logic of `SSGRenderer.render()` is to read static files:



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



For a dynamic SSG route with `fallback: false`, a path without an artifact returns a
stable static 404 with no Hydration payload or client bundle. Other missing static
files still throw `RenderError` and enter the upper degradation path.

The supported `getStaticPaths.fallback` matrix is:

| Mode | Supported value | Non-prebuilt path |
|------|-----------------|-------------------|
| SSG | `false` | Stable static 404 |
| ISR | `'blocking'` | Cold `MISS`; synchronously run GSP + React and write CacheStore |

`true` and other SSG/ISR combinations are not implemented. A mismatch between the
route and `getStaticPaths()` value, or an unsupported value, is recorded as a build
generation error.



Default response cache:



```http
Cache-Control: public, max-age=3600, s-maxage=86400
```

When GSP explicitly returns `revalidate` (including a valid `0`), the build writes
the matching `s-maxage` / `stale-while-revalidate` headers into the sidecar and the
runtime uses that page-specific value.



### `SSGRenderer.generateStatic()`

This is the implementation used by the Builder. It resolves route paths and data
functions through `ModuleLoader`, creates a complete `RenderContext`, calls the
shared application element factory, renders the tree with `renderToString()`,
assembles the framework Document, and writes the static file. The Builder supplies
the absolute static directory and records the renderer's per-page failures.



---



## 8. ISR



Source code location:



- `packages/server/src/middleware/isr-cache-middleware.ts`
- `packages/server/src/isr/isr-manager.ts`
- `packages/server/src/isr/stale-while-revalidate.ts`
- `packages/core/src/renderer/isr-renderer.ts`



ISR is a combination of SSG and SSR: page results can be cached and updated through revalidation after the cache expires.



### Default production link



In the default server link, cache hits and background revalidation are handled by `isrCacheMiddleware`:



```text
GET /article/1
  -> isrCacheMiddleware
       -> only handle GET
       -> Skip internal request for x-nami-isr-revalidate: 1
       -> matchConfiguredRoute(ctx.path, config.routes)
       -> route.renderMode === ISR && config.isr.enabled ?
       -> isrManager.getOrRevalidate(...)
```



The default cache keys are:



```typescript
ctx.url
```



This is the raw full request URL, so the query string is included and query ordering
is not canonicalized: `?a=1&b=2` and `?b=2&a=1` are distinct keys. Cookies,
headers, and tenant identity are not included. Use a custom `generateCacheKey()`
when those are content dimensions, and use tags when invalidating a family of URL
variants.



### SWR status



`ISRManager.getOrRevalidate()` uses `evaluateCacheFreshness()` to determine cache status:



```text
0 ───────────── revalidateAfter ───────────── revalidateAfter * staleMultiplier ─────▶
      Fresh                      Stale                                  Expired
```



Default `staleMultiplier = 2`.



| Status | Behavior |
|------|------|
| `Fresh` | Return to cache directly, `X-Nami-Cache: HIT` |
| `Stale` | Return the old HTML, initiate internal revalidation in the background, `X-Nami-Cache: STALE` |
| `Expired` | Do not return old HTML, use synchronous rendering |
| Miss | Render synchronously, await the cache write, then release same-key singleflight |

An effective `revalidate = 0` is a persistent-ISR-cache bypass: Nami does not read or
write CacheStore, removes the old key on a best-effort basis, and allows only
same-key in-flight Promise coalescing inside the current Node process. It does not
create a persistent entry with TTL zero.



Background re-authentication is implemented through internal requests, and the request header contains:



```http
x-nami-isr-revalidate: 1
X-Requested-With: nami-isr-revalidate
```



Requests with this header will bypass `isrCacheMiddleware` and directly enter the rendering layer to avoid background re-validation and hitting the stale cache again.

For normal successful pages, both cold rendering and background rebuilds store safely
filtered `statusCode` / end-to-end headers in `CacheEntry` and generate an ETag from
HTML; HIT/STALE restores them. If a background rebuild produces a valid GSP redirect
or `404 notFound`, it deletes the old key and does not cache the control response;
degradation and ordinary failures retain the old stale page. Synchronous singleflight
and queue deduplication are process-local, and a queue `Promise.race()` timeout only
stops waiting—it does not cancel the underlying render/fetch.



### `ISRRenderer`



The responsibility of `ISRRenderer` is not to handle cache hits, but to generate new HTML on cache misses or revalidations:



```text
ISRRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> resolvePluginCacheHit(context)
  -> handleCacheMiss()
       -> prefetchData(context)  // getStaticProps
       -> context.initialData = props
       -> redirect/notFound? short-circuit 30x/404 + no-store
       -> appElementFactory(context)
       -> renderToString(element)
       -> assembleHTML(appHTML, context)
       -> createDefaultResult(..., RenderMode.ISR, cacheControl)
  -> callPluginHook('afterRender')
```



`prefetchData()` executes `getStaticProps`, not `getServerSideProps`.



The `cacheControl` returned by ISRRenderer contains:



```typescript
{
  revalidate: effectiveRevalidate,
  staleWhileRevalidate: effectiveRevalidate * 2,
  tags: extractCacheTags(context),
}
```



There are two types of tag sources:



| Source | Field |
|------|------|
| Routing configuration | `route.meta.cacheTags` |
| Plug-in or business writing | `context.extra.cacheTags` |



`isrCacheMiddleware` and `ISRRenderer.buildCacheKey()` now use the raw full request URL (pathname + query), matching the client Hydration data scope. Query ordering is not canonicalized, and cookies, headers, or tenant identity are not included; customize `generateCacheKey()` for other dimensions.



---



## 9. Streaming SSR



Source code location:



- `packages/core/src/renderer/streaming-ssr-renderer.ts`
- `packages/server/src/middleware/render-middleware.ts`
- `packages/core/src/renderer/index.ts`



Streaming SSR is based on React 18’s `renderToPipeableStream()`. It is not a standalone rendering mode, but an execution variant of SSR:



```typescript
{
  path: '/large-page',
  component: './pages/large-page',
  renderMode: RenderMode.SSR,
  meta: { streaming: true },
}
```



### Create conditions



After validating the mandatory application factory, `RendererFactory` creates
`StreamingSSRRenderer` when:



```typescript
mode === RenderMode.SSR
  && preferStreaming
```

The same `createAppElement(context)` tree is used by both ordinary and Streaming
SSR. The difference is framework-controlled execution with `renderToString()` or
`renderToPipeableStream()`.



### `render()` and `renderToStream()`



`StreamingSSRRenderer` has two entries:



| Method | Behavior | Whether to actually stream |
|------|------|------------------|
| `render()` | Use `renderToPipeableStream()` but return the complete string after collecting | No |
| `renderToStream()` | Returns `StreamingRenderResult.stream`, set to `ctx.body` by Koa | Yes |



What actually transfers chunks to the browser is `renderToStream()`.



### Streaming response process



```text
renderToStream(context)
  -> callPluginHook('beforeRender')
  -> prefetchData(context)
  -> context.initialData = props
  -> buildHTMLShell(context)
       -> headHTML: doctype/head/body/<div id="nami-root">
       -> tailHTML: </div> + data script + JS + </body></html>
  -> renderToPipeableStream(appElement)
       -> onShellReady: write headHTML, then pipe React content
       -> onAllReady: Mark rendering completed
       -> write tailHTML after passThrough end
  -> Return { isStreaming: true, stream }
```



The current implementation of Nami completes routing level `prefetchData()` before starting `renderToPipeableStream()`. Therefore, the benefits of Streaming SSR mainly come from the React rendering phase and network transmission phase, rather than streaming `getServerSideProps` itself.



### Timeout and downgrade



Streaming SSR has two timeout concepts:



| timeout | default/source | role |
|------|-----------|------|
| `ssrTimeout` | `config.server.ssrTimeout` | Wrapping the entire `render()` process |
| `streamTimeout` | Default `10000ms` | Called when the shell is not ready for a long time | `abort()` |



`createFallbackRenderer()` will return the normal `SSRRenderer`, forming a renderer-level downgrade chain:



```text
Streaming SSR -> SSR -> CSR
```



But in the catch branch of the default `renderMiddleware`, the actual degradation is mainly taken over by `DegradationManager.executeWithDegradation()`.



---



## 10. Data hydration and client mounting



### Server-side injection



Normal hydratable HTML from SSR, ISR, Streaming SSR, and build-time SSG uses the
same hydration envelope:



```html
<script>window.__NAMI_DATA__={...}</script>
```



Variable names come from `packages/shared/src/constants/defaults.ts`:



```typescript
export const NAMI_DATA_VARIABLE = '__NAMI_DATA__';
```



Every normal server-side HTML output that can be hydrated calls `BaseRenderer.createHydrationData(context)` and
passes the result through the XSS-safe `generateDataScript()` serializer:

```typescript
{
  version: NAMI_DATA_PROTOCOL_VERSION,
  props: context.initialData ?? {},
  degraded: context.extra.__nami_data_degraded === true,
  renderMode: context.route.renderMode,
  // SSG reuses the build artifact by pathname; SSR/ISR bind pathname + query.
  routePath: context.route.renderMode === RenderMode.SSG
    ? context.path
    : context.url,
}
```

Page data and rendering metadata therefore have one stable boundary across SSR,
Streaming SSR, SSG, and ISR.



### Client read



The client reads at `packages/client/src/data/data-hydrator.ts`:



```typescript
const rawData = hydrateData<ServerInjectedData>(NAMI_DATA_VARIABLE);
cachedData = normalizeServerData(rawData);
```



The client mounting entry is located at `packages/client/src/entry-client.tsx`:



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



The client and server now consume the same envelope: `serverData.props` is the
initial page data, `serverData.renderMode` selects the mount strategy, and
`serverData.routePath` records the initial route.



### Hydration vs CSR mount



The client hydrates only when the wire-protocol version is compatible, `renderMode !== 'csr'`, and the container has child nodes:



| Conditions | Mounting method |
|------|----------|
| Compatible `version`, non-CSR, and non-empty container | `hydrateApp()`, reuse server-side HTML |
| Incompatible protocol, CSR, or empty container | `renderApp()`, client creates DOM |



After Hydration is completed, `cleanupServerData()` will be called, `window.__NAMI_DATA__` will be deleted and the corresponding script tag will be removed, but the data read for the first time will be saved in the module-level cache.



---



## 11. The difference between data prefetching API and HTML link



Source code location: `packages/server/src/middleware/data-prefetch-middleware.ts`



`/_nami/data/*` is the API for client-side routing to prefetch JSON, not the entry point for HTML rendering.



```text
GET /_nami/data/blog/hello
  -> dataPrefetchMiddleware
  -> matchConfiguredRoute('/blog/hello')
  -> SSR: execute getServerSideProps
  -> SSG/ISR: executes getStaticProps
  -> Return JSON / 204 / 404 / redirect information
```



Compared to HTML links:



| Behavior | HTML Rendering Link | Data Prefetching API |
|------|--------------|--------------|
| SSR data functions | `SSRRenderer.prefetchData()` | `dataPrefetchMiddleware` execution |
| SSG/ISR data function | Build-time or ISR miss/revalidate execution | `dataPrefetchMiddleware` execution |
| `redirect` / `notFound` | SSR / Streaming SSR short-circuit per request; SSG writes a control document + sidecar; explicit GSP redirect accepts only 301/302/303/307/308; an ISR cold MISS returns the control response while a background rebuild deletes the old key, and neither caches it | API uses explicit `statusCode` or default 307/308; `notFound` is 404 |
| Return content | HTML/stream | JSON or 204 |
| Path prefix | Page original path | `/_nami/data` |



---



## 12. Downgrade strategy



Source code location:



- `packages/server/src/middleware/render-middleware.ts`
- `packages/core/src/error/degradation.ts`



`renderMiddleware` delegates the first render attempt to `DegradationManager`, which owns the full sequence:



| Level | Conditions | Return |
|------|------|------|
| Level 0 | Initial rendering succeeds | Original rendering result |
| Level 1 | `config.maxRetries > 0` | Result after retry |
| Level 2 | `config.ssrToCSR` | CSR shell with a temporary skeleton and client JavaScript |
| Level 3 | Plugin static-emergency content or `context.route.skeleton` | No-JavaScript static emergency page (compatibility name: Skeleton) |
| Level 4 | `config.staticHTML` exists | Static HTML |
| Level 5 | All failed | 503 pages |



Note: `__csr_shell_skeleton` is recoverable loading UI for normal and degraded CSR. Level 3 plugin content cannot bypass Levels 1/2, and `context.route.skeleton` only triggers built-in static emergency HTML; it does not load the referenced component file. Route-chunk and business-data skeletons are client loading UI, not Level 3.



---



## 13. Selection suggestions



| Page Features | Recommendation Mode |
|----------|----------|
| No SEO required, use after logging in, strong user mode | CSR |
| Requires SEO, data must be up-to-date on every request | SSR |
| The content is almost unchanged, suitable for CDN distribution | SSG |
| Content will be updated, but minute delays are allowed | ISR |
| The page is large, use Suspense, hope to output shell earlier | SSR + `meta.streaming: true` |



Decision path:



```text
Need SEO?
  No -> CSR
  Yes -> Does the data have to be live every time it is requested?
          Yes -> Is the page suitable for streaming output?
                  Yes -> SSR + streaming
                  No -> SSR
          No -> Does the content only change when published?
                  Yes -> SSG
                  No ->ISR
```



---



## 14. Common misunderstandings



### Myth 1: Streaming SSR is the fifth `RenderMode`



No. The source code's `RenderMode` enumeration has only four values. Streaming SSR is an implementation of an SSR route selected by `RendererFactory` when conditions are met.



### Misunderstanding 2: SSG does not require server bundle at all



Server-side rendering does not need to be performed during runtime, but the build
still needs the server bundle to execute page modules, `getStaticProps`,
`getStaticPaths`, and `createAppElement(context)`. This is why
`NEEDS_SERVER_BUNDLE` includes SSG.



### Misunderstanding 3: `/_nami/data/*` is the data prefetch process of SSR



No. It is an API for client-side routing to prefetch JSON. Data prefetching for HTML SSR requests occurs in `SSRRenderer.prefetchData()`.



### Myth 4: All rendering modes are handled the same way `redirect` / `notFound`



Execution timing differs, but the control semantics are now consistent. SSR and
Streaming SSR short-circuit GSSP to 30x/404 per request. SSG writes GSP redirects or
static 404 HTML plus a sidecar and restores the status/headers at runtime; an explicit
GSP redirect status is limited to `301/302/303/307/308`. An ISR cold MISS returns the
control response with `X-Nami-Cache: SKIP` and `private, no-store`. An internal
background rebuild instead carries `private, no-store` and tells the queue to delete
the old key; the original user response remains `STALE`. Neither path stores the
control response as a successful page. Degradation and ordinary failures are
different: they retain the old stale page.



### Misunderstanding 5: ISR canonicalizes query parameters in its full-URL cache key



It does not. `isrCacheMiddleware`, `ISRRenderer`, and the Hydration data scope all use the raw full URL (pathname + query). Thus `?a=1&b=2` and `?b=2&a=1` are separate entries, while cookies, headers, and tenant identity are not included. Customize `generateCacheKey()` when different semantics are required.



### Misunderstanding 6: `window.__NAMI_DATA__` contains only page props



No. For normal hydratable output, Nami consistently injects
`{ version: 1, props, degraded, renderMode, routePath }`.
The page consumes `props` and the optional degradation state; the client validates
`version`, then uses the remaining metadata to choose hydration versus CSR mounting
and scope the snapshot to the initial URL. Application entries should not replace
it. A stable static 404 is the exception and injects neither this envelope nor a
client bundle.



---



## Next step



- Server-side middleware sequence: Read [Server and Middleware](./server-and-middleware.md)
- ISR cache storage and invalidation: read [ISR and cache](./isr-and-caching.md)
- Double Bundle and static generation during build: read [Build System](./webpack-build.md)
