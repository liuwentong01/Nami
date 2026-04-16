# 构建系统（7 题）

---

## 题目 48：Nami 为什么需要同时构建两套 Bundle？Client Bundle 和 Server Bundle 有什么区别？⭐⭐⭐

**答案：**

### 为什么需要两套 Bundle？

SSR 需要在 Node.js 中执行 React 组件生成 HTML。但服务端代码和浏览器端代码有截然不同的需求：

| 维度 | Client Bundle | Server Bundle |
|------|---------------|---------------|
| 运行环境 | 浏览器 | Node.js |
| 模块格式 | ESM（Webpack 打包） | CommonJS（`module.exports`） |
| 代码分割 | 按路由分割，懒加载 | 不分割（`LimitChunkCountPlugin: 1`） |
| CSS 处理 | 提取为独立 `.css` 文件 | `asset/source`（返回 CSS 字符串） |
| Tree-shaking | 需要（减小 Bundle 体积） | 不需要（体积不重要, TODO 为什么体积不重要?） |
| Externals | 无（所有依赖打包进 Bundle） | `webpack-node-externals`（node_modules 运行时 require） |
| 数据预取函数 | 被替换为空实现（安全） | 保留原始实现 |
| 目标 | `target: 'web'` | `target: 'node'` |

### Server Bundle 为什么不做代码分割？

浏览器中代码分割是为了减少首次加载的 JS 体积。服务端不存在"下载"问题——所有代码都在本地文件系统中。单一 chunk 更简单，也避免了 Node.js 中动态 import 的复杂性。

```typescript
// Server Config
plugins: [
  new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })
]
```

### Server Bundle 的 CSS 处理

```typescript
// 服务端不需要真正的 CSS 文件 TODO 我没懂这里的含义，服务端不需要真正的 CSS 文件，那真正打包成server bundle是怎么处理的，和客户端有什么不同，给我直观的展示区别
{
  test: /\.css$/,
  type: 'asset/source'  // 返回 CSS 源码字符串
}
```

服务端渲染时不需要注入 CSS（CSS 通过 Client Bundle 的 `<link>` 标签加载）。将 CSS import 处理为字符串，确保 `import './style.css'` 不会报错。

### 构建产物
```
dist/
├── client/                    # 浏览器端
│   ├── static/js/
│   │   ├── main.[hash].js     # 应用入口
│   │   ├── vendor.[hash].js   # React/ReactDOM
│   │   └── page-*.chunk.js    # 路由级 chunk
│   ├── static/css/
│   │   └── main.[hash].css    # 提取的 CSS
│   └── asset-manifest.json    # 文件名映射
│
└── server/                    # 服务端 TODO 上面说服务端会打包成单个文件，如图似乎是两个文件？ entry-server.js + [page].js  给我解释下
    ├── entry-server.js        # 单一入口文件
    └── [page].js              # 页面级组件
```

**源码参考：**
- `packages/webpack/src/config/client.config.ts`
- `packages/webpack/src/config/server.config.ts`

---

## 题目 49：data-fetch-loader 的作用是什么？如果没有它会有什么安全问题？⭐⭐⭐⭐

**答案：**

### 作用

data-fetch-loader 在**客户端构建**时，将 `getServerSideProps`、`getStaticProps`、`getStaticPaths` 替换为空实现： TODO 那如果CSR场景下怎么办，或者SSR渲染失败了降级为CSR，不是无法获取到数据了吗

```typescript
// 原始代码（服务端 + 客户端共用同一份源码）
export async function getServerSideProps(ctx) {
  const data = await prisma.product.findMany({
    where: { active: true }
  });
  return {
    props: { products: data },
  };
}

// data-fetch-loader 在客户端构建中的输出
export async function getServerSideProps() {
  return { props: {} };  // 空实现
}
```

### 如果没有它会怎样？

#### 安全问题 1：敏感信息泄露

```typescript
export async function getServerSideProps() {
  const data = await fetch('https://internal-api.company.com/secret', {
    headers: { 'Authorization': 'Bearer sk_internal_xxxxx' }
  });
  // ...
}
```

没有 loader → 上面的代码会被打包到客户端 JS → 用户在浏览器 DevTools 中可以看到：
- 内部 API 地址
- API 密钥
- 数据库连接字符串

#### 安全问题 2：Node.js 模块在浏览器中报错

```typescript
import { PrismaClient } from '@prisma/client'; // Node.js only
import fs from 'fs'; // Node.js built-in

export async function getServerSideProps() {
  const client = new PrismaClient();
  // ...
}
```

没有 loader → Webpack 尝试将 `@prisma/client` 和 `fs` 打包到客户端 Bundle → 构建报错或运行时报错。

### 实现原理

```typescript
// packages/webpack/src/loaders/data-fetch-loader.ts
module.exports = function dataFetchLoader(source: string) {
  // 只在客户端构建中生效
  if (this.query.isServer) return source;

  // 用正则匹配并替换数据预取函数
  return source
    .replace(
      /export\s+async\s+function\s+getServerSideProps[\s\S]*?\n\}/,
      'export async function getServerSideProps() { return { props: {} }; }'
    )
    .replace(
      /export\s+async\s+function\s+getStaticProps[\s\S]*?\n\}/,
      'export async function getStaticProps() { return { props: {} }; }'
    )
    .replace(
      /export\s+async\s+function\s+getStaticPaths[\s\S]*?\n\}/,
      'export async function getStaticPaths() { return { paths: [], fallback: false }; }'
    );
};
```

**为什么保留空的 export 而不是完全删除？**

客户端的 `page-loader` 需要检查 `__namiPageMeta.hasGetServerSideProps`。如果完全删除，元数据检测逻辑会失效。空实现既安全又兼容。

**源码参考：**
- `packages/webpack/src/loaders/data-fetch-loader.ts`

---

## 题目 50：page-loader 注入的 __namiPageMeta 有什么用途？⭐⭐⭐

**答案：**

### 注入内容

page-loader 在每个页面组件源码末尾追加一段元数据导出：

```typescript
// 原始页面组件
export default function ProductPage({ product }) { ... }
export async function getServerSideProps(ctx) { ... }

// page-loader 追加
export const __namiPageMeta = {
  hasGetServerSideProps: true,
  hasGetStaticProps: false,
  hasGetStaticPaths: false,
};
```

### 用途

#### 1. 构建时路由分析

`NamiBuilder` 在构建前需要知道每个页面使用了哪些数据预取函数，以决定构建策略： TODO 配置的时候不是配置了SSR，CSR等渲染方式吗，为什么要根据这些方法来识别渲染方式呢

```
有 getServerSideProps → 需要 Server Bundle
有 getStaticProps     → 需要 Server Bundle + SSG 生成
无数据预取函数         → 纯 CSR，只需 Client Bundle
```

#### 2. 优化构建决策

如果一个页面没有任何数据预取函数，构建系统可以跳过该页面的服务端编译，减少构建时间和产物体积。

#### 3. 运行时渲染模式验证

在开发模式下，如果路由配置为 SSR 但页面没有 `getServerSideProps`，可以发出警告：

```
Warning: Route /products/:id is configured as SSR but page has no getServerSideProps.
Consider using CSR mode or adding data fetching.
```

### 检测逻辑

```typescript
// page-loader 的检测方式
function detectDataFetchFunctions(source: string) {
  return {
    hasGetServerSideProps: /export\s+async\s+function\s+getServerSideProps/.test(source),
    hasGetStaticProps: /export\s+async\s+function\s+getStaticProps/.test(source),
    hasGetStaticPaths: /export\s+async\s+function\s+getStaticPaths/.test(source),
  };
}
```

**源码参考：**
- `packages/webpack/src/loaders/page-loader.ts`

---

## 题目 51：Nami 的代码分割策略是怎样的？为什么要把 React 单独分一个 chunk？⭐⭐⭐

**答案：**

### 分层策略

```typescript
// packages/webpack/src/optimization/split-chunks.ts
cacheGroups: {
  'react-vendor': {
    test: /[\\/]node_modules[\\/](react|react-dom|react-router-dom|scheduler)/,
    name: 'react-vendor',
    chunks: 'all',
    priority: 30,        // 最高优先级
  },
  vendor: {
    test: /[\\/]node_modules[\\/]/,
    name: 'vendor',
    chunks: 'all',
    priority: 20,
    minSize: 10000,      // 只分离 >10KB 的依赖
  },
  commons: {
    minChunks: 2,        // 被 2+ chunk 引用
    name: 'commons',
    chunks: 'all',
    priority: 10,
  },
}
```

### 四层 chunk 结构

```
1. runtime.[hash].js       — Webpack 运行时代码（~2KB）
2. react-vendor.[hash].js  — React 全家桶（~140KB gzipped）
3. vendor.[hash].js        — 其他 node_modules 依赖
4. commons.[hash].js       — 被多页面共享的业务代码
5. page-*.[hash].js        — 每个路由独立的 chunk
```

### 为什么 React 单独一个 chunk？

**长期缓存优化：**

React 的版本在项目中很少变化。把它单独分出来意味着：

1. 更新业务代码时，`react-vendor.[hash].js` 的 hash 不变 → 浏览器缓存继续有效
2. 更新其他第三方依赖时，`react-vendor.[hash].js` 也不变
3. 只有升级 React 版本时，这个 chunk 才需要重新下载

**量化收益：**

假设 React 体积 140KB（gzipped），用户每天访问，如果 React 和其他 vendor 混在一起：
- 每次更新任何 npm 依赖 → 用户重新下载 140KB + 其他依赖
- 单独分离 → 用户只下载更新的 vendor chunk，React chunk 从缓存读取

### Runtime Chunk

```typescript
runtimeChunk: 'single' // Webpack 运行时单独分离
```

Webpack 的运行时（模块加载器）在每次构建后都会变化（包含模块 ID 映射）。单独分离确保它不污染业务代码 chunk 的 hash。

**源码参考：**
- `packages/webpack/src/config/client.config.ts` — splitChunks 配置

---

## 题目 52：asset-manifest.json 的作用是什么？SSR 渲染时如何使用它？⭐⭐⭐

**答案：**

### 内容

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

### 为什么需要它？

构建产物的文件名包含 content hash（如 `main.abc123.js`）。这个 hash 在每次构建后可能变化。SSR 渲染器在生成 HTML 时需要知道确切的文件名来插入 `<script>` 和 `<link>` 标签。

**如果没有 manifest：**
```html
<!-- 硬编码的路径，每次构建后手动更新？ -->
<script src="/static/js/main.js"></script>
<!-- 这个文件不存在，因为实际文件名是 main.abc123.js -->
```

**有了 manifest：**
```typescript
// BaseRenderer.resolveAssets()
const manifest = require('./asset-manifest.json');
const scripts = manifest.entrypoints.filter(f => f.endsWith('.js'));
const styles = manifest.entrypoints.filter(f => f.endsWith('.css'));

// 生成正确的 HTML
scripts.forEach(src => html += `<script src="${src}"></script>`);
styles.forEach(href => html += `<link rel="stylesheet" href="${href}">`);
```

### entrypoints 的顺序

`entrypoints` 数组的顺序很重要：runtime → vendor → css → main。这确保：
1. Runtime 最先加载（其他 chunk 依赖它）
2. Vendor 在业务代码之前加载（被业务代码 import）
3. CSS 尽早加载（减少样式闪烁）
4. Main 最后加载（依赖以上所有）

### 降级场景

如果 manifest 文件不存在（如开发模式），BaseRenderer 回退到约定路径：
```typescript
resolveAssets() {
  if (this.assetManifest) {
    return this.assetManifest.entrypoints; // 生产模式
  }
  return ['/static/js/main.js', '/static/css/main.css']; // 开发模式约定路径
}
```

**源码参考：**
- `packages/webpack/src/plugins/manifest-plugin.ts` — NamiManifestPlugin
- `packages/core/src/renderer/base-renderer.ts` — resolveAssets()

---

## 题目 53：Webpack 5 的 filesystem 缓存在 Nami 中是如何配置的？什么时候缓存会失效？⭐⭐⭐

**答案：**

### 配置

```typescript
// packages/webpack/src/config/base.config.ts
cache: {
  type: 'filesystem',
  cacheDirectory: path.join(cacheDir, isDev ? 'dev' : 'prod'),
  version: createContentHash(config),
}
```

### 工作原理

Webpack 5 的 filesystem cache 将编译结果缓存到磁盘：
- 第一次构建：完整编译，写入缓存
- 后续构建：读取缓存，只重新编译变化的模块
- 增量构建速度提升通常在 50%~90%

### 缓存失效的条件

#### 1. 配置变化（自动失效）

```typescript
function createContentHash(config: NamiConfig): string {
  const configStr = JSON.stringify({
    routes: config.routes,
    renderMode: config.defaultRenderMode,
    plugins: config.plugins?.map(p => p.name),
    // ... 其他影响构建的配置
  });
  return crypto.createHash('md5').update(configStr).digest('hex');
}
```

配置变化 → hash 变化 → `version` 变化 → Webpack 认为缓存无效 → 完整重建。

#### 2. Webpack 版本升级

Webpack 升级后缓存格式可能不兼容，自动失效。

#### 3. 手动清除

```bash
rm -rf node_modules/.cache/webpack/
```

#### 4. dev/prod 隔离

```typescript
cacheDirectory: path.join(cacheDir, isDev ? 'dev' : 'prod')
```

开发模式和生产模式使用不同的缓存目录，互不干扰。因为两者的配置差异很大（如 devtool、optimization），复用缓存反而可能导致问题。

### 为什么用 MD5 而不是直接比较配置？

MD5 生成固定长度的字符串（32 字符），适合作为 `version` 字段。直接比较配置对象需要深度比较，且可能包含函数等不可序列化的值。

**源码参考：**
- `packages/webpack/src/config/base.config.ts` — cache 配置
- `packages/webpack/src/utils/hash.ts` — createContentHash()

---

## 题目 54：NamiSSRExternalsPlugin 的作用是什么？白名单机制如何工作？⭐⭐⭐

**答案：**

### 问题

Server Bundle 的 externals 配置决定了哪些模块打包进 Bundle，哪些在运行时 `require()`。

默认的 `webpack-node-externals` 把所有 `node_modules` 都外部化。但有些模块必须打包：
- `@nami/*` 包：需要经过 Webpack 的 alias、loader 处理
- CSS 文件：需要经过 `asset/source` loader 处理
- 包含 Webpack 别名的导入：运行时 require 无法解析别名

### NamiSSRExternalsPlugin 的作用

提供更精细的 externals 控制，通过白名单决定哪些模块打包：

```typescript
// packages/webpack/src/plugins/ssr-externals-plugin.ts
class NamiSSRExternalsPlugin {
  apply(compiler) {
    compiler.options.externals = [
      (context, request, callback) => {
        // 白名单中的模块 → 打包进 Bundle
        if (this.shouldBundle(request)) {
          callback(); // 不外部化
          return;
        }

        // 其他模块 → 外部化（运行时 require）
        callback(null, `commonjs ${request}`);
      },
    ];
  }

  shouldBundle(request: string): boolean {
    // 1. 相对路径 → 打包（./、../开头）
    if (request.startsWith('.')) return true;

    // 2. @nami/* 包 → 打包
    if (request.startsWith('@nami/')) return true;

    // 3. CSS 文件 → 打包
    if (request.endsWith('.css')) return true;

    // 4. 用户配置的白名单 → 打包
    if (this.allowlist.some(pattern => pattern.test(request))) return true;

    return false;
  }
}
```

### 外部化的好处

1. **Server Bundle 体积小**：不打包 `express`、`lodash` 等大型库
2. **构建速度快**：跳过外部模块的编译和 Tree-shaking
3. **运行时加载**：Node.js 原生 `require()` 从 `node_modules` 加载

### 外部化的风险

如果一个模块被错误地外部化，但在运行时环境中不存在（如只在 `devDependencies` 中），会导致 `Cannot find module 'xxx'` 错误。这是 SSR 部署时最常见的问题之一。

**解决方案：** 确保所有需要运行时使用的包在 `dependencies` 中（而非 `devDependencies`）。

**源码参考：**
- `packages/webpack/src/plugins/ssr-externals-plugin.ts`
