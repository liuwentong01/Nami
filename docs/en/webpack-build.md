# Webpack Build System Internals

Nami's build system does not simply bundle a React app into a browser Bundle. It must serve four rendering modes at the same time: CSR, SSR, SSG, and ISR. Therefore, it needs to analyze build targets by route and generate client artifacts, server artifacts, static HTML, and runtime manifests.

This chapter is based on the source code in `packages/webpack` and `packages/cli`. It explains what `nami build`, `nami dev`, `nami generate`, `nami analyze`, and `nami start` actually do, and which loaders/plugins are only exported capabilities but are not wired in by default.

---

## 1. Source Map

| Topic | Source |
|------|------|
| Builder orchestration | `packages/webpack/src/builder.ts` |
| Package export entry | `packages/webpack/src/index.ts` |
| Base Webpack config | `packages/webpack/src/configs/base.config.ts` |
| Client config | `packages/webpack/src/configs/client.config.ts` |
| Server config | `packages/webpack/src/configs/server.config.ts` |
| Development config wrapper | `packages/webpack/src/configs/dev.config.ts` |
| SSG config export | `packages/webpack/src/configs/ssg.config.ts` |
| TS / style / asset rules | `packages/webpack/src/rules/*.ts` |
| Code splitting strategy | `packages/webpack/src/optimization/split-chunks.ts` |
| Asset manifest plugin | `packages/webpack/src/plugins/manifest-plugin.ts` |
| CSR HTML plugin | `packages/webpack/src/plugins/html-inject-plugin.ts` |
| Route collection plugin | `packages/webpack/src/plugins/route-collect-plugin.ts` |
| SSR externals plugin | `packages/webpack/src/plugins/ssr-externals-plugin.ts` |
| Page metadata loader | `packages/webpack/src/loaders/page-loader.ts` |
| Data function stripping loader | `packages/webpack/src/loaders/data-fetch-loader.ts` |
| CLI build | `packages/cli/src/commands/build.ts` |
| CLI dev | `packages/cli/src/commands/dev.ts` |
| CLI generate | `packages/cli/src/commands/generate.ts` |
| CLI analyze | `packages/cli/src/commands/analyze.ts` |
| CLI start | `packages/cli/src/commands/start.ts` |
| Server runtime resolution | `packages/cli/src/utils/server-runtime.ts` |
| Development server | `packages/server/src/dev/dev-server.ts` |
| webpack-dev-middleware adapter | `packages/server/src/dev/webpack-dev.ts` |

---

## 2. Why Two Bundles Are Needed

Source locations:

- `packages/shared/src/constants/render-modes.ts`
- `packages/webpack/src/builder.ts`

Nami decides build tasks according to route rendering modes. The key constant is:

```typescript
export const NEEDS_SERVER_BUNDLE = [
  RenderMode.SSR,
  RenderMode.SSG,
  RenderMode.ISR,
];
```

This means:

| Mode | Client Bundle | Server Bundle | Static generation |
|------|---------------|---------------|----------|
| CSR | Required | Not required | Not required |
| SSR | Required | Required | Not required |
| SSG | Required | Required | Required |
| ISR | Required | Required | Requires initial pre-generation and runtime revalidation |

The two Bundles have different targets:

| Bundle | Runtime environment | Main responsibilities |
|--------|----------|----------|
| client | Browser | Start React, Hydration, client routing, load page chunks |
| server | Node.js | SSR/ISR runtime rendering, SSG build-time rendering, execute data functions |

SSG can return only static files at runtime, but the build phase still needs the server bundle to execute page modules, `getStaticProps`, `getStaticPaths`, or `renderToHTML`.

---

## 3. Overall `nami build` Flow

Source locations:

- `packages/cli/src/commands/build.ts`
- `packages/webpack/src/builder.ts`

CLI entry:

```text
nami build
  -> loadConfig(process.cwd())
  -> import('@nami/webpack').NamiBuilder
  -> new NamiBuilder(config, process.cwd())
  -> builder.build('production', { analyze, minimize })
```

Actual `NamiBuilder.build()` flow:

```text
build('production')
  -> if options.clean !== false, clear config.outDir
  -> prepareBuildContext(isDev=false)
       -> resolve config.plugins
       -> registerPlugins()
       -> runWaterfallHook('modifyRoutes', routes)
       -> update this.config.routes
  -> determineBuildTasks()
       -> always add client
       -> if any SSR/SSG/ISR routes exist, add server
       -> if any SSG/ISR routes exist and not dev, add ssg
  -> pluginManager.callHook('buildStart')
  -> run client/server Webpack compilation in parallel
  -> if compilation has errors, return failure directly and do not run SSG
  -> generateStaticPages(ssgRoutes)
  -> generateManifest()
  -> pluginManager.callHook('buildEnd')
  -> return BuildResult
```

Note: `buildStart` / `buildEnd` are short names for `PluginManager.callHook()`. Internally, they are mapped to the official hooks `onBuildStart` / `onBuildEnd`.

### BuildResult

`BuildResult` contains:

| Field | Meaning |
|------|------|
| `success` | Whether the build succeeded |
| `duration` | Total duration |
| `errors` | Webpack and SSG errors |
| `warnings` | Webpack warnings |
| `stats` | Webpack Stats for each build task |

Route-level errors in the SSG phase are collected into `this.ssgErrors` and finally merged into `BuildResult.errors`, so CI can detect partial page generation failures.

---

## 4. Build Task Determination

Source location: `packages/webpack/src/builder.ts`

Logic of `determineBuildTasks()`:

```text
tasks = []

client:
  always create createClientConfig()

server:
  if routes.some(route.renderMode in NEEDS_SERVER_BUNDLE)
    create createServerConfig()

ssg:
  ssgRoutes = routes.filter(renderMode === SSG || renderMode === ISR)
  if options.ssgRoutes exists, filter again by path
  if ssgRoutes.length > 0 && !isDev
    add task type='ssg'
```

Key points:

| Fact | Description |
|------|------|
| dev mode does not add the `ssg` task | Development does not perform build-time static generation |
| Both SSG and ISR enter static generation | ISR also generates the initial static HTML |
| `options.ssgRoutes` only filters static-generation routes | client/server Webpack still builds according to the overall config |
| The `ssg` task has no Webpack config | It reuses the already compiled server bundle | TODO |

---

## 5. Artifact Structure

Typical artifacts:

```text
dist/
├── client/
│   ├── static/
│   │   ├── js/
│   │   │   ├── main.[contenthash:8].js
│   │   │   ├── runtime.[contenthash:8].js
│   │   │   ├── vendor-react.[contenthash:8].js
│   │   │   ├── vendor.[contenthash:8].js
│   │   │   └── route-*.chunk.js
│   │   └── css/
│   │       ├── main.[contenthash:8].css
│   │       └── *.chunk.css
│   ├── asset-manifest.json
│   └── index.html                 # Generated by NamiHtmlInjectPlugin only when CSR routes exist
│
├── server/
│   ├── entry-server.js             # If src/entry-server.* exists
│   └── pages/xxx.tsx.js            # Page component server entry, corresponding to route.component
│
├── static/
│   ├── index.html                  # Generated by SSG/ISR
│   └── about/index.html
│
└── nami-manifest.json
```

SSG/ISR static HTML is written to `dist/static/.../index.html`, not `dist/client/...html`.

---

## 6. Base Config

Source location: `packages/webpack/src/configs/base.config.ts`

`createBaseConfig()` is the shared baseline for client and server:

| Config | Behavior |
|------|------|
| `mode` | `development` in dev, `production` in production |
| `resolve.extensions` | `.tsx`, `.ts`, `.jsx`, `.js`, `.json` |
| `resolve.alias` | `@` and `~` point to `srcDir` |
| `resolve.modules` | `node_modules` and project root `node_modules` |
| `module.rules` | TypeScript, assets, SVG |
| `module.noParse` | Skips `jquery|lodash` |
| `performance` | Enables asset size warnings in production mode |
| `stats` | `minimal` in dev, `normal` in production |
| `cache` | Webpack 5 filesystem cache |

Browser builds additionally disable Node built-in module fallback:

```typescript
fallback: {
  fs: false,
  path: false,
  crypto: false,
  stream: false,
}
```

The production cache version is generated as an 8-character md5 from config content, including `appName`, `srcDir`, `outDir`, `publicPath`, `defaultRenderMode`, and route paths.

### TypeScript Rule

Source location: `packages/webpack/src/rules/typescript.ts`

By default, only `ts-loader` is used:

```typescript
{
  test: /\.(ts|tsx)$/,
  exclude: /node_modules/,
  use: [{ loader: 'ts-loader', options: { transpileOnly: true, ... } }],
}
```

The server sets `compilerOptions.module = 'commonjs'`, while the client sets `module = 'esnext'` and enables `jsx: 'react-jsx'`. TODO

The default TypeScript rule does not chain `page-loader` or `data-fetch-loader`.

---

## 7. Client Config

Source location: `packages/webpack/src/configs/client.config.ts`

The client config is created by `createClientConfig()`.

### Automatically Generated `.nami` Files

Calling the config factory generates two files:

| File | Purpose |
|------|------|
| `.nami/generated-route-modules.ts` | Mapping from route component paths to dynamic import factories |
| `.nami/generated-core-client-shim.ts` | Browser-only lightweight entry for `@nami/core` |

`generated-route-modules.ts` exports:

```typescript
export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "..."),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions = [
  { path: "/", component: "./pages/home", exact: true },
];
```

The value of `exact` comes from `route.exact === false ? false : true`.

`generated-core-client-shim.ts` exports:

```typescript
export { PluginManager } from ".../dist/plugin/plugin-manager";
export { NamiDataProvider } from ".../dist/data/data-context";
export { matchPath } from ".../dist/router/path-matcher";
```

The goal is to avoid the browser bundle importing the full `@nami/core` entry and pulling in Node-only modules.

### Entry and Output

| Item | dev | production |
|------|-----|------------|
| entry | `webpack-hot-middleware/client` + `src/entry-client` | `src/entry-client` |
| filename | `static/js/[name].js` | `static/js/[name].[contenthash:8].js` |
| chunkFilename | `static/js/[name].chunk.js` | `static/js/[name].[contenthash:8].chunk.js` |
| publicPath | `config.assets.publicPath` | Same as left |
| clean | `false` | `true` |

### DefinePlugin

The client injects:

```typescript
process.env.NODE_ENV
process.env.NAMI_RENDER_MODE = "client"
```

It also injects all variables in `config.env` with the `NAMI_PUBLIC_` prefix. Variables without that prefix do not enter the client bundle.

### Styles and Code Splitting

Production uses `MiniCssExtractPlugin` to extract CSS. Development uses `style-loader` to support HMR.

Production code splitting comes from `createSplitChunksConfig()`:

| cacheGroup | Match | Output name |
|------------|------|--------|
| `react` | `react`, `react-dom`, `scheduler` | `vendor-react` |
| `vendor` | Other `node_modules` | `vendor` |
| `commons` | Referenced by at least two chunks | `commons` |
| `default` | Default reuse group | Webpack default naming |

Production also enables:

```typescript
runtimeChunk: { name: 'runtime' }
moduleIds: 'deterministic'
minimizer: [createTerserPlugin()]
```

---

## 8. Server Config

Source location: `packages/webpack/src/configs/server.config.ts`

The server config is created by `createServerConfig()`.

### Entry

The server entry contains two categories:

```typescript
entry: {
  ...(entryServerPath ? { 'entry-server': entryServerPath } : {}),
  ...routeEntries,
}
```

`entry-server` is added only when `src/entry-server.tsx|ts|jsx|js` exists. Page entries come from the deduplicated list of `config.routes[*].component`, for example:

```text
route.component = "./pages/Home.tsx"
entry name      = "pages/Home.tsx"
output file     = "pages/Home.tsx.js"
```

This stays consistent with the rules in `NamiBuilder.buildModuleManifest()`.

### Output and Module Format

| Config | Value |
|------|----|
| `target` | `node` |
| `output.path` | `{outDir}/server` |
| `filename` | `[name].js` |
| `libraryTarget` | `commonjs2` |
| `devtool` | `source-map` |
| `optimization.minimize` | `false` |
| `optimization.splitChunks` | `false` |
| `LimitChunkCountPlugin` | `maxChunks: 1` |

The server does not need browser code splitting. The Node runtime loads artifacts through CommonJS.

### Externals

Default server externalization uses `webpack-node-externals`:

```typescript
nodeExternals({
  allowlist: [
    /\.css$/,
    /^@nami\//,
  ],
})
```

This marks most `node_modules` as runtime `require`, while keeping CSS and `@nami/*` packages handled by Webpack.

`NamiSSRExternalsPlugin` also exists in `packages/webpack/src/plugins/ssr-externals-plugin.ts`, but `server.config.ts` does not register it by default. Do not describe this plugin as the default externalization implementation.

---

## 9. Built-in Webpack Plugins

### `NamiManifestPlugin`

Source location: `packages/webpack/src/plugins/manifest-plugin.ts`

`NamiBuilder.enhanceConfig()` injects `NamiManifestPlugin` into the client build and generates:

```text
dist/client/asset-manifest.json
```

Format:

```json
{
  "files": {
    "main.js": "/static/js/main.abc12345.js",
    "main.css": "/static/css/main.def67890.css"
  },
  "entrypoints": [
    "/static/js/runtime.klm22222.js",
    "/static/js/vendor-react.hij11111.js",
    "/static/js/main.abc12345.js"
  ]
}
```

The logical name in `files` is derived in two steps:

1. Remove hashes in the form `.[8 or more hex chars].`.
2. Remove the `static/js/` or `static/css/` prefix.

The renderer's `BaseRenderer.resolveAssets()` and `ScriptInjector` read this manifest to generate `<link>` and `<script>` tags in HTML. They prefer `entrypoints` to preserve Webpack loading order. Only when the manifest lacks `entrypoints/js/css` do they fall back to extracting assets from `files`, using a stable sort order of runtime, vendor, normal chunks, and main/app.

### `NamiHtmlInjectPlugin`

Source location: `packages/webpack/src/plugins/html-inject-plugin.ts`

`NamiBuilder.enhanceConfig()` injects this plugin only for client builds with CSR routes:

```typescript
const hasCSR = this.config.routes.some(
  route => route.renderMode === RenderMode.CSR
);
```

It generates `dist/client/index.html`. The default mount container ID comes from `DEFAULT_CONTAINER_ID`, namely `nami-root`.

SSR/SSG/ISR HTML is not generated by this plugin.

### `createProgressPlugin`

Source location: `packages/webpack/src/plugins/progress-plugin.ts`

`enhanceConfig()` appends the progress plugin to both client and server configs for build log display.

---

## 10. Overall Manifest `nami-manifest.json`

Source location: `packages/webpack/src/builder.ts`

`generateManifest()` writes at the end of the build:

```text
{outDir}/nami-manifest.json
```

The filename constant comes from `NAMI_MANIFEST_FILENAME`.

Main fields:

| Field | Description |
|------|------|
| `appName` | Application name |
| `generatedAt` | Generation time |
| `routes` | Route path, component, renderMode, data function names, revalidate, fallback |
| `moduleManifest` | Mapping from `route.component` to server page module file |
| `buildInfo.nodeVersion` | Node version |
| `buildInfo.namiVersion` | Framework version |

`moduleManifest` rule:

```text
key   = route.component
value = route.component with leading "./" removed, then ".js" appended
```

For example:

```json
{
  "./pages/Home.tsx": "pages/Home.tsx.js"
}
```

When starting the production server, `packages/cli/src/utils/server-runtime.ts` reads `nami-manifest.json` and passes `moduleManifest` to `ModuleLoader`, which is used by SSR/ISR to resolve page-level data functions.

---

## 11. SSG / ISR Static Generation

Source location: `packages/webpack/src/builder.ts`

Static generation in the current build main path is completed by `NamiBuilder.generateStaticPages()`. It does not run a separate `createSSGConfig()` Webpack compilation.

Flow:

```text
generateStaticPages(routes)
  -> primaryServerBundlePath = {outDir}/server/entry-server.js
  -> staticOutputDir = {outDir}/static
  -> moduleManifest = buildModuleManifest()
  -> serverBundlePath = entry-server.js or first page module fallback
  -> create ModuleLoader
  -> iterate SSG/ISR routes
       -> dynamic routes execute getStaticPaths()
       -> each path executes getStaticProps()
       -> actualPath = route.path with :param replaced
       -> render HTML
       -> write {outDir}/static/{actualPath}/index.html
```

HTML rendering strategy order:

| Priority | Condition | Behavior |
|--------|------|------|
| 1 | `serverBundle.renderToHTML` is a function | Call `renderToHTML(actualPath, props)` |
| 2 | `pageModule.render` is a function | Call `pageModule.render({ path, props })` |
| 3 | `pageModule.default` is a function | `React.createElement(default, props)` then `renderToString()` |
| 4 | None of the above | Generate a minimal HTML shell and inject `window.__NAMI_DATA__` |

Dynamic routes read paths only when `route.path` contains `:` and `getStaticPaths` is declared. If the function is not found, the route is warned and skipped.

### `createSSGConfig()`

Source location: `packages/webpack/src/configs/ssg.config.ts`

`createSSGConfig()` currently only exports a server config variant named `ssg`. The repository's build main path does not call it. When writing docs or troubleshooting build issues, use `NamiBuilder.generateStaticPages()` as the source of truth.

---

## 12. Loaders and Capabilities Not Wired In by Default

Source locations:

- `packages/webpack/src/loaders/page-loader.ts`
- `packages/webpack/src/loaders/data-fetch-loader.ts`
- `packages/webpack/src/rules/typescript.ts`

### `page-loader`

`page-loader` appends the following export to the end of page source:

```typescript
export const __namiPageMeta = {
  renderMode,
  hasGetServerSideProps,
  hasGetStaticProps,
  hasGetStaticPaths,
};
```

Note that the source actually exports the constant `__namiPageMeta`. It does not attach a `HomePage.__namiPageMeta` property to the default component.

### `data-fetch-loader`

In client builds, `data-fetch-loader` replaces:

```typescript
export async function getServerSideProps() { ... }
export async function getStaticProps() { ... }
export async function getStaticPaths() { ... }
```

with:

```typescript
export async function getServerSideProps() { return { props: {} }; }
```

In server builds, if `options.isServer` is true, it returns the source unchanged.

### Default Wiring Status

The current default TypeScript rule only has `ts-loader`; it does not chain `page-loader` or `data-fetch-loader`. These two loaders are package-exported capabilities. If a project needs them, it must add rules itself through `config.webpack.client/server` or a plugin's `modifyWebpackConfig`.

Published packages usually only contain `dist`. External projects should reference loaders through published paths, for example:

```typescript
require.resolve('@nami/webpack/dist/loaders/page-loader')
```

Only use `packages/webpack/src/loaders/*` directly when debugging source inside the monorepo.

### Other Plugins Not Registered by Default

| Plugin | Source | Registered by default | Description |
|------|------|--------------|------|
| `NamiRouteCollectPlugin` | `plugins/route-collect-plugin.ts` | No | Scans the pages directory and writes `routes-manifest.json` |
| `NamiSSRExternalsPlugin` | `plugins/ssr-externals-plugin.ts` | No | Finer-grained externals control |

The default build uses config-based routes and `webpack-node-externals`. Do not describe these non-default plugins as main-path behavior.

---

## 13. CLI Commands and Build Paths

### `nami build`

Source location: `packages/cli/src/commands/build.ts`

```text
loadConfig
  -> NamiBuilder.build('production', { analyze, minimize })
```

`--analyze` appends `BundleAnalyzerPlugin` to client/server configs in `applyWebpackConfigEnhancers()`. `--no-minimize` passes `options.minimize` to the Builder and only affects `minimize` in client optimization.

### `nami generate`

Source location: `packages/cli/src/commands/generate.ts`

```text
filter SSG/ISR routes
  -> builder.build('production', {
       clean: false,
       ssgRoutes: routes.map(route => route.path)
     })
```

It still runs full client/server Webpack compilation, then limits which routes are processed in the SSG phase. It is not "only running the static generation function".

### `nami analyze`

Source location: `packages/cli/src/commands/analyze.ts`

```text
builder.createWebpackConfig(target, 'production', { analyze: true })
  -> webpack(webpackConfig)
```

It generates a Webpack config for a single target and compiles it directly. It does not go through the full `builder.build()` flow, so it does not run parallel dual-task builds, SSG, or `nami-manifest.json` generation.

But it does not completely bypass build context either. `builder.createWebpackConfig()` still first executes `prepareBuildContext()`, so plugin initialization, `modifyRoutes`, and subsequent `modifyWebpackConfig` may still affect the webpack config used for analysis.

`nami analyze` checks both the webpack callback `err` and `stats.hasErrors()`. If there are errors inside compilation, it enters the failure branch and does not continue to say "analysis report generated".

### `nami dev`

Source locations:

- `packages/cli/src/commands/dev.ts`
- `packages/server/src/dev/dev-server.ts`
- `packages/server/src/dev/webpack-dev.ts`

`nami dev` does not go through `NamiBuilder.build()`:

```text
loadConfig
  -> createDevClientConfig()
  -> createDevServerConfig()
  -> createDevServer({
       clientWebpackConfig,
       serverWebpackConfig,
       runtimeProvider: () => resolveServerRuntime({ fresh: true })
     })
```

The development server creates a client compiler and registers:

```text
webpack-dev-middleware
webpack-hot-middleware
```

Then it creates a server compiler watch. In development mode, `runtimeProvider` reads the latest `entry-server.js` on every request, preventing SSR from using stale require cache.

`webpack-dev-middleware` is Express-style middleware. `createWebpackDevMiddleware()` adapts it into Koa middleware. It returns client static assets from the in-memory filesystem and does not write to disk by default.

### `nami start`

Source locations:

- `packages/cli/src/commands/start.ts`
- `packages/cli/src/utils/server-runtime.ts`

`nami start` does not execute Webpack. It only checks whether `config.outDir` exists, then:

```text
resolveServerRuntime({ fresh: false })
  -> read {outDir}/server/entry-server.js
  -> resolve createAppElement / appElementFactory / renderToHTML
  -> read moduleManifest from nami-manifest.json
  -> create ModuleLoader
  -> startServer(config, runtime)
```

---

## 14. Config Extension Order

Source location: `packages/webpack/src/builder.ts`

After each Webpack config is created, it goes through `applyWebpackConfigEnhancers()`:

```text
rawConfig
  -> enhanceConfig(rawConfig, name)
       -> createProgressPlugin
       -> client: NamiManifestPlugin
       -> client and has CSR: NamiHtmlInjectPlugin
  -> if client and options.minimize is boolean, override optimization.minimize
  -> config.webpack.client or config.webpack.server
  -> pluginManager.runWaterfallHook('modifyWebpackConfig', config, { isServer, isDev })
  -> if options.analyze, append BundleAnalyzerPlugin
```

Therefore, a plugin's `modifyWebpackConfig` sees the config after framework built-in plugins have been injected and user `config.webpack.*` has been applied.

---

## 15. Common Misconceptions

### Misconception 1: `createSSGConfig()` is the SSG main path of `nami build`

No. It is currently exported but not called by Builder/CLI. The main path is `generateStaticPages()` reusing the already compiled server bundle.

### Misconception 2: SSG HTML is written under `dist/client`

No. It is currently written to `{outDir}/static/.../index.html`. `dist/client/index.html` is the entry page generated by the CSR HTML plugin.

### Misconception 3: `page-loader` and `data-fetch-loader` are enabled by default

No. The default TS rule only has `ts-loader`. These two loaders need custom Webpack rules to participate.

### Misconception 4: `NamiRouteCollectPlugin` already scans pages routes by default

No. Current default routes come from `config.routes`, and build-time plugins can modify them through `modifyRoutes`.

### Misconception 5: Server externalization comes from `NamiSSRExternalsPlugin`

Not by default. Default `server.config.ts` uses `webpack-node-externals`.

### Misconception 6: `nami generate` only runs static generation and does not rebuild

No. It calls `builder.build('production', { clean: false, ssgRoutes })`, so it still recompiles client/server.

### Misconception 7: `nami analyze` is equivalent to `nami build --analyze`

Not completely. `nami analyze` only creates a config for a single target and directly calls `webpack()`. `nami build --analyze` goes through the full build flow.

---

## Next Steps

- How routes and data functions affect rendering: read [Rendering Modes Internals](./rendering-modes.md)
- How the server reads build artifacts: read [Server and Middleware](./server-and-middleware.md)
- How plugins modify build config: read [Plugin System Internals](./plugin-system.md)
