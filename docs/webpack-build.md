# Webpack 构建系统原理

Nami 的构建系统不是简单地把 React 应用打成一个浏览器 Bundle。它要同时服务 CSR、SSR、SSG、ISR 四种渲染模式，因此需要按路由分析构建目标，生成客户端产物、服务端产物、静态 HTML 和运行时清单。

这一章以 `packages/webpack` 和 `packages/cli` 源码为准，解释 `nami build`、`nami dev`、`nami generate`、`nami analyze`、`nami start` 到底做了什么，以及哪些 loader/plugin 只是导出能力、并没有默认接入。

---

## 1. 源码地图

| 主题 | 源码 |
|------|------|
| Builder 总控 | `packages/webpack/src/builder.ts` |
| 包导出入口 | `packages/webpack/src/index.ts` |
| 基础 Webpack 配置 | `packages/webpack/src/configs/base.config.ts` |
| 客户端配置 | `packages/webpack/src/configs/client.config.ts` |
| 服务端配置 | `packages/webpack/src/configs/server.config.ts` |
| 开发配置封装 | `packages/webpack/src/configs/dev.config.ts` |
| SSG 配置导出 | `packages/webpack/src/configs/ssg.config.ts` |
| TS / 样式 / 资源规则 | `packages/webpack/src/rules/*.ts` |
| 代码分割策略 | `packages/webpack/src/optimization/split-chunks.ts` |
| 资源清单插件 | `packages/webpack/src/plugins/manifest-plugin.ts` |
| CSR HTML 插件 | `packages/webpack/src/plugins/html-inject-plugin.ts` |
| 路由收集插件 | `packages/webpack/src/plugins/route-collect-plugin.ts` |
| SSR externals 插件 | `packages/webpack/src/plugins/ssr-externals-plugin.ts` |
| 页面元信息 loader | `packages/webpack/src/loaders/page-loader.ts` |
| 数据函数剥离 loader | `packages/webpack/src/loaders/data-fetch-loader.ts` |
| CLI build | `packages/cli/src/commands/build.ts` |
| CLI dev | `packages/cli/src/commands/dev.ts` |
| CLI generate | `packages/cli/src/commands/generate.ts` |
| CLI analyze | `packages/cli/src/commands/analyze.ts` |
| CLI start | `packages/cli/src/commands/start.ts` |
| 服务端运行时解析 | `packages/cli/src/utils/server-runtime.ts` |
| 开发服务器 | `packages/server/src/dev/dev-server.ts` |
| webpack-dev-middleware 适配 | `packages/server/src/dev/webpack-dev.ts` |

---

## 2. 为什么需要两套 Bundle

源码位置：

- `packages/shared/src/constants/render-modes.ts`
- `packages/webpack/src/builder.ts`

Nami 会根据路由渲染模式决定构建任务。关键常量是：

```typescript
export const NEEDS_SERVER_BUNDLE = [
  RenderMode.SSR,
  RenderMode.SSG,
  RenderMode.ISR,
];
```

这说明：

| 模式 | Client Bundle | Server Bundle | 静态生成 |
|------|---------------|---------------|----------|
| CSR | 需要 | 不需要 | 不需要 |
| SSR | 需要 | 需要 | 不需要 |
| SSG | 需要 | 需要 | 需要 |
| ISR | 需要 | 需要 | 需要首轮预生成，运行期还要重验证 |

两套 Bundle 的目标不同：

| Bundle | 运行环境 | 主要职责 |
|--------|----------|----------|
| client | 浏览器 | 启动 React、Hydration、客户端路由、加载页面 chunk |
| server | Node.js | SSR/ISR 运行期渲染、SSG 构建期渲染、执行数据函数 |

SSG 运行期可以只返回静态文件，但构建期仍需要 server bundle 来执行页面模块、`getStaticProps`、`getStaticPaths` 或 `renderToHTML`。

---

## 3. `nami build` 总流程

源码位置：

- `packages/cli/src/commands/build.ts`
- `packages/webpack/src/builder.ts`

CLI 入口：

```text
nami build
  -> loadConfig(process.cwd())
  -> import('@nami/webpack').NamiBuilder
  -> new NamiBuilder(config, process.cwd())
  -> builder.build('production', { analyze, minimize })
```

`NamiBuilder.build()` 的真实流程：

```text
build('production')
  -> 如果 options.clean !== false，清空 config.outDir
  -> prepareBuildContext(isDev=false)
       -> 解析 config.plugins
       -> registerPlugins()
       -> runWaterfallHook('modifyRoutes', routes)
       -> 更新 this.config.routes
  -> determineBuildTasks()
       -> 始终加入 client
       -> 如有 SSR/SSG/ISR 路由，加入 server
       -> 如有 SSG/ISR 路由且非 dev，加入 ssg
  -> pluginManager.callHook('buildStart')
  -> 并行执行 client/server Webpack 编译
  -> 如果编译有错误，直接返回失败，不执行 SSG
  -> generateStaticPages(ssgRoutes)
  -> generateManifest()
  -> pluginManager.callHook('buildEnd')
  -> 返回 BuildResult
```

注意：`buildStart` / `buildEnd` 是 `PluginManager.callHook()` 的短名，内部会映射到正式 hook `onBuildStart` / `onBuildEnd`。

### BuildResult

`BuildResult` 包含：

| 字段 | 含义 |
|------|------|
| `success` | 是否成功 |
| `duration` | 总耗时 |
| `errors` | Webpack 和 SSG 错误 |
| `warnings` | Webpack 警告 |
| `stats` | 各构建任务的 Webpack Stats |

SSG 阶段的路由级错误会收集到 `this.ssgErrors`，最后并入 `BuildResult.errors`，这样 CI 能感知部分页面生成失败。

---

## 4. 构建任务判定

源码位置：`packages/webpack/src/builder.ts`

`determineBuildTasks()` 的逻辑：

```text
tasks = []

client:
  始终创建 createClientConfig()

server:
  如果 routes.some(route.renderMode in NEEDS_SERVER_BUNDLE)
    创建 createServerConfig()

ssg:
  ssgRoutes = routes.filter(renderMode === SSG || renderMode === ISR)
  如果 options.ssgRoutes 存在，再按 path 过滤
  如果 ssgRoutes.length > 0 && !isDev
    加入 type='ssg' 任务
```

关键点：

| 事实 | 说明 |
|------|------|
| dev 模式不会加入 `ssg` 任务 | 开发环境不做构建期静态生成 |
| SSG/ISR 都会进入静态生成 | ISR 也会生成首轮静态 HTML |
| `options.ssgRoutes` 只过滤静态生成路由 | client/server Webpack 仍会按整体配置构建 |
| `ssg` 任务没有 Webpack config | 它复用已经编译好的 server bundle |

---

## 5. 产物结构

典型产物：

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
│   └── index.html                 # 仅存在 CSR 路由时由 NamiHtmlInjectPlugin 生成
│
├── server/
│   ├── entry-server.js             # 如果 src/entry-server.* 存在
│   └── pages/xxx.tsx.js            # 页面组件 server entry，对应 route.component
│
├── static/
│   ├── index.html                  # SSG/ISR 生成
│   └── about/index.html
│
└── nami-manifest.json
```

SSG/ISR 静态 HTML 写入的是 `dist/static/.../index.html`，不是 `dist/client/...html`。

---

## 6. Base Config

源码位置：`packages/webpack/src/configs/base.config.ts`

`createBaseConfig()` 是 client 和 server 共用基线：

| 配置 | 行为 |
|------|------|
| `mode` | dev 为 `development`，生产为 `production` |
| `resolve.extensions` | `.tsx`、`.ts`、`.jsx`、`.js`、`.json` |
| `resolve.alias` | `@` 和 `~` 指向 `srcDir` |
| `resolve.modules` | `node_modules` 和项目根 `node_modules` |
| `module.rules` | TypeScript、资源、SVG |
| `module.noParse` | 跳过 `jquery|lodash` |
| `performance` | 生产模式开启资源大小警告 |
| `stats` | dev `minimal`，生产 `normal` |
| `cache` | Webpack 5 filesystem cache |

浏览器端额外禁用 Node 内建模块 fallback：

```typescript
fallback: {
  fs: false,
  path: false,
  crypto: false,
  stream: false,
}
```

生产缓存版本由配置内容生成 8 位 md5，包括 `appName`、`srcDir`、`outDir`、`publicPath`、`defaultRenderMode` 和路由 path。

### TypeScript Rule

源码位置：`packages/webpack/src/rules/typescript.ts`

默认只使用 `ts-loader`：

```typescript
{
  test: /\.(ts|tsx)$/,
  exclude: /node_modules/,
  use: [{ loader: 'ts-loader', options: { transpileOnly: true, ... } }],
}
```

服务端设置 `compilerOptions.module = 'commonjs'`，客户端设置 `module = 'esnext'` 并启用 `jsx: 'react-jsx'`。

默认 TypeScript rule 没有串联 `page-loader` 或 `data-fetch-loader`。

---

## 7. Client Config

源码位置：`packages/webpack/src/configs/client.config.ts`

客户端配置由 `createClientConfig()` 创建。

### 自动生成 `.nami` 文件

调用配置工厂时会生成两个文件：

| 文件 | 作用 |
|------|------|
| `.nami/generated-route-modules.ts` | 路由组件路径到动态 import 工厂的映射 |
| `.nami/generated-core-client-shim.ts` | 浏览器端专用 `@nami/core` 精简入口 |

`generated-route-modules.ts` 导出：

```typescript
export const generatedComponentLoaders = {
  "./pages/home": () => import(/* webpackChunkName: "route-pages-home" */ "..."),
} as Record<string, () => Promise<unknown>>;

export const generatedRouteDefinitions = [
  { path: "/", component: "./pages/home", exact: true },
];
```

`exact` 的值来自 `route.exact === false ? false : true`。

`generated-core-client-shim.ts` 导出：

```typescript
export { PluginManager } from ".../dist/plugin/plugin-manager";
export { NamiDataProvider } from ".../dist/data/data-context";
export { matchPath } from ".../dist/router/path-matcher";
```

目的是避免浏览器 bundle 引入完整 `@nami/core` 入口，把 Node 专属模块一起卷入。

### Entry 和输出

| 项目 | dev | production |
|------|-----|------------|
| entry | `webpack-hot-middleware/client` + `src/entry-client` | `src/entry-client` |
| filename | `static/js/[name].js` | `static/js/[name].[contenthash:8].js` |
| chunkFilename | `static/js/[name].chunk.js` | `static/js/[name].[contenthash:8].chunk.js` |
| publicPath | `config.assets.publicPath` | 同左 |
| clean | `false` | `true` |

### DefinePlugin

客户端注入：

```typescript
process.env.NODE_ENV
process.env.NAMI_RENDER_MODE = "client"
```

以及 `config.env` 中所有 `NAMI_PUBLIC_` 前缀变量。没有该前缀的变量不会进入客户端 bundle。

### 样式和代码分割

生产环境使用 `MiniCssExtractPlugin` 抽取 CSS，开发环境使用 `style-loader` 以支持 HMR。

生产代码分割来自 `createSplitChunksConfig()`：

| cacheGroup | 匹配 | 输出名 |
|------------|------|--------|
| `react` | `react`、`react-dom`、`scheduler` | `vendor-react` |
| `vendor` | 其他 `node_modules` | `vendor` |
| `commons` | 被至少两个 chunk 引用 | `commons` |
| `default` | 默认复用组 | Webpack 默认命名 |

生产还会开启：

```typescript
runtimeChunk: { name: 'runtime' }
moduleIds: 'deterministic'
minimizer: [createTerserPlugin()]
```

---

## 8. Server Config

源码位置：`packages/webpack/src/configs/server.config.ts`

服务端配置由 `createServerConfig()` 创建。

### Entry

服务端入口包含两类：

```typescript
entry: {
  ...(entryServerPath ? { 'entry-server': entryServerPath } : {}),
  ...routeEntries,
}
```

`entry-server` 只有在 `src/entry-server.tsx|ts|jsx|js` 存在时才加入。页面 entry 来自 `config.routes[*].component` 去重后的列表，例如：

```text
route.component = "./pages/Home.tsx"
entry name      = "pages/Home.tsx"
output file     = "pages/Home.tsx.js"
```

这和 `NamiBuilder.buildModuleManifest()` 的规则保持一致。

### 输出和模块格式

| 配置 | 值 |
|------|----|
| `target` | `node` |
| `output.path` | `{outDir}/server` |
| `filename` | `[name].js` |
| `libraryTarget` | `commonjs2` |
| `devtool` | `source-map` |
| `optimization.minimize` | `false` |
| `optimization.splitChunks` | `false` |
| `LimitChunkCountPlugin` | `maxChunks: 1` |

服务端不需要浏览器代码分割，Node 运行时通过 CommonJS 加载产物。

### Externals

默认服务端外部化使用 `webpack-node-externals`：

```typescript
nodeExternals({
  allowlist: [
    /\.css$/,
    /^@nami\//,
  ],
})
```

这会把大多数 `node_modules` 标为运行时 `require`，但保留 CSS 和 `@nami/*` 包给 Webpack 处理。

`NamiSSRExternalsPlugin` 也存在于 `packages/webpack/src/plugins/ssr-externals-plugin.ts`，但默认 `server.config.ts` 没有注册它。不要把默认外部化实现写成这个插件。

---

## 9. 内置 Webpack 插件

### `NamiManifestPlugin`

源码位置：`packages/webpack/src/plugins/manifest-plugin.ts`

`NamiBuilder.enhanceConfig()` 会在 client 构建中注入 `NamiManifestPlugin`，生成：

```text
dist/client/asset-manifest.json
```

格式：

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

`files` 的逻辑名通过两步得到：

1. 去掉 `.[8位hex].` 形式的 hash。
2. 去掉 `static/js/` 或 `static/css/` 前缀。

渲染器的 `BaseRenderer.resolveAssets()` 和 `ScriptInjector` 会读取这份清单，生成 HTML 中的 `<link>` 和 `<script>`。

### `NamiHtmlInjectPlugin`

源码位置：`packages/webpack/src/plugins/html-inject-plugin.ts`

`NamiBuilder.enhanceConfig()` 只在 client 构建且存在 CSR 路由时注入该插件：

```typescript
const hasCSR = this.config.routes.some(
  route => route.renderMode === RenderMode.CSR
);
```

它生成 `dist/client/index.html`，默认挂载容器 ID 来自 `DEFAULT_CONTAINER_ID`，即 `nami-root`。

SSR/SSG/ISR 的 HTML 不靠这个插件生成。

### `createProgressPlugin`

源码位置：`packages/webpack/src/plugins/progress-plugin.ts`

`enhanceConfig()` 会给 client 和 server 都追加进度插件，用于构建日志展示。

---

## 10. 总清单 `nami-manifest.json`

源码位置：`packages/webpack/src/builder.ts`

`generateManifest()` 在构建最后写：

```text
{outDir}/nami-manifest.json
```

文件名常量来自 `NAMI_MANIFEST_FILENAME`。

主要字段：

| 字段 | 说明 |
|------|------|
| `appName` | 应用名 |
| `generatedAt` | 生成时间 |
| `routes` | 路由 path、component、renderMode、数据函数名、revalidate、fallback |
| `moduleManifest` | `route.component` 到 server 页面模块文件的映射 |
| `buildInfo.nodeVersion` | Node 版本 |
| `buildInfo.namiVersion` | 框架版本 |

`moduleManifest` 规则：

```text
key   = route.component
value = route.component 去掉开头 "./" 后追加 ".js"
```

例如：

```json
{
  "./pages/Home.tsx": "pages/Home.tsx.js"
}
```

`packages/cli/src/utils/server-runtime.ts` 启动生产服务器时会读取 `nami-manifest.json`，把 `moduleManifest` 交给 `ModuleLoader`，用于 SSR/ISR 解析页面级数据函数。

---

## 11. SSG / ISR 静态生成

源码位置：`packages/webpack/src/builder.ts`

当前构建主链路的静态生成由 `NamiBuilder.generateStaticPages()` 完成，不是单独运行一套 `createSSGConfig()` Webpack 编译。

流程：

```text
generateStaticPages(routes)
  -> primaryServerBundlePath = {outDir}/server/entry-server.js
  -> staticOutputDir = {outDir}/static
  -> moduleManifest = buildModuleManifest()
  -> serverBundlePath = entry-server.js 或第一个页面模块兜底
  -> 创建 ModuleLoader
  -> 遍历 SSG/ISR 路由
       -> 动态路由执行 getStaticPaths()
       -> 每个 path 执行 getStaticProps()
       -> actualPath = route.path 替换 :param
       -> 渲染 HTML
       -> 写入 {outDir}/static/{actualPath}/index.html
```

渲染 HTML 的策略顺序：

| 优先级 | 条件 | 行为 |
|--------|------|------|
| 1 | `serverBundle.renderToHTML` 是函数 | 调用 `renderToHTML(actualPath, props)` |
| 2 | `pageModule.render` 是函数 | 调用 `pageModule.render({ path, props })` |
| 3 | `pageModule.default` 是函数 | `React.createElement(default, props)` 后 `renderToString()` |
| 4 | 以上都没有 | 生成最小 HTML 壳，注入 `window.__NAMI_DATA__` |

动态路由只有在 `route.path` 包含 `:` 且声明了 `getStaticPaths` 时才读取路径。找不到函数会 warn 并跳过该动态路由。

### `createSSGConfig()`

源码位置：`packages/webpack/src/configs/ssg.config.ts`

`createSSGConfig()` 当前只是导出为 `name: 'ssg'` 的 server 配置变体。仓库内构建主链路没有调用它。写文档或排查构建问题时，应以 `NamiBuilder.generateStaticPages()` 为准。

---

## 12. Loader 与未默认接入能力

源码位置：

- `packages/webpack/src/loaders/page-loader.ts`
- `packages/webpack/src/loaders/data-fetch-loader.ts`
- `packages/webpack/src/rules/typescript.ts`

### `page-loader`

`page-loader` 会在页面源码末尾追加：

```typescript
export const __namiPageMeta = {
  renderMode,
  hasGetServerSideProps,
  hasGetStaticProps,
  hasGetStaticPaths,
};
```

注意源码实际是导出常量 `__namiPageMeta`，不是给默认组件挂 `HomePage.__namiPageMeta` 属性。

### `data-fetch-loader`

`data-fetch-loader` 在客户端构建时会把：

```typescript
export async function getServerSideProps() { ... }
export async function getStaticProps() { ... }
export async function getStaticPaths() { ... }
```

替换成：

```typescript
export async function getServerSideProps() { return { props: {} }; }
```

服务端构建时如果 `options.isServer` 为 true，则原样返回源码。

### 默认接入状态

当前默认 TypeScript rule 只有 `ts-loader`，没有串联 `page-loader` 和 `data-fetch-loader`。这两个 loader 是包导出的能力，若项目要使用，需要通过 `config.webpack.client/server` 或插件的 `modifyWebpackConfig` 自行加入 rule。

发布包通常只包含 `dist`，外部项目引用 loader 时应使用发布后的路径，例如：

```typescript
require.resolve('@nami/webpack/dist/loaders/page-loader')
```

在 monorepo 内部调试源码时才直接看 `packages/webpack/src/loaders/*`。

### 其他未默认注册的插件

| 插件 | 源码 | 默认是否注册 | 说明 |
|------|------|--------------|------|
| `NamiRouteCollectPlugin` | `plugins/route-collect-plugin.ts` | 否 | 扫描 pages 目录并写 `routes-manifest.json` |
| `NamiSSRExternalsPlugin` | `plugins/ssr-externals-plugin.ts` | 否 | 更细粒度 externals 控制 |

默认构建使用配置式路由和 `webpack-node-externals`，不要把这些未默认接入的插件写成主链路行为。

---

## 13. CLI 命令与构建链路

### `nami build`

源码位置：`packages/cli/src/commands/build.ts`

```text
loadConfig
  -> NamiBuilder.build('production', { analyze, minimize })
```

`--analyze` 会在 `applyWebpackConfigEnhancers()` 中为 client/server 配置追加 `BundleAnalyzerPlugin`。`--no-minimize` 会把 `options.minimize` 传给 Builder，只影响 client optimization 中的 `minimize`。

### `nami generate`

源码位置：`packages/cli/src/commands/generate.ts`

```text
筛选 SSG/ISR 路由
  -> builder.build('production', {
       clean: false,
       ssgRoutes: routes.map(route => route.path)
     })
```

它仍会执行完整的 client/server Webpack 编译，再限制 SSG 阶段处理的路由。它不是“只跑静态生成函数”。

### `nami analyze`

源码位置：`packages/cli/src/commands/analyze.ts`

```text
builder.createWebpackConfig(target, 'production', { analyze: true })
  -> webpack(webpackConfig)
```

它生成单个目标的 Webpack 配置并直接编译，不走 `builder.build()` 的完整流程，因此不会执行双任务并行、SSG 和 `nami-manifest.json` 生成。

### `nami dev`

源码位置：

- `packages/cli/src/commands/dev.ts`
- `packages/server/src/dev/dev-server.ts`
- `packages/server/src/dev/webpack-dev.ts`

`nami dev` 不走 `NamiBuilder.build()`：

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

开发服务器创建 client compiler，注册：

```text
webpack-dev-middleware
webpack-hot-middleware
```

再创建 server compiler watch。开发模式通过 `runtimeProvider` 每次请求读取最新 `entry-server.js`，避免 SSR 使用旧 require 缓存。

`webpack-dev-middleware` 是 Express 风格中间件，`createWebpackDevMiddleware()` 会适配成 Koa 中间件。它从内存文件系统返回 client 静态资源，默认不写磁盘。

### `nami start`

源码位置：

- `packages/cli/src/commands/start.ts`
- `packages/cli/src/utils/server-runtime.ts`

`nami start` 不执行 Webpack。它只检查 `config.outDir` 是否存在，然后：

```text
resolveServerRuntime({ fresh: false })
  -> 读取 {outDir}/server/entry-server.js
  -> 解析 createAppElement / appElementFactory / renderToHTML
  -> 读取 nami-manifest.json 的 moduleManifest
  -> 创建 ModuleLoader
  -> startServer(config, runtime)
```

---

## 14. 配置扩展顺序

源码位置：`packages/webpack/src/builder.ts`

每份 Webpack 配置创建后会经过 `applyWebpackConfigEnhancers()`：

```text
rawConfig
  -> enhanceConfig(rawConfig, name)
       -> createProgressPlugin
       -> client: NamiManifestPlugin
       -> client 且有 CSR: NamiHtmlInjectPlugin
  -> 如果 client 且 options.minimize 是 boolean，覆盖 optimization.minimize
  -> config.webpack.client 或 config.webpack.server
  -> pluginManager.runWaterfallHook('modifyWebpackConfig', config, { isServer, isDev })
  -> 如果 options.analyze，追加 BundleAnalyzerPlugin
```

因此插件的 `modifyWebpackConfig` 看到的是已经注入框架内置插件、应用用户 `config.webpack.*` 后的配置。

---

## 15. 常见误区

### 误区一：`createSSGConfig()` 是 `nami build` 的 SSG 主链路

不是。它当前导出但未被 Builder/CLI 调用。主链路是 `generateStaticPages()` 复用已编译 server bundle。

### 误区二：SSG HTML 写在 `dist/client`

不是。当前写入 `{outDir}/static/.../index.html`。`dist/client/index.html` 是 CSR HTML 插件生成的入口页。

### 误区三：`page-loader` 和 `data-fetch-loader` 默认生效

不是。默认 TS rule 只有 `ts-loader`。这两个 loader 需要自定义 Webpack rule 才会参与。

### 误区四：`NamiRouteCollectPlugin` 已经默认扫描 pages 路由

不是。当前默认路由来自 `config.routes`，构建期可通过 `modifyRoutes` 修改。

### 误区五：服务端外部化来自 `NamiSSRExternalsPlugin`

不是默认行为。默认 `server.config.ts` 使用 `webpack-node-externals`。

### 误区六：`nami generate` 只跑静态生成，不重新构建

不是。它调用 `builder.build('production', { clean: false, ssgRoutes })`，仍会重新编译 client/server。

### 误区七：`nami analyze` 等同于 `nami build --analyze`

不完全等同。`nami analyze` 只创建单个目标配置并直接调用 `webpack()`；`nami build --analyze` 走完整 build 流程。

---

## 下一步

- 路由和数据函数如何影响渲染：阅读 [渲染模式原理](./rendering-modes.md)
- 服务端如何读取构建产物：阅读 [服务器与中间件](./server-and-middleware.md)
- 插件如何修改构建配置：阅读 [插件系统原理](./plugin-system.md)
