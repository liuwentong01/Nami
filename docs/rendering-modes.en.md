# Rendering Mode Principles



Nami's rendering system consists of four formal `RenderMode` enumerations and a streaming variant of SSR. There are only four enumerations in the source code: `csr`, `ssr`, `ssg`, and `isr`; Streaming SSR is not an independent enumeration, but the renderer variant selected when the SSR route is `meta.streaming === true` and the runtime has `appElementFactory`.



When reading this chapter, you need to distinguish three links:



1. **HTML rendering link**: `renderMiddleware` creates a specific Renderer after matching the route and outputs the page HTML.
2. **Data prefetch API link**: `dataPrefetchMiddleware` only processes `GET /_nami/data/*` and returns JSON, which is not equivalent to data prefetching before HTML rendering.
3. **Build-time static generation path**: `NamiBuilder.generateStaticPages()` reads the server bundle after `nami build` and writes static HTML for the SSG/ISR route.



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



These three constants explain a common question: SSG does not need to perform server-side rendering during the runtime, but the build phase still requires the server bundle to execute `getStaticProps`, `getStaticPaths` or page rendering functions.



| Features | CSR | SSR | SSG | ISR | Streaming SSR |
|------|-----|-----|-----|-----|---------------|
| Is the `RenderMode` enumeration | Yes | Yes | Yes | Yes | No, SSR variant |
| HTML generation location | Generate empty shell on request | Server-side rendering for each request | Build-time generation | Build-time + runtime revalidation | Server-side streaming rendering for each request |
| Whether to execute the page data function | Not executed by the server | HTML link execution `getServerSideProps` | Construction period execution `getStaticProps` | Cache miss/revalidation execution `getStaticProps` | Executed the same as SSR `getServerSideProps` |
| Is the server required during runtime | No | Yes | React SSR is not required when reading static files | Yes | Yes |
| Whether the first screen HTML already contains content | No | Yes | Yes | Yes when the cache is hit | Yes, and it can be returned in chunks |
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



Whether `StreamingSSRRenderer` is actually created depends on `RendererFactory`: only when `preferStreaming === true` and `appElementFactory` exist, the streaming renderer will be returned; otherwise, ordinary `SSRRenderer` will still be returned.



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
5. Empty container `<div id="nami-root"></div>`
6. Client JS Bundle



CSR does not execute page data functions on the server side:



```typescript
async prefetchData() {
  return { data: {}, errors: [], degraded: false, duration: 0 };
}
```



Default response cache:



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
  -> withTimeout(executeSSR(), config.server.ssrTimeout)
       -> prefetchData(context)
       -> context.initialData = prefetchResult.data
       -> renderAppHTML(context)
       -> ensureDocumentHTML(renderedHTML, context)
       -> createDefaultResult(..., RenderMode.SSR)
  -> callPluginHook('afterRender')
```



### Server entry protocol



SSR supports two server-side rendering portals:



| Entrance | Description |
|------|------|
| `htmlRenderer(context, initialData)` | Compatible with `entry-server.renderToHTML()`, directly returns HTML string |
| `appElementFactory(context)` | Returns the React element, the framework dynamically imports `react-dom/server` and calls `renderToString()` |



`renderAppHTML()` takes precedence over `htmlRenderer`. If `htmlRenderer` is not available, use `appElementFactory`.



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



In the current HTML rendering link, `SSRRenderer` will execute `getServerSideProps` first. If `redirect` or `notFound` is returned, the renderer will short-circuit before React rendering and return 30x or 404 respectively; otherwise, `result.props ?? {}` will be used as page data to continue assembling HTML. Streaming SSR will also process such early results before starting streaming output to avoid trying to change the status code after the shell has been written.



### HTML assembly and water injection



If `htmlRenderer` returns a complete HTML document, `ensureDocumentHTML()` directly transmits it transparently; otherwise, `assembleHTML()` assembles the document:



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



Currently the static generation of `nami build` is mainly done by `NamiBuilder.generateStaticPages()` instead of executing `SSGRenderer.generateStatic()` separately:



```text
nami build
  -> client/server Webpack compilation completed
  -> generateStaticPages(routes)
       -> Read dist/server/entry-server.js
       -> Create ModuleLoader
       -> Traverse SSG/ISR route
       -> Dynamic routing executes getStaticPaths()
       -> Execute getStaticProps() for each path
       -> renderToHTML / pageModule.render / pageModule.default / hidden shell
       -> write dist/static/{path}/index.html
```



For dynamic routing, `generateStaticPages()` is only executed when `route.path.includes(':') && route.getStaticPaths` is `getStaticPaths`. If the dynamic route cannot find the corresponding function, a warn will be logged and the route will be skipped.



Build-time rendering strategies in order of priority:



| Priority | Conditions | Behavior |
|--------|------|------|
| 1 | `serverBundle.renderToHTML` is a function | calls `renderToHTML(actualPath, props)` |
| 2 | `pageModule.render` is a function | calling `pageModule.render({ path, props })` |
| 3 | `pageModule.default` is the function | `React.createElement(default, props)` followed by `renderToString()` |
| 4 | None of them exist | Generate minimal HTML shell with `window.__NAMI_DATA__` |



The output path is:



```text
dist/static/index.html
dist/static/about/index.html
dist/static/blog/hello/index.html
```



### Runtime



The runtime logic of `SSGRenderer.render()` is to read static files:



```text
SSGRenderer.render(context)
  -> callPluginHook('beforeRender')
  -> resolveStaticFilePath(context.path)
  -> fileReader.readFile(filePath)
  -> createDefaultResult(..., RenderMode.SSG)
  -> callPluginHook('afterRender')
```



When the static file does not exist, `RenderError` is thrown, and the upper layer enters the downgrade process.



Default response cache:



```http
Cache-Control: public, max-age=3600, s-maxage=86400
```



### `SSGRenderer.generateStatic()`



`SSGRenderer` itself also implements `generateStatic(routes)`, `getStaticPaths`, `getStaticProps` and other construction capabilities, but the current CLI uses `NamiBuilder.generateStaticPages()` to build the main link. Documentation and troubleshooting should be based on the Builder link.



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
ctx.path
```



This means that the default ISR cache layer does not contain queries, cookies, or headers. If the page content depends on these factors, you need to customize the cache key, otherwise different variants may share the same cache.



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
| Miss | Render synchronously and write to cache asynchronously |



Background re-authentication is implemented through internal requests, and the request header contains:



```http
x-nami-isr-revalidate: 1
X-Requested-With: nami-isr-revalidate
```



Requests with this header will bypass `isrCacheMiddleware` and directly enter the rendering layer to avoid background re-validation and hitting the stale cache again.



### `ISRRenderer`



The responsibility of `ISRRenderer` is not to handle cache hits, but to generate new HTML on cache misses or revalidations:



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



`prefetchData()` executes `getStaticProps`, not `getServerSideProps`.



The `cacheControl` returned by ISRRenderer contains:



```typescript
{
  revalidate,
  staleWhileRevalidate: revalidate * 2,
  tags: extractCacheTags(context),
}
```



There are two types of tag sources:



| Source | Field |
|------|------|
| Routing configuration | `route.meta.cacheTags` |
| Plug-in or business writing | `context.extra.cacheTags` |



Two sets of cache key logic need to be distinguished: `isrCacheMiddleware` uses `ctx.path` by default, while `ISRRenderer.buildCacheKey()` will spell the sorted query into the key. The default production link usually passes through the middleware first, so the actual cache hit behavior is subject to the default key of the middleware.



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



`RendererFactory` creates `StreamingSSRRenderer` only if the following conditions are true:



```typescript
mode === RenderMode.SSR
  && preferStreaming
  && appElementFactory
```



If the SSR only provides `htmlRenderer`, the Streaming SSR will not be entered because streaming rendering requires a React element tree.



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



SSRs, ISRs, Streaming SSRs, and build-time boilerplate HTML can all be injected:



```html
<script>window.__NAMI_DATA__={...}</script>
```



Variable names come from `packages/shared/src/constants/defaults.ts`:



```typescript
export const NAMI_DATA_VARIABLE = '__NAMI_DATA__';
```



`generateDataScript(context.initialData)` injects the `initialData` object itself, which is the `props` returned by `getServerSideProps` / `getStaticProps`.



### Client read



The client reads at `packages/client/src/data/data-hydrator.ts`:



```typescript
const rawData = hydrateData<ServerInjectedData>(NAMI_DATA_VARIABLE);
cachedData = rawData;
```



The client mounting entry is located at `packages/client/src/entry-client.tsx`:



```typescript
const serverData = readServerData();
const renderMode = (serverData.renderMode || config.defaultRenderMode) as RenderMode;

<NamiApp initialData={serverData.props} />
```



This means that the current type level describes `window.__NAMI_DATA__` as containing `props`, `renderMode`, `routePath`, but the renderer injects the `props` object itself by default. If the business wants the client to read according to `serverData.props`, it needs to ensure that the injected data structure is consistent with the client's reading agreement. This is an area that needs special attention in the current implementation. The documentation does not treat type annotations as the actual output shape of all renderers.



### Hydration vs CSR mount



The client decides whether to Hydration based on `renderMode !== 'csr'` and the container has child nodes:



| Conditions | Mounting method |
|------|----------|
| Non-CSR and `container.childNodes.length > 0` | `hydrateApp()`, reuse server-side HTML |
| CSR or container is empty | `renderApp()`, client creates DOM |



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
| `redirect` / `notFound` | SSR / Streaming SSR will be short-circuited to 30x / 404 before rendering | API will be converted to 307/308 or 404 |
| Return content | HTML/stream | JSON or 204 |
| Path prefix | Page original path | `/_nami/data` |



---



## 12. Downgrade strategy



Source code location:



- `packages/server/src/middleware/render-middleware.ts`
- `packages/core/src/error/degradation.ts`



After the rendering error is thrown, `renderMiddleware` first checks whether the plug-in provides skeleton screen HTML:



```typescript
if (typeof renderContext.extra.__skeleton_fallback === 'string') {
  ctx.status = 200;
  ctx.set('X-Nami-Render-Mode', 'skeleton-fallback');
  ctx.body = skeletonHtml;
  return;
}
```



Otherwise enter `DegradationManager.executeWithDegradation()`:



| Level | Conditions | Return |
|------|------|------|
| Level 0 | Original rendering retry successful | Original rendering result |
| Level 1 | `config.maxRetries > 0` | Result after retry |
| Level 2 | `config.ssrToCSR` | CSR empty shell |
| Level 3 | `context.route.skeleton` exists | Built-in skeleton screen HTML |
| Level 4 | `config.staticHTML` exists | Static HTML |
| Level 5 | All failed | 503 pages |



Note: `context.route.skeleton` is currently only a condition that triggers the built-in skeleton HTML, not loading and rendering the skeleton component file.



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



Server-side rendering does not need to be performed during the runtime, but the server bundle execution page module, `getStaticProps`, `getStaticPaths` or `renderToHTML` is required during the build period. This is why `NEEDS_SERVER_BUNDLE` includes SSG.



### Misunderstanding 3: `/_nami/data/*` is the data prefetch process of SSR



No. It is an API for client-side routing to prefetch JSON. Data prefetching for HTML SSR requests occurs in `SSRRenderer.prefetchData()`.



### Myth 4: All rendering modes are handled the same way `redirect` / `notFound`



The HTML link of SSR and Streaming SSR will convert `redirect` / `notFound` of `getServerSideProps` into an HTTP response; the data prefetch API will also return the corresponding JSON/status code. SSG/ISR still needs to be understood in conjunction with the execution timing of the build period, cache layer, and specific renderer. Do not simply equate all modes to the complete semantics of Next.js.



### Misunderstanding 5: ISR caches the complete URL by default



The default `isrCacheMiddleware` uses `ctx.path` as the cache key, without query. `ISRRenderer` The internal helper will spell query, but by default the production cache hits go through the middleware first, so it needs to be understood according to the middleware behavior.



### Misunderstanding 6: `window.__NAMI_DATA__` must be `{ props, renderMode }`



The type allows this structure, but the renderer injects `context.initialData` itself by default. The client `entry-client.tsx` reads `serverData.props`, so if the project relies on structured water injection, it needs to ensure that the server bundle output is consistent with the client reading protocol.



---



## Next step



- Server-side middleware sequence: Read [Server and Middleware](./server-and-middleware.en.md)
- ISR cache storage and invalidation: read [ISR and cache](./isr-and-caching.en.md)
- Double Bundle and static generation during build: read [Build System](./webpack-build.en.md)
