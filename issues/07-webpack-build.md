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
| 代码分割 | 按路由分割，懒加载 | 不做按需拆分（每个 entry 限制为单 chunk） |
| CSS 处理 | 提取为独立 `.css` 文件 | `asset/source`（返回 CSS 字符串） |
| Tree-shaking | 需要（减小下载体积、提升长期缓存命中） | 不是核心目标（产物不走网络传输，且大量依赖已 external） |
| Externals | 无（所有依赖打包进 Bundle） | `webpack-node-externals`（node_modules 运行时 require） |
| 数据预取函数 | 被替换为空实现（安全） | 保留原始实现 |
| 目标 | `target: 'web'` | `target: 'node'` |

### Server Bundle 为什么不做代码分割？

浏览器中代码分割是为了减少首次加载的 JS 体积。服务端不存在"下载"问题，`dist/server` 里的代码本来就在本地文件系统上；而且服务端构建已经把绝大多数 `node_modules` 外部化了，继续为"少下几 KB"做激进优化收益很小。

所以 Server Build 的重点不是"尽量瘦"，而是：
- 让 Node.js 能稳定 `require()` 编译产物
- 让 `ModuleLoader` 能按页面模块找到 `getServerSideProps` / `getStaticProps`
- 避免再拆出额外 async chunk，降低运行时加载复杂度

```typescript
// Server Config
plugins: [
  new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })
]
```

这里的"不做代码分割"是指：**不给某个 entry 再额外拆出 vendor chunk / async chunk**。  
它**不等于整个 `dist/server` 只会输出一个文件**。因为当前 `createServerConfig()` 本身就是多入口：
- `entry-server`：应用级服务端入口（如果项目提供了 `src/entry-server.*`）
- 每个页面组件：都会作为一个独立 entry 输出到 `dist/server/<component-path>.js`

所以 `LimitChunkCountPlugin({ maxChunks: 1 })` 的真实含义更接近：
**每个入口各自保持单 chunk 输出**，而不是"整个 server build 只有一个 bundle 文件"。

### Server Bundle 的 CSS 处理

```typescript
// 服务端把 CSS 当成源码字符串处理
{
  test: /\.css$/,
  type: 'asset/source'  // 返回 CSS 源码字符串
}
```

服务端渲染时，真正写进 HTML 的 `<link rel="stylesheet">` 来自 **Client Bundle 的 `asset-manifest.json`**，不是来自 `dist/server`。  
因此 Server Build 的目标只是：**让 `import './style.css'` 在 Node.js 侧可执行，不要报错**，而不是再生成一份可供浏览器加载的 CSS 文件。

直观对比如下：

```typescript
// 源码
import './button.css';

export default function Button() {
  return <button className="btn">Click</button>;
}
```

**客户端构建**会把它处理成：
- `button.css` 经 `css-loader + postcss-loader + MiniCssExtractPlugin`
- 最终产出 `dist/client/static/css/main.[hash].css`
- SSR/CSR 返回的 HTML 通过 `<link>` 去加载这份真实 CSS 文件

**服务端构建**会把它处理成：
- 不产出 `dist/server/*.css`
- `import './button.css'` 对应的模块导出变成一段字符串，效果近似：

```javascript
module.exports = ".btn { color: red; }";
```

也就是说，Server Bundle 里的 CSS 更像一个"占位模块"或"stub"：
- 让页面模块在 Node.js 中可以被正常 `require()`
- 保留 import 语义
- 但不会参与最终样式注入

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
└── server/                    # Node.js 端产物（多 entry，但每个 entry 不再拆 chunk）
    ├── entry-server.js        # 应用级服务端入口（可选）
    └── pages/.../*.js         # 页面组件对应的服务端模块
```

所以更准确地说：
- **Server Build 不做代码分割**：不会再从某个 entry 里拆出额外 chunk
- **但 Server Build 仍可能输出多个文件**：因为它本来就是 `entry-server + routeEntries` 的多入口构建
- 这些页面级 `.js` 文件会被 `ModuleLoader` 和 SSG 阶段按需加载

**源码参考：**
- `packages/webpack/src/configs/client.config.ts`
- `packages/webpack/src/configs/server.config.ts`
- `packages/core/src/module/module-loader.ts`

---

## 题目 49：data-fetch-loader 的作用是什么？如果没有它会有什么安全问题？⭐⭐⭐⭐

**答案：**

### 作用

data-fetch-loader 在**客户端构建**时，会把 `getServerSideProps`、`getStaticProps`、`getStaticPaths` 这些**只应在服务端/构建期执行**的函数替换为空实现。

这里要区分两类"数据获取"：
- `getServerSideProps / getStaticProps / getStaticPaths`：是 **SSR / SSG / ISR 协议**，由服务端或构建阶段执行
- 浏览器里的 `fetch` / `useClientFetch` / 路由预取接口：是 **CSR 协议**，由客户端执行

所以，客户端 bundle 里把这些函数替换掉，并不等于"CSR 就拿不到数据"。  
更准确地说：
- **纯 CSR 页面**本来就不应该依赖 `getServerSideProps`，而应使用浏览器端请求
- **客户端路由预取**时，Nami 会请求 `/_nami/data/<path>`，由服务端 `data-prefetch-middleware` 再去执行真实的 `getServerSideProps` / `getStaticProps`
- **SSR 失败降级到 CSR** 时，页面不会再从 HTML 中拿到服务端直出的首屏数据，但仍可以走浏览器端补数链路

需要注意：如果业务页面把数据获取**完全写死在 `getServerSideProps` 里**，又没有任何客户端补数逻辑，那么一旦降级到 CSR，首屏确实只会剩下壳。这不是 loader 的问题，而是 SSR-only 数据协议和 CSR 数据协议本来就应该分开设计。

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
export default function dataFetchLoader(source: string): string {
  const options = this.getOptions();

  if (options.isServer) {
    return source;
  }

  let result = source;

  for (const fnName of ['getServerSideProps', 'getStaticProps', 'getStaticPaths']) {
    const asyncPattern = new RegExp(
      `export\\s+async\\s+function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}`,
      'g',
    );
    const syncPattern = new RegExp(
      `export\\s+function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}`,
      'g',
    );

    const replacement = `export async function ${fnName}() { return { props: {} }; }`;
    result = result.replace(asyncPattern, replacement);
    result = result.replace(syncPattern, replacement);
  }

  return result;
}
```

**为什么保留空的 export 而不是完全删除？**

主要是为了**保持页面模块的导出形状稳定**：
- 客户端侧如果按导出名检查这些函数是否存在，不会因为"被完全删掉"而失效
- 页面源码里"声明过这些服务端函数"这一事实仍然保留下来
- 同时把真正的服务端逻辑从客户端 bundle 里拿掉

补充一点：从当前仓库实现看，`page-loader` 注入的 `__namiPageMeta` 还没有形成完整的消费链路，因此这里更准确的表述是"为了兼容模块接口和约定检测"，而不是某个具体运行时代码必须依赖这些空函数返回值。

**源码参考：**
- `packages/webpack/src/loaders/data-fetch-loader.ts`
- `packages/client/src/router/route-prefetch.ts`
- `packages/server/src/middleware/data-prefetch-middleware.ts`
- `packages/core/src/renderer/ssr-renderer.ts`

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
  renderMode: 'ssr',
  hasGetServerSideProps: true,
  hasGetStaticProps: false,
  hasGetStaticPaths: false,
};
```

### 当前代码库里的真实作用

先说结论：**就当前仓库实现来看，`__namiPageMeta` 更像页面模块自带的一份"自描述信息"，而不是 Builder 决定构建任务的核心依据。**

真正决定构建任务的是 `NamiRoute.renderMode`：

```
CSR           → 只构建 Client Bundle
SSR / SSG / ISR → 需要 Server Bundle
SSG / ISR     → 生产环境还要执行静态生成
```

也就是说，你提的疑问是对的：  
**当前实现并不是根据页面里有没有 `getServerSideProps` 来反推渲染模式，而是先看路由配置里的 `renderMode`。**

两者的职责不同：
- `renderMode`：决定走 CSR、SSR、SSG 还是 ISR 这条渲染流水线
- `getServerSideProps / getStaticProps / getStaticPaths`：决定这条流水线里有没有对应的数据预取步骤
- `__namiPageMeta`：把这些信息附着到页面模块上，作为页面级元数据

#### 1. 页面自描述信息

`page-loader` 会根据源码和 loader 参数，把当前页面的关键信息写进模块本身：
- `renderMode`
- 是否声明了 `getServerSideProps`
- 是否声明了 `getStaticProps`
- 是否声明了 `getStaticPaths`

这样页面模块在被动态 import 之后，理论上可以自带一份可读取的元信息。

#### 2. 不是当前 Builder 的主输入

当前 `NamiBuilder.determineBuildTasks()` 只看路由表：

```typescript
const needsServerBundle = routes.some((route) =>
  NEEDS_SERVER_BUNDLE.includes(route.renderMode)
);
```

所以文档如果写成"`__namiPageMeta` 用于决定要不要构建 server bundle"，并不准确。

#### 3. 数据函数是否存在，影响的是"能力"而不是"模式"

例如：
- 路由配置为 `SSR`，但没有 `getServerSideProps`：仍然会走 SSR，只是 `SSRRenderer.prefetchData()` 返回空数据
- 路由配置为 `SSG/ISR`，但没有 `getStaticProps`：仍可以渲染，只是没有额外静态 props
- 动态 `SSG/ISR` 路由如果缺少 `getStaticPaths`：就无法枚举需要预生成的路径

所以不要把"有没有数据预取函数"理解成"渲染模式识别器"，它更像是该模式下的可选能力开关。

#### 4. 当前更像预留能力

从当前代码库搜索结果看，`__namiPageMeta` 的直接消费方还没有真正落地到 Builder / Renderer 里。  
因此更准确的说法是：
- **现在**：它主要是 loader 注入的页面级元数据
- **未来可能**：可用于开发警告、运行时检查、页面分析等能力

### 检测逻辑

```typescript
// page-loader 的检测方式
function detectDataFetchFunctions(source: string) {
  return {
    hasGetServerSideProps: /export\s+(async\s+)?function\s+getServerSideProps/.test(source),
    hasGetStaticProps: /export\s+(async\s+)?function\s+getStaticProps/.test(source),
    hasGetStaticPaths: /export\s+(async\s+)?function\s+getStaticPaths/.test(source),
  };
}
```

**源码参考：**
- `packages/webpack/src/loaders/page-loader.ts`
- `packages/webpack/src/builder.ts`
- `packages/shared/src/types/route.ts`
- `packages/shared/src/constants/render-modes.ts`

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
