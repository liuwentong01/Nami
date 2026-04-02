# 构建系统

Nami 使用 Webpack 5 构建客户端和服务端产物。与普通前端项目只需构建客户端代码不同，Nami 需要同时构建**两套 Bundle**：浏览器端的和 Node.js 端的。本文档讲解构建流程、配置工厂、自定义 Loader/Plugin 和优化策略。

> **为什么需要两套 Bundle？** 服务端渲染（SSR）需要在 Node.js 中执行 React 组件生成 HTML。但服务端的代码和浏览器端有不同的需求：服务端不需要代码分割，不需要处理 CSS 为真实文件，但需要保留 `getServerSideProps` 等数据预取函数。客户端则需要代码分割、CSS 提取、Tree-shaking 等优化。因此两套 Bundle 各有专属的 Webpack 配置。

---

## 1. 构建总览

```
nami build
    │
    ▼
NamiBuilder.build('production')
    │
    ├── 1. 清理 dist/
    │
    ├── 2. 插件修改路由
    │      pluginManager.runWaterfallHook('modifyRoutes', routes)
    │
    ├── 3. 分析路由 → 决定构建任务
    │      ┌─────────────┬──────────────────────┐
    │      │ 路由渲染模式  │ 需要的构建目标         │
    │      ├─────────────┼──────────────────────┤
    │      │ CSR         │ client               │
    │      │ SSR / ISR   │ client + server      │
    │      │ SSG         │ client + server + ssg│
    │      └─────────────┴──────────────────────┘
    │
    ├── 4. 生成代码（.nami/ 目录）
    │      ├── generated-route-modules.ts
    │      └── generated-core-client-shim.ts
    │
    ├── 5. 创建 Webpack 配置
    │      ├── createBaseConfig()     ← 共享基线
    │      ├── createClientConfig()   ← 浏览器端
    │      ├── createServerConfig()   ← Node 端
    │      └── createSSGConfig()      ← SSG（基于 server）
    │
    ├── 6. 插件修改 Webpack 配置
    │      pluginManager.runWaterfallHook('modifyWebpackConfig', config)
    │
    ├── 7. 并行执行 webpack 编译
    │
    ├── 8. SSG 静态页面生成
    │      SSGRenderer.generateStatic(routes)
    │
    └── 9. 写入 nami-manifest.json
```

## 2. 构建产物结构

```
dist/
├── client/                        # 浏览器端产物
│   ├── static/
│   │   ├── js/
│   │   │   ├── main.[hash].js     # 应用入口
│   │   │   ├── vendor.[hash].js   # React/ReactDOM 等
│   │   │   ├── commons.[hash].js  # 公共模块
│   │   │   └── runtime.[hash].js  # Webpack Runtime
│   │   ├── css/
│   │   │   └── main.[hash].css    # 提取的 CSS
│   │   ├── media/                 # 图片/字体等
│   │   └── svg/                   # SVG 文件
│   │
│   ├── asset-manifest.json        # 逻辑名 → URL 映射
│   ├── about.html                 # SSG 生成的页面
│   └── index.html                 # CSR 入口页（如有）
│
├── server/                        # 服务端产物
│   ├── entry-server.js            # 服务端入口
│   └── [page].js                  # 页面级 chunk
│
└── nami-manifest.json             # 路由 → 渲染模式映射
```

### asset-manifest.json

```json
{
  "files": {
    "main.js": "/static/js/main.abc123.js",
    "main.css": "/static/css/main.def456.css",
    "vendor.js": "/static/js/vendor.ghi789.js",
    "runtime.js": "/static/js/runtime.jkl012.js"
  },
  "entrypoints": [
    "/static/js/runtime.jkl012.js",
    "/static/js/vendor.ghi789.js",
    "/static/css/main.def456.css",
    "/static/js/main.abc123.js"
  ]
}
```

渲染器的 `ScriptInjector` 读取此文件生成正确的 `<script>` 和 `<link>` 标签。

## 3. 配置工厂详解

### 3.1 Base Config（共享基线）

```typescript
createBaseConfig({
  config: NamiConfig,
  isServer: boolean,
  isDev: boolean,
  target: 'client' | 'server' | 'ssg',
})
```

提供：
- **TypeScript 规则**：`ts-loader`，客户端 `module: esnext`，服务端 `module: commonjs`
- **Asset 规则**：Webpack 5 asset modules（图片/字体/音视频）
- **SVG 规则**：`?url` 作为资源，默认走 `@svgr/webpack`
- **Resolve**：`@` → `srcDir`，`~` → `srcDir`
- **缓存**：`filesystem` 缓存，dev/prod 分目录，prod 使用配置哈希作为 cache version

### 3.2 Client Config（浏览器端）

```typescript
createClientConfig({
  config: NamiConfig,
  isDev: boolean,
})
```

在 Base 基础上增加：

- **入口**：`src/entry-client.tsx`
- **代码生成**：
  - `.nami/generated-route-modules.ts` — 路由组件的动态 import 映射
  - `.nami/generated-core-client-shim.ts` — 精简版 `@nami/core`
- **DefinePlugin**：注入 `NAMI_PUBLIC_*` 环境变量
- **CSS 处理**：PostCSS + `MiniCssExtractPlugin`（生产）/ `style-loader`（开发）
- **代码分割**：
  ```
  splitChunks:
    react-vendor: react + react-dom + react-router-dom
    vendor: node_modules 中 > 10KB 的模块
    commons: 被 2+ chunk 引用的公共模块
  ```
- **Terser**：去除 `console.log`/`console.debug`/`console.warn`
- **HMR**：开发模式下注入 `webpack-hot-middleware/client` 入口

### 3.3 Server Config（Node 端）

```typescript
createServerConfig({
  config: NamiConfig,
  isDev: boolean,
})
```

特殊处理：
- **Target**：`node`
- **入口**：`entry-server` + 各页面组件
- **Output**：`commonjs2` 模块格式
- **Externals**：`webpack-node-externals`（allowlist `@nami/*` 和 `.css`）
- **CSS**：`asset/source` 类型（服务端不需要真正的 CSS 文件）
- **LimitChunkCountPlugin**：限制 chunk 数量为 1（Server Bundle 不做代码分割）

### 3.4 SSG Config

在 Server Config 基础上仅修改 `name: 'ssg'`。实际静态生成由 `NamiBuilder.generateStaticPages` 执行，不依赖 Webpack 的 SSG 专用逻辑。

## 4. 自定义 Loader

### page-loader

**作用**：在页面源码末尾注入元数据导出。

```typescript
// 输入
export default function Home() { ... }
export async function getServerSideProps() { ... }

// 输出（追加）
export const __namiPageMeta = {
  hasGetServerSideProps: true,
  hasGetStaticProps: false,
  hasGetStaticPaths: false,
};
```

这让框架在编译期就能知道哪些页面需要服务端数据预取，用于优化构建决策。

### data-fetch-loader

**作用**：在**客户端构建**中将服务端数据预取函数替换为空实现。

```typescript
// 服务端构建：保留原始实现
export async function getServerSideProps(ctx) {
  const data = await db.query('...');  // 数据库查询
  return { props: { data } };
}

// 客户端构建：被替换为
export async function getServerSideProps() { return { props: {} }; }
export async function getStaticProps() { return { props: {} }; }
export async function getStaticPaths() { return { paths: [], fallback: false }; }
```

**安全意义**：防止数据库连接字符串、API 密钥等敏感信息泄露到浏览器 Bundle 中。

## 5. 自定义 Plugin

### NamiManifestPlugin

**作用**：在 `emit` 阶段生成 `asset-manifest.json`。

```typescript
// 输出示例
{
  "files": {
    "main.js": "/static/js/main.abc123.js",
    "main.css": "/static/css/main.def456.css"
  },
  "entrypoints": [
    "/static/js/runtime.jkl012.js",
    "/static/js/vendor.ghi789.js",
    "/static/css/main.def456.css",
    "/static/js/main.abc123.js"
  ]
}
```

### NamiHtmlInjectPlugin

**作用**：为 CSR 路由生成 `index.html`。从 entrypoint 收集 JS/CSS，生成包含 `<div id="nami-root"></div>` 和资源引用的 HTML 文件。

### NamiRouteCollectPlugin

**作用**：约定式路由扫描。扫描 `pagesDir` 目录自动生成路由配置（`routes-manifest.json`）。与 `nami.config.ts` 中的显式路由配置互补。

### NamiSSRExternalsPlugin

**作用**：精细化 Server Bundle externals 控制。相对路径打包，其余 `commonjs ${request}`。与 `webpack-node-externals` 互补。

## 6. 代码生成

构建时会在 `.nami/` 目录自动生成两个关键文件：

### generated-route-modules.ts

```typescript
// 自动生成 — 请勿手动修改
export const routeComponentLoaders = {
  './pages/home': () => import(/* webpackChunkName: "page-home" */ '../src/pages/home'),
  './pages/about': () => import(/* webpackChunkName: "page-about" */ '../src/pages/about'),
  './pages/product': () => import(/* webpackChunkName: "page-product" */ '../src/pages/product'),
};

export const routeDefinitions = [
  { path: '/', componentKey: './pages/home', renderMode: 'ssr' },
  { path: '/about', componentKey: './pages/about', renderMode: 'ssg' },
  { path: '/products/:slug', componentKey: './pages/product', renderMode: 'isr' },
];
```

**作用**：让 Webpack 的静态分析能识别动态 import，生成正确的 chunk 分割。`@nami/client` 的 `NamiRouter` 读取此映射实现按路由代码分割。

### generated-core-client-shim.ts

```typescript
// 只导出客户端需要的 @nami/core 模块
export { PluginManager } from '@nami/core';
export { NamiDataProvider } from '@nami/core';
export { matchPath } from '@nami/core';
```

**作用**：避免客户端 Bundle 包含整个 `@nami/core`（含渲染器、配置加载等服务端代码），通过 Webpack 别名 `@nami/core-client-shim` 映射到此文件。

## 7. 代码分割策略

```typescript
// packages/webpack/src/optimization/split-chunks.ts
cacheGroups: {
  'react-vendor': {
    test: /[\\/]node_modules[\\/](react|react-dom|react-router-dom|scheduler)/,
    name: 'react-vendor',
    chunks: 'all',
    priority: 30,
  },
  vendor: {
    test: /[\\/]node_modules[\\/]/,
    name: 'vendor',
    chunks: 'all',
    priority: 20,
    minSize: 10000,
  },
  commons: {
    minChunks: 2,
    name: 'commons',
    chunks: 'all',
    priority: 10,
  },
}
```

**分层策略**：
1. **React vendor**：React 全家桶单独一个 chunk，更新频率低，长期缓存
2. **Vendor**：其他 node_modules 依赖
3. **Commons**：被多个页面引用的公共业务代码
4. **Page chunks**：每个路由组件独立 chunk，按需加载

## 8. 用户自定义 Webpack 配置

### 方式一：nami.config.ts 中配置

```typescript
export default defineConfig({
  webpack: {
    client: (config) => {
      config.resolve.alias['@utils'] = path.resolve('src/utils');
      return config;
    },
    server: (config) => {
      // 修改服务端配置
      return config;
    },
  },
});
```

### 方式二：通过插件

```typescript
class MyBuildPlugin implements NamiPlugin {
  name = 'my-build-plugin';
  setup(api) {
    api.modifyWebpackConfig((config, { isServer, isDev }) => {
      if (!isServer && !isDev) {
        // 生产客户端构建添加 Bundle Analyzer
        const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
        config.plugins.push(new BundleAnalyzerPlugin());
      }
      return config;
    });
  }
}
```

## 9. 构建缓存

Webpack 5 的 `filesystem` 缓存加速增量构建：

```typescript
cache: {
  type: 'filesystem',
  cacheDirectory: path.join(cacheDir, isDev ? 'dev' : 'prod'),
  version: createContentHash(config), // 配置变化时自动失效
}
```

`createContentHash(config)` 将配置序列化并计算哈希，确保配置变化后缓存自动失效。

## 10. 包分析

```bash
nami analyze
```

使用 `webpack-bundle-analyzer` 生成可视化报告，帮助识别：
- 过大的依赖
- 重复打包的模块
- 代码分割是否合理

## 11. 常见问题排查

### 构建后 SSR 报 "Cannot find module 'xxx'"

**原因**：该模块未被 `NamiSSRExternalsPlugin` 的白名单包含，被标记为 external，但运行时环境中未安装。

**解决**：确认该模块在生产依赖中（`dependencies` 而非 `devDependencies`），或将其加入白名单使其被打包进 Server Bundle。

### CSS 在 SSR 渲染时报错

**原因**：Server Config 将 CSS 处理为 `asset/source` 类型（返回 CSS 文本字符串），如果代码中 `import './style.css'` 后当作模块使用可能不符合预期。

**解决**：CSS 导入在服务端是安全的（不会报错），但返回的是 CSS 源码字符串。确保不要在服务端代码中把 CSS 导入当作类名映射使用（CSS Modules 需要额外配置）。

### 增量构建缓存失效

**原因**：Webpack 5 的 filesystem 缓存通过 `createContentHash(config)` 计算 cache version。修改 `nami.config.ts` 中的路由、渲染模式等配置后，hash 值变化，缓存自动失效。

**解决**：这是预期行为。如果想手动清除缓存，删除 `node_modules/.cache/webpack/` 目录。

### Bundle 体积过大

使用 `nami analyze` 生成可视化报告，常见原因：
1. **整个 lodash 被打包**：改用 `lodash-es` 或按需导入 `lodash/get`
2. **moment.js locale 全量引入**：使用 `IgnorePlugin` 或改用 `dayjs`
3. **图片未优化**：大图片应使用 CDN URL 而非本地 import

---

## 下一步

- 想了解错误处理和降级？→ [错误处理与降级](./error-and-degradation.md)
- 想了解架构全景？→ [架构设计](./architecture.md)
