# In-Depth Architecture Design Analysis

This document is intended for framework developers and architects. It explains Nami's overall architecture, package dependency relationships, request lifecycle, and key design decisions in detail. After reading it, you will understand:

- Why the code is organized this way
- What happens to an HTTP request from entry to response
- The trade-offs behind key design decisions

---

## 1. Monorepo Package Structure

Nami uses a pnpm workspace monorepo. Each package follows the **single responsibility** principle:

```
packages/
├── shared/        Zero dependencies — types, constants, utility functions
├── core/          Pure logic — renderers, routing, plugins, configuration, errors
├── server/        Koa service — middleware, ISR, cluster, graceful shutdown
├── client/        Browser side — Hydration, routing, data, Head
├── webpack/       Build system — config factories, Loader, Plugin
├── cli/           Command line — dev / build / start / generate / analyze / info
├── create-nami-app/ Scaffold
├── plugin-cache/     Cache plugin
├── plugin-monitor/   Monitoring plugin
├── plugin-request/   Request plugin
├── plugin-skeleton/  Skeleton screen plugin
└── plugin-error-boundary/ Error boundary plugin
```

### Dependency Diagram

```
                    @nami/shared  ← All packages depend on it
                    ┌─────┴─────┐
               @nami/core    @nami/client
                 ↑    ↑          ↑
    ┌────────────┤    │          │
    │            │    │          │
@nami/server  @nami/webpack  @nami/cli
    ↑                            ↑
    └────────────────────────────┘
                  │
            @nami/cli (orchestration layer)
```

**Design principles**:
- `shared` does not depend on any package — it contains pure types and utilities, and is the "common language" of all packages
- `core` does not depend on `server` — avoids circular dependencies and decouples through interfaces (`PluginManagerLike`, `ISRManagerLike`, `ModuleLoaderLike`)
- `client` does not depend on `server` — pure browser-side code that cannot import Node.js APIs
- `server` depends on `core` — the service layer assembles core capabilities
- `cli` is the top-level orchestrator — it wires all packages together

> **Why does core not directly depend on server?**
> Because renderers in `core` (`ISRRenderer`, `SSRRenderer`) need to interact with the ISR cache and module loader, but these are implementations in the `server` package. If `core` depended on `server`, it would create a circular dependency (`server` → `core` → `server`). The solution is to define interfaces in `core` (such as `ISRManagerLike` and `ModuleLoaderLike`), let `server` provide implementations, and inject them at runtime through dependency injection. This is an application of the **dependency inversion principle**.

## 2. Core Abstractions and Design Patterns

### 2.1 Renderer (Template Method + Factory + Degradation Chain)

```
                 BaseRenderer (abstract base class)
                ┌─────┴──────────────┐
                │ render()           │ ← Abstract method
                │ prefetchData()     │ ← Abstract method
                │ getMode()          │ ← Abstract method
                │ createFallbackRenderer() │ ← Overridable
                │                    │
                │ resolveAssets()    │ ← Common implementation
                │ callPluginHook()   │ ← Common implementation
                │ withTimeout()      │ ← Common implementation
                └────────────────────┘
         ┌──────────┬──────────┬──────────┬──────────┐
    CSRRenderer  SSRRenderer  SSGRenderer ISRRenderer StreamingSSRRenderer
    fallback:   fallback:    fallback:   fallback:   fallback:
    null        CSR          CSR         CSR         SSR → CSR
```

**Degradation chain**: Streaming SSR → normal SSR → CSR → null (terminal). Each renderer's `createFallbackRenderer()` returns the next-level renderer, and `assetManifest` is passed along the chain to ensure resource references remain correct after degradation.

```
Example: Streaming SSR rendering fails
  1. StreamingSSRRenderer.render() throws an exception
  2. Call createFallbackRenderer() → get an SSRRenderer instance
  3. SSRRenderer.render() also fails
  4. Call createFallbackRenderer() → get a CSRRenderer instance
  5. CSRRenderer.render() → returns shell HTML (it will not fail at this point because React rendering is not executed)
```

**RendererFactory**: `RendererFactory.create(options)` selects the concrete renderer implementation based on `RenderMode`. It is the unified entry for the server and CLI. Upper-level code does not need to know which renderer is used; it only needs to call `renderer.render(context)`.

### 2.2 Plugin System (Observer + Strategy)

```
NamiPlugin.setup(api)
      │
      ▼
PluginAPIImpl ──register──▶ HookRegistry
      │                    │
      │              handlers: Map<hookName, HookHandler[]>
      │                    │
      │        ┌───────────┼───────────┐
      ▼        ▼           ▼           ▼
PluginManager.runWaterfallHook()  .runParallelHook()  .runBailHook()
```

Three hook modes:
- **Waterfall**: `modifyWebpackConfig`, `modifyRoutes`, `wrapApp` — the previous handler's output is the next handler's input
- **Parallel**: `onBeforeRender`, `onAfterRender`, and others — all handlers execute concurrently (`Promise.allSettled`)
- **Bail**: the core scheduler has implemented `runBailHook()`, where the first value that is neither `null` nor `undefined` becomes the final result; currently no Bail lifecycle hook is officially exposed in `HOOK_DEFINITIONS`

**Error isolation**: A single plugin hook failure does not interrupt the whole hook chain. It only records a log and asynchronously triggers the `onError` hook.

### 2.3 Route Matching (Priority Sorting + Compile Cache)

```
path-matcher.ts
  compilePath(pattern) → CompiledMatcher (cached in ruleCache, maximum 1024)
  matchPath(pattern, path) → PathMatchResult | null
  rankRoutes(routes) → sort by priority

    Scoring rules:
    ┌─────────────┬───────┐
    │ Segment type │ Score │
    ├─────────────┼───────┤
    │ Static /users │  3   │
    │ Constraint :id(\\d+)│  2  │
    │ Dynamic :id │  1    │
    │ Wildcard *  │  0    │
    │ No-wildcard bonus │ +1 │
    └─────────────┴───────┘

RouteManager
  → getRankedRoutes() (with cache)
  → match(path): matchPath one by one + recursive children
```

**Single matching source**: `matchConfiguredRoute` in the server-side `route-match.ts` is shared by the ISR cache middleware, rendering middleware, and data prefetch middleware, ensuring all three hit the same route.

## 3. Request Lifecycle (SSR Mode)

The full journey of an HTTP GET request in Nami:

```
                           Browser GET /products/123
                                    │
    ┌───────────────────────────────┼───────────────────────────┐
    │                           Koa Server                      │
    │                                                           │
    │  ①  shutdownAware  ─ shutting down? → 503                 │
    │           │                                               │
    │  ②  timing  ─ record process.hrtime                       │
    │           │                                               │
    │  ③  security  ─ set security response headers             │
    │           │                                               │
    │  ④  requestContext  ─ generate requestId, create logger   │
    │           │                                               │
    │  ⑤  healthCheck  ─ path === /_health? → short-circuit     │
    │           │                                               │
    │  ⑥  staticServe  ─ defer downstream; try static file if unhandled │
    │           │                                               │
    │  ⑦  [user middleware]  ─ config.server.middlewares        │
    │           │                                               │
    │  ⑧  [plugin middleware]  ─ pluginManager.getServerMiddlewares() │
    │           │                                               │
    │  ⑨  dataPrefetch  ─ path starts with /_nami/data? → JSON response │
    │           │                                               │
    │  ⑩  errorIsolation  ─ wrap downstream in try/catch        │
    │           │                                               │
    │  ⑪  isrCacheMiddleware  ─ ISR route? cache hit? → short-circuit │
    │           │ (cache miss or non-ISR route)                  │
    │           │                                               │
    │  ⑫  renderMiddleware                                      │
    │      │                                                    │
    │      ├── matchConfiguredRoute(path, routes)                │
    │      ├── construct RenderContext                           │
    │      ├── RendererFactory.create({ mode, ... })            │
    │      ├── renderer.render(context)                          │
    │      │     ├── callPluginHook('beforeRender')             │
    │      │     ├── prefetchData() (getServerSideProps)        │
    │      │     ├── redirect/notFound? → return 30x/404 directly │
    │      │     ├── renderToString() / renderToPipeableStream  │
    │      │     ├── assembleHTML() + resolveAssets()            │
    │      │     └── callPluginHook('afterRender')              │
    │      ├── applyPluginExtras(renderContext.extra)            │
    │      └── setResponse(ctx, result)                         │
    │                                                           │
    │  timing ← write X-Response-Time                           │
    │  security ← write Cache-Control                           │
    │                                                           │
    └───────────────────────────────────────────────────────────┘
                                    │
                           Browser receives full HTML
                                    │
                           Load JS → Hydration
```

### Degradation Flow When Rendering Fails

```
renderer.render() fails
        │
        ▼
Check context.extra.__skeleton_fallback? → return skeleton screen if present
        │ Not present
        ▼
DegradationManager.executeWithDegradation()
  Level 0: retry the provided normal renderFn
  Level 1: retry (maxRetries times)
  Level 2: CSR degradation (shell HTML + JS/CSS)
  Level 3: skeleton screen (route.skeleton configuration)
  Level 4: static HTML (fallback.staticHTML)
  Level 5: 503 Service Unavailable
```

## 4. Build Process

```
nami build
    │
    ▼
NamiBuilder.build('production')
    │
    ├── 1. Clean dist/
    ├── 2. prepareBuildContext()
    │      └── pluginManager.runWaterfallHook('modifyRoutes', routes)
    │
    ├── 3. Analyze routes → decide build tasks
    │      CSR routes → client build
    │      SSR routes → client + server build
    │      SSG/ISR routes → client + server + ssg build
    │
    ├── 4. Generate code
    │      .nami/generated-route-modules.ts  (route→component mapping)
    │      .nami/generated-core-client-shim.ts (slim @nami/core)
    │
    ├── 5. Create Webpack configurations
    │      ├── createClientConfig()  → dist/client/
    │      ├── createServerConfig()  → dist/server/
    │      └── createSSGConfig()     → reuse server config
    │
    ├── 6. pluginManager.runWaterfallHook('modifyWebpackConfig', config)
    │
    ├── 7. Run webpack compilation in parallel
    │
    ├── 8. SSG routes → generateStaticPages()
    │      ├── require('dist/server/entry-server.js')
    │      ├── call renderToString for each static path
    │      └── write dist/static/xxx/index.html
    │
    └── 9. Write nami-manifest.json (route→rendering mode mapping)
```

### Key Build Outputs

```
dist/
├── client/                    # Browser-side outputs
│   ├── static/
│   │   ├── js/
│   │   │   ├── main.[hash].js
│   │   │   ├── vendor.[hash].js
│   │   │   └── runtime.[hash].js
│   │   └── css/
│   │       └── main.[hash].css
│   └── asset-manifest.json    # File name → URL mapping
│
├── server/                    # Server-side outputs
│   ├── entry-server.js        # Server entry (includes createAppElement / renderToHTML)
│   └── [page-chunks].js       # Page-level server code
│
├── static/                    # SSG / ISR pre-generated HTML
│   ├── index.html
│   └── xxx/index.html
│
└── nami-manifest.json         # route→rendering mode mapping table
```

### A Complete but Not Overloaded Build Example

Assume we have a hybrid "content + product" site with the following route configuration:

```typescript
routes: [
  {
    path: '/',
    component: './pages/home',
    renderMode: RenderMode.CSR,
  },
  {
    path: '/products',
    component: './pages/products',
    renderMode: RenderMode.SSR,
    getServerSideProps: 'getServerSideProps',
  },
  {
    path: '/docs',
    component: './pages/docs',
    renderMode: RenderMode.SSG,
    getStaticProps: 'getStaticProps',
  },
  {
    path: '/products/:id',
    component: './pages/product-detail',
    renderMode: RenderMode.ISR,
    getStaticProps: 'getStaticProps',
    getStaticPaths: 'getStaticPaths',
    revalidate: 30,
    fallback: 'blocking',
  },
];
```

This example is not too large, but it already covers the four most important build-time cases:

- `CSR`: only needs the client Bundle
- `SSR`: needs the client Bundle + Server Bundle
- `SSG`: needs the client Bundle + Server Bundle + pre-generated HTML
- `ISR`: needs the client Bundle + Server Bundle + initial static HTML + runtime revalidation

Therefore, after running `nami build`, Builder splits the work into three types of tasks:

1. **client build**: because all pages eventually depend on browser-side JS for route transitions, Hydration, or interactions.
2. **server build**: because `/products` (SSR) and `/products/:id` (ISR) exist, so the server needs executable page modules.
3. **static page generation**: because `/docs` (SSG) and `/products/:id` (ISR) exist, and the initial HTML must continue to be generated after the build completes.

You can think of this build as producing the following more concrete outputs:

```text
.nami/
├── generated-route-modules.ts
└── generated-core-client-shim.ts

dist/
├── client/
│   ├── static/js/
│   │   ├── runtime.a1b2c3d4.js
│   │   ├── vendor.e5f6g7h8.js
│   │   ├── main.i9j0k1l2.js
│   │   ├── route-pages-home.m3n4o5p6.chunk.js
│   │   ├── route-pages-products.q7r8s9t0.chunk.js
│   │   ├── route-pages-docs.u1v2w3x4.chunk.js
│   │   └── route-pages-product-detail.y5z6a7b8.chunk.js
│   ├── static/css/
│   │   └── main.c9d0e1f2.css
│   └── asset-manifest.json
│
├── server/
│   ├── entry-server.js
│   ├── pages/home.js
│   ├── pages/products.js
│   ├── pages/docs.js
│   └── pages/product-detail.js
│
├── static/
│   ├── docs/index.html
│   ├── products/1001/index.html
│   └── products/1002/index.html
│
└── nami-manifest.json
```

The most important files to pay attention to are:

#### 1) `.nami/generated-route-modules.ts`

This is a static "route to component module" mapping automatically generated during the build. Its purpose is to let the client load page modules on demand instead of writing a dynamic expression like `import(componentPath)`:

```typescript
export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "../src/pages/home"),
  "./pages/products": () => import(/* webpackChunkName: "route-pages-products" */ "../src/pages/products"),
  "./pages/docs": () => import(/* webpackChunkName: "route-pages-docs" */ "../src/pages/docs"),
  "./pages/product-detail": () => import(/* webpackChunkName: "route-pages-product-detail" */ "../src/pages/product-detail"),
};
```

The result is that page-level chunks, such as `route-pages-products.*.chunk.js`, appear in the client output.

#### 2) `.nami/generated-core-client-shim.ts`

This is a slim entry used by the client bundle. It does not bundle the entire `@nami/core` into the browser. It only keeps the few capabilities actually needed on the client:

```typescript
export { PluginManager } from "../../../packages/core/dist/plugin/plugin-manager";
export { NamiDataProvider } from "../../../packages/core/dist/data/data-context";
export { matchPath } from "../../../packages/core/dist/router/path-matcher";
```

The purpose of this step is to avoid accidentally bundling server-only capabilities (such as configuration loading and module loaders) into the browser Bundle.

#### 3) `dist/client/asset-manifest.json`

It records the mapping from "logical asset names" to "real hashed file names". When renderers output HTML on the server, they do not hardcode `main.js`. Instead, `resolveAssets()` and `ScriptInjector` first look up this manifest:

```json
{
  "files": {
    "main.js": "/static/js/main.i9j0k1l2.js",
    "main.css": "/static/css/main.c9d0e1f2.css",
    "vendor.js": "/static/js/vendor.e5f6g7h8.js",
    "runtime.js": "/static/js/runtime.a1b2c3d4.js"
  },
  "entrypoints": [
    "/static/js/runtime.a1b2c3d4.js",
    "/static/js/vendor.e5f6g7h8.js",
    "/static/css/main.c9d0e1f2.css",
    "/static/js/main.i9j0k1l2.js"
  ]
}
```

This way, even when file names include content hash after deployment, the server can still inject the correct `<script>` / `<link>`.

#### 4) `dist/server/`

This layer is used by the Node.js runtime and is not sent to the browser:

- `entry-server.js`: unified server entry that carries capabilities such as `renderToHTML()`
- `pages/*.js`: page-level server modules used by `ModuleLoader` to load `getServerSideProps`, `getStaticProps`, and `getStaticPaths`

This is also why SSR / SSG / ISR routes all need a server bundle: SSR / ISR perform server rendering or revalidation at runtime, while SSG also executes page modules and data prefetch functions through the server bundle during the build.

#### 5) `dist/static/`

This is the HTML additionally generated after the build ends:

- `/docs/index.html`: from the SSG route `/docs`
- `/products/1001/index.html`, `/products/1002/index.html`: from the initial pre-generated paths of the ISR route `/products/:id`

If `getStaticPaths()` returns:

```typescript
return {
  paths: [
    { params: { id: '1001' } },
    { params: { id: '1002' } },
  ],
};
```

Then the build phase only generates these two product detail pages first. Later pages such as `/products/1003` that were not pre-generated are generated at runtime according to the `fallback: 'blocking'` strategy.

#### 6) `nami-manifest.json`

This is the framework-wide manifest that records "how each route should be handled":

```json
{
  "appName": "nami-mixed-demo",
  "routes": [
    { "path": "/", "component": "./pages/home", "renderMode": "csr" },
    {
      "path": "/products",
      "component": "./pages/products",
      "renderMode": "ssr",
      "getServerSideProps": "getServerSideProps"
    },
    {
      "path": "/docs",
      "component": "./pages/docs",
      "renderMode": "ssg",
      "getStaticProps": "getStaticProps"
    },
    {
      "path": "/products/:id",
      "component": "./pages/product-detail",
      "renderMode": "isr",
      "getStaticProps": "getStaticProps",
      "getStaticPaths": "getStaticPaths",
      "revalidate": 30,
      "fallback": "blocking"
    }
  ],
  "moduleManifest": {
    "./pages/home": "pages/home.js",
    "./pages/products": "pages/products.js",
    "./pages/docs": "pages/docs.js",
    "./pages/product-detail": "pages/product-detail.js"
  }
}
```

At server runtime, it uses this manifest to know:

- When requesting `/products`, it should use SSR and look for `getServerSideProps` in the server bundle
- When requesting `/docs`, it should prioritize using pre-generated HTML
- When requesting `/products/1001`, it should read the cache according to the ISR strategy, determine whether it has expired, and trigger revalidation when necessary

If you remember only one conclusion, remember this sentence:

> `nami build` does not simply produce a frontend bundle. It produces "browser assets + Node runtime code + pre-generated HTML + framework manifest" at the same time, allowing CSR, SSR, SSG, and ISR to coexist in the same project.

## 5. Cluster Architecture

```
                    ┌─────────────────────┐
                    │    Master process    │
                    │                     │
                    │  cluster.fork() × N │
                    │  listen worker:ready│
                    │  SIGTERM → notify all│
                    │  workers exit → restart │
                    └──────┬──────────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
     ┌──────────┐   ┌──────────┐   ┌──────────┐
     │ Worker 1 │   │ Worker 2 │   │ Worker N │
     │          │   │          │   │          │
     │ Koa App  │   │ Koa App  │   │ Koa App  │
     │ Separate │   │ Separate │   │ Separate │
     │ memory   │   │ memory   │   │ memory   │
     │ Shared   │   │ Shared   │   │ Shared   │
     │ port     │   │ port     │   │ port     │
     └──────────┘   └──────────┘   └──────────┘
```

**Readiness semantics**: A Worker sends a `{ type: 'worker:ready' }` IPC message inside the `app.listen` callback (after the port has been bound), rather than relying only on the `online` event (where the port may not have been bound yet).

**Graceful shutdown**:
1. Master process receives SIGTERM → sends SIGTERM to all Workers
2. Worker receives SIGTERM → `onSignalReceived()` activates the shutdownAware middleware → new requests receive 503
3. Worker `server.close()` → waits for in-flight requests to complete (or time out)
4. Worker performs cleanup: ISR shutdown → plugin dispose → custom onShutdown
5. Worker `process.exit(0)`
6. Master process waits for all Workers to exit (35-second forced timeout)

## 6. Isomorphic Design

Nami manages isomorphic boundaries through the following mechanisms:

### Data Hydration

SSR pages need to solve a core problem: **how does data fetched on the server get passed to the client?**

The answer is to serialize the data as JSON and inject it into a `<script>` tag in the HTML. After client JavaScript loads, it reads this global variable. This process is called "data hydration":

```
Server                              Client
────                                ────
getServerSideProps()
   │ returns { props: { title, items } }
   ▼
context.initialData = { title, items }
   │
   ▼
generateDataScript(data)           window.__NAMI_DATA__ = { title, items }
   │ (XSS-safe serialization:              │ (JSON deserialized into a JS object)
   │  escape dangerous characters          │
   │  such as </script>)                   │
   ▼                                       ▼
<script>window.__NAMI_DATA__=...</script>  hydrateData('__NAMI_DATA__')
   │                                       │ (read data from window)
   ▼                                       ▼
renderToString(<App data={data} />)        hydrateRoot(<App data={data} />)
   │ (server renders full HTML with data)  │ (client reruns React with the same data)
```

> **Why is XSS-safe serialization needed?** Because data is embedded in a `<script>` tag. If the data contains the string `</script>`, the HTML parser closes the script tag early, which may be exploited to execute malicious code. `generateDataScript()` escapes these dangerous characters.

### Server Code Stripping

`packages/webpack/src/loaders/data-fetch-loader.ts` provides the ability to replace `getServerSideProps`, `getStaticProps`, and `getStaticPaths` with empty implementations to prevent sensitive server logic from entering the browser Bundle. Note that the current default TypeScript rule only integrates `ts-loader` and does not automatically chain `data-fetch-loader`. If a project relies on this stripping layer, it needs to explicitly integrate the loader into the client build through `config.webpack.client` or a plugin's `modifyWebpackConfig`.

### Client Bundle Slimming

`client.config.ts` generates `@nami/core-client-shim`, which only exports the client-needed `PluginManager`, `NamiDataProvider`, and `matchPath`, instead of the entire `@nami/core` (which includes server-side code such as renderers and configuration loading).

## 7. Key Design Decisions

| Decision | Reason |
|------|------|
| Koa instead of Express | Koa's onion model naturally fits middleware pipelines; async/await first |
| Abstract class instead of interface as renderer base class | Shared implementation code is needed (template method pattern) |
| Parse assets through `asset-manifest.json` | Supports long-term caching with content hash and avoids hardcoded file names |
| Separate ISR middleware from rendering middleware | ISR can short-circuit on cache hits without entering the renderer |
| Execute parallel hooks with `Promise.allSettled` | Ensures every plugin gets an execution opportunity; a single failure does not affect the whole |
| Route priority scoring (instead of registration order) | Static routes > dynamic routes > wildcard, which is intuitive and does not depend on registration order |
| Worker `worker:ready` IPC instead of `online` | `online` only means the process has started and does not guarantee the port has been bound |
| Degradation manager accepts `assetManifest` | CSR fallback needs correct JS/CSS references, otherwise the page is blank |

---

## Next Steps

- Want to dive deeper into the principles of each rendering mode? → [Five Rendering Modes](./rendering-modes.en.md)
- Want to understand middleware pipeline details? → [Server and Middleware](./server-and-middleware.en.md)
- Want to understand the build system? → [Build System](./webpack-build.en.md)

## Appendix: Route Compile Cache Notes

### Why Is It Needed?

Route matching is not simple string comparison. Patterns such as `/users/:id` and `/users/*` must first be "compiled" into executable rules before they can participate in matching, including:

- `RegExp` used to match request paths
- `paramNames` used to extract parameters
- `score` used for route priority sorting

If the same route pattern is parsed from a string into a regular expression and metadata on every request, it creates repeated CPU overhead. This becomes especially obvious on the server, where one request goes through multiple phases such as the ISR cache middleware, data prefetch middleware, and rendering middleware.

Therefore, Nami introduces a compile cache in `path-matcher.ts`: the same `pattern + options` is compiled only once on first use and reused afterwards.

### Which Phase Does It Run In?

The "compile cache" here is not a build-time cache like Webpack, Vite, or TypeScript. It is a **runtime cache**:

- When the service starts, `ruleCache` is just an empty in-memory `Map`
- `compilePattern()` is called on demand only when `rankRoutes()` or `matchPath()` is executed for the first time
- When a route pattern is encountered for the first time, it is compiled and written into the cache immediately
- Later uses of the same pattern in the same process hit the cache directly

This means it optimizes **route matching performance during application runtime**, not build speed. After a process restart, the cache is naturally lost and is not persisted to disk.

### What Does It Do?

The compile cache has three core purposes:

1. Avoid repeatedly creating regular expression objects. Translating `/users/:id` into `RegExp` again and again is purely duplicated work; with caching, it is done only once.
2. Let "route sorting" and "path matching" share the same compiled result. `score`, `regexp`, and `paramNames` all come from the same `CompiledRule`, instead of being calculated separately.
3. Reduce the overall cost of repeated matching. When multiple server middlewares share `matchConfiguredRoute()`, each request still performs the actual matching, but it no longer needs to parse route patterns repeatedly.

You can understand it as:

- **Without compile cache**: "translate the rule" first every time, then "execute matching"
- **With compile cache**: "translate the rule and remember it" the first time, then directly "execute matching" afterwards

### How Does It Relate to the Sorting Cache?

The `ruleCache` in `path-matcher` caches the compiled result of **a single route rule**; the `rankedRoutesCache` in `RouteManager` caches the **whole route list after sorting**. They are complementary:

- Compile cache: reduces the parsing cost of a single route pattern
- Sorting cache: reduces the cost of repeatedly sorting the full route set

Therefore, the "priority sorting + compile cache" mentioned in section 2.3 essentially solves two problems together: it both guarantees "who should match first" and avoids repeated meaningless computation to derive that result.

## Appendix: Why Should `shared` Stay as Close to Zero-Dependency as Possible?

At the beginning of this document, `packages/shared` is marked as "zero dependencies". Here, "zero dependencies" does not mean it is technically impossible to install any package. Rather, it is an architectural boundary constraint: `shared` sits at the bottom of the dependency graph and is the foundational layer referenced by all packages in the repository.

```text
@nami/shared
  ├── @nami/core
  ├── @nami/server
  ├── @nami/client
  ├── @nami/webpack
  ├── @nami/cli
  └── plugin-*
```

If `shared` depends on a general-purpose runtime library such as `lodash`, it usually will not immediately break the framework, but it brings several amplified effects.

### 1. The Client Bundle May Grow Passively

`shared` is indirectly referenced by browser-side code such as `client` and `core-client-shim`. If a utility in `shared` imports `lodash`, even if only one small function is used, extra code may be brought into the client bundle due to bundling format, import style, or imperfect tree-shaking.

For a low-level package, a seemingly small dependency choice is inherited by all upper-level packages.

### 2. Dependencies Propagate Across the Whole Repository

`shared` is the common language of all packages. Once it depends on `lodash`, all packages that use `@nami/shared` are indirectly affected by `lodash`, including:

- Install size
- Version conflicts
- ESM / CJS compatibility
- Security vulnerability scanning
- Published output dependency declarations

If the dependency is only placed in an upper-level package such as `server` or `webpack`, the impact scope is much smaller. Placing it in `shared` expands the impact scope to the entire framework.

### 3. Compatibility Costs Across Runtime Environments Increase

`shared` runs in Node.js, browsers, build tools, plugins, and other environments at the same time. Any library it depends on must adapt to all of these environments.

For example, a dependency may work normally on the Node side but require a polyfill in the browser, or work normally under an ESM build but behave differently for CJS consumers. Such issues are easier to isolate in upper-level packages, but become global problems once introduced into `shared`.

### 4. The Low-Level Package Can Easily Accumulate Too Many Responsibilities

Ideally, `shared` should only contain:

- Type definitions
- Constants
- Very small utility functions with no side effects
- Pure logic needed across packages

If complex utilities keep being added to `shared` for the sake of using third-party libraries, `shared` changes from a "common language layer" into a "general-purpose toolbox". This weakens package boundaries, causes upper-level capabilities to gradually sink downward, and makes circular dependencies or unclear responsibilities more likely later.

### 5. Security and Release Risks Are Amplified

Once a low-level dependency has a security vulnerability, breaking upgrade, or supply-chain issue, it affects not just one feature module but all packages that depend on `shared`. For framework projects, the more stable a low-level package is and the fewer external dependencies it has, the lower the overall maintenance cost.

### Practical Recommendations

If you only need small capabilities such as `debounce`, `pick`, or `isPlainObject`, prioritize:

1. Implementing a very small internal function with a clear purpose in `shared`.
2. If a third-party library must be introduced, prefer a small, side-effect-free standalone package that explicitly supports ESM/tree-shaking.
3. If the dependency only serves a specific runtime environment, place it in the corresponding upper-level package, such as `server`, `webpack`, or a specific plugin package, instead of placing it in `shared`.

In short: `shared` is not forbidden from depending on anything, but every added dependency must be evaluated under the assumption that "it will affect the entire framework dependency graph".
