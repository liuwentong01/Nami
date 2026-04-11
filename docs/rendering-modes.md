# 五种渲染模式详解

Nami 支持五种渲染模式，可以**按路由粒度**为不同页面选择最合适的模式。这是 Nami 最核心的设计之一——你不需要整个项目统一一种渲染模式，而是根据每个页面的特性选择最优解。

本文档深入讲解每种模式的原理、执行流程、适用场景和性能特征。读完后你将能够为任何页面选择最合适的渲染模式。

---

## 总览对比

| 特性 | CSR | SSR | SSG | ISR | Streaming SSR |
|------|-----|-----|-----|-----|---------------|
| **渲染位置** | 浏览器 | 服务端（每次请求） | 构建时 | 构建时 + 后台更新 | 服务端（流式） |
| **TTFB** | 快 | 较慢 | 极快 | 极快（缓存命中） | 快（shell 先到） |
| **FCP/LCP** | 慢 | 快 | 极快 | 极快 | 快 |
| **SEO** | 差 | 好 | 好 | 好 | 好 |
| **数据新鲜度** | 实时 | 实时 | 构建时 | 可控延迟 | 实时 |
| **服务端负载** | 无 | 高 | 无（运行期） | 低 | 中 |
| **适用场景** | 内部工具 | 实时页面 | 静态内容 | 半静态内容 | 大型页面 |

---

## 1. CSR — Client-Side Rendering

### 原理

服务端返回一个只包含 `<div id="nami-root"></div>` 和 JS/CSS 引用的空壳 HTML。浏览器下载 JS 后在客户端执行完整的 React 渲染。

### 执行流程

```
浏览器请求 → 服务端返回空壳 HTML → 浏览器下载 JS → React.createRoot → 渲染完成
```

### 源码实现

`CSRRenderer.render()` 的核心逻辑：

```typescript
// packages/core/src/renderer/csr-renderer.ts
async render(context: RenderContext): Promise<RenderResult> {
  const html = this.generateShellHTML(context);  // 空壳 HTML
  return this.createDefaultResult(html, 200, RenderModeEnum.CSR, timing, {
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=120' },
  });
}
```

关键特征：
- `prefetchData()` 返回空对象 — 不在服务端获取数据
- `createFallbackRenderer()` 返回 `null` — CSR 是降级链终点
- `Cache-Control: public, max-age=60` — 空壳可以被 CDN 缓存

### 路由配置

```typescript
{ path: '/dashboard', component: './pages/dashboard', renderMode: 'csr' }
```

### 适用场景

- 后台管理系统
- 内部工具
- 不需要 SEO 的页面
- 对首屏性能要求不高的场景

### CSR 的性能取舍

```
用户体验时间线（CSR）:
  0ms ──── TTFB（收到 HTML）──── FCP/LCP（等待 JS 下载、解析、执行后才看到内容）
  ▪ TTFB 快（HTML 很小）
  ▪ FCP/LCP 慢（必须等 JS 完成后才有任何可见内容）
  ▪ 搜索引擎爬虫看到的是空白页面（SEO 差）

用户体验时间线（SSR）:
  0ms ──── TTFB（收到完整 HTML，内容立即可见）──── JS 加载 ──── 可交互
  ▪ TTFB 较慢（服务端需要渲染）
  ▪ FCP/LCP 快（HTML 中已有完整内容）
  ▪ 搜索引擎看到完整页面（SEO 好）
```

> **关键区别**：CSR 的「白屏时间」= TTFB + JS 下载 + JS 解析执行；SSR 的「内容可见时间」= TTFB（HTML 到达即可见）。对于首屏性能敏感的面向用户页面，SSR 通常更优。

---

## 2. SSR — Server-Side Rendering

### 原理

每次请求时，服务端执行 `getServerSideProps` 获取数据，调用 React `renderToString` 生成完整 HTML，将数据通过 `<script>` 标签注入页面，客户端通过 Hydration 激活交互。

### 执行流程

```
浏览器请求
    │
    ▼
服务端 SSRRenderer.render()
    │
    ├── 1. callPluginHook('beforeRender')
    │
    ├── 2. prefetchData()
    │      └── getServerSideProps({ params, query, headers, cookies })
    │          └── return { props: { ... } }
    │
    ├── 3. renderToString(<App data={props} />)
    │      └── 动态 import('react-dom/server')
    │
    ├── 4. assembleHTML()
    │      ├── <head>: title, meta, CSS links (from asset-manifest)
    │      ├── <div id="nami-root">...</div>  (渲染产物)
    │      ├── <script>window.__NAMI_DATA__=...</script>  (数据注入)
    │      └── <script defer src="main.[hash].js"></script>
    │
    ├── 5. callPluginHook('afterRender')
    │
    └── 返回完整 HTML

浏览器收到 HTML → 显示内容（FCP）→ 下载 JS → hydrateRoot() → 可交互
```

### 关键源码

```typescript
// packages/core/src/renderer/ssr-renderer.ts
private async executeSSR(context, timing): Promise<RenderResult> {
  // 阶段一：数据预取
  const prefetchResult = await this.prefetchData(context);
  context.initialData = prefetchResult.data;

  // 阶段二：React 渲染
  const renderedHTML = await this.renderAppHTML(context);

  // 阶段三：HTML 组装
  const fullHTML = this.ensureDocumentHTML(renderedHTML, context);

  return this.createDefaultResult(fullHTML, 200, RenderModeEnum.SSR, timing);
}
```

### 兼容两种服务端入口协议

SSRRenderer 支持两种接入方式：

1. **`appElementFactory`**：返回 React 元素，框架内部调用 `renderToString`
2. **`htmlRenderer`**：直接返回 HTML 字符串（`entry-server.tsx` 的 `renderToHTML` 导出）

框架优先使用 `htmlRenderer`，适配已有 `entry-server.tsx` 的项目。

### 超时保护

整个 SSR 流程被 `withTimeout(promise, ssrTimeout)` 包裹。超时后抛出 `RenderError`，上层可通过 `createFallbackRenderer()` 获取 CSR 降级方案。

### Hydration：服务端 HTML 到客户端可交互

SSR 返回的 HTML 虽然用户能立即看到内容，但此时页面是「不可交互的」——按钮点击没有反应，因为 JavaScript 还没有加载。

**Hydration（水合）** 是 React 将客户端 JavaScript 附加到服务端已渲染的 HTML 上的过程：

```
服务端 → renderToString() → <button>点击</button>  (纯 HTML，不可交互)
                                    │
客户端 → hydrateRoot()       → <button onClick={handler}>点击</button>  (React 接管，可交互)
```

React 18 的 `hydrateRoot` 不会重新创建 DOM，而是**复用**服务端生成的 DOM 节点，仅绑定事件处理器。如果客户端渲染结果与服务端 HTML 不一致，React 会打印 Hydration Mismatch 警告。

> **常见 Mismatch 原因**：
> - 在渲染中使用 `Date.now()`、`Math.random()`（服务端和客户端结果不同）
> - 使用 `typeof window !== 'undefined'` 条件渲染（服务端和客户端走不同分支）
> - 解决方案：使用 `useEffect` 处理客户端特有逻辑，确保首次渲染服务端客户端一致

### 适用场景

- 需要 SEO 的页面
- 数据实时性要求高（每次请求最新数据）
- 电商首页、搜索结果页

---

## 3. SSG — Static Site Generation

### 原理

在 **构建时** 执行数据预取和 React 渲染，生成静态 HTML 文件。运行时直接读取文件返回，无需执行 React 渲染。

### 执行流程

**构建时**：
```
nami build
  │
  ▼
SSGRenderer.generateStatic(routes)
  │
  ├── 遍历 SSG 路由
  │     ├── 动态路由 → getStaticPaths() 获取所有路径
  │     └── 静态路由 → 直接使用 path
  │
  ├── 对每个路径
  │     ├── getStaticProps({ params }) → { props }
  │     ├── renderToString(<App data={props} />)
  │     └── 写入 dist/client/[path].html
  │
  └── 完成
```

**运行时**：
```
浏览器请求 /about
    │
    ▼
SSGRenderer.render()
  └── staticFileReader.readFile('dist/client/about.html')
      └── 直接返回文件内容（或 CDN 直接响应）
```

### 关键源码

```typescript
// packages/core/src/renderer/ssg-renderer.ts
async generateStatic(routes: NamiRoute[]): Promise<StaticGenerationResult> {
  for (const route of routes) {
    const paths = await this.getPathsForRoute(route);  // 获取所有静态路径
    for (const pathInfo of paths) {
      await this.generateSinglePage(route, pathInfo);   // 逐页生成
    }
  }
}
```

### 动态路由的静态生成

对于 `/blog/:slug` 这样的动态路由，需要通过 `getStaticPaths` 声明所有需要生成的路径：

```typescript
export async function getStaticPaths() {
  return {
    paths: [
      { params: { slug: 'hello-world' } },
      { params: { slug: 'getting-started' } },
    ],
    fallback: false,  // 未列出的路径返回 404
  };
}
```

### SSG 的局限性

- **构建时间随页面数量线性增长**：10000 个商品 = 10000 次渲染，构建可能需要数小时
- **数据在构建后就固定了**：内容更新需要重新构建和部署
- **不适合动态数据**：无法展示用户个性化内容

> **这些局限正是 ISR 要解决的问题** —— ISR 保留了 SSG 的性能优势，同时支持增量更新，不需要每次都全量构建。

### 适用场景

- 博客、文档站
- 营销落地页
- 不常更新的静态内容

---

## 4. ISR — Incremental Static Regeneration

### 原理

结合 SSG 的性能优势和 SSR 的数据新鲜度。首次请求时生成静态页面并缓存，后续请求返回缓存内容。当缓存过期时，在后台异步重新渲染（Stale-While-Revalidate 策略），用户始终不会看到等待状态。

### SWR 状态机

```
                    revalidate          revalidate × staleMultiplier
                    (e.g. 60s)          (e.g. 120s)
        ┌───────────────┼───────────────────────┼──────────┐
        │    Fresh      │       Stale           │ Expired  │
        │  直接返回缓存  │ 返回缓存 + 后台重验证   │ 同步渲染  │
        └───────────────┴───────────────────────┴──────────┘
  创建时间                                                   TTL 到期
```

- **Fresh**（新鲜）：缓存未过期，直接返回，响应时间 < 1ms
- **Stale**（陈旧）：缓存已过 `revalidate` 时间但未超过 `staleMultiplier` 倍，返回旧内容，后台排入 `RevalidationQueue` 异步重渲染
- **Expired**（过期）：缓存完全过期或不存在，走同步渲染并缓存结果

### 执行流程

```
浏览器请求 /products/123
    │
    ▼
isrCacheMiddleware
    │
    ├── cacheStore.get('/products/123')
    │
    ├── [命中 Fresh] → 直接返回 ── 结束
    │
    ├── [命中 Stale] → 返回旧内容
    │     └── revalidationQueue.enqueue('/products/123', renderFn)
    │         └── 后台异步：renderFn() → cacheStore.set() ── 下次请求即为新内容
    │
    └── [未命中/Expired]
          │
          ▼
        await next()  ──▶ renderMiddleware
          │                    │
          │    ISRRenderer.render()
          │      ├── getStaticProps()
          │      ├── renderToString()
          │      └── 返回 RenderResult
          │
          ◀── cacheStore.set(key, entry, TTL = revalidate × 2)
          │
          └── 返回 HTML
```

### 三种缓存后端

| 后端 | 适用场景 | 特点 |
|------|---------|------|
| `MemoryStore` | 开发/单进程 | LRU 淘汰、进程内、重启丢失 |
| `FilesystemStore` | 单机多进程 | SHA256 文件名、原子写入、标签索引 |
| `RedisStore` | 分布式多机 | `SETEX`、标签用 `SET`、pipeline 批量失效 |

### 按需失效

```typescript
// 按路径失效
await isrManager.invalidate('/products/123');

// 按标签批量失效（如产品信息更新后刷新所有引用该产品的页面）
await isrManager.invalidateByTag('product:123');
```

### 适用场景

- 电商商品详情页
- 新闻文章
- 需要近实时但不要求每请求渲染的页面

---

## 5. Streaming SSR

### 原理

Streaming SSR 基于 React 18 的 `renderToPipeableStream`，核心目标不是“减少总渲染工作量”，而是**让浏览器更早收到第一批可展示内容**。

与普通 SSR 必须等待整页 `renderToString()` 完成后再一次性返回不同，Streaming SSR 会将响应拆成多个阶段输出：

- **`headHTML`**：文档开头部分，如 `<!DOCTYPE html>`、`<html>`、`<head>`、CSS 引用、`<body>`、`<div id="nami-root">`
- **`React shell`**：最早可显示的一版页面 UI，通常是 Suspense 边界之外的内容，再加上尚未 ready 区块的 `fallback`
- **`patch`**：后续补发的内容块。某个 Suspense 子树 ready 后，React 会继续输出真实 HTML，并附带用于替换 fallback 的内联脚本
- **`tailHTML`**：文档结尾部分，如 `</div>`、初始数据脚本、客户端 JS 引用、`</body></html>`
- **`hydration`**：浏览器加载客户端 JS 后调用 `hydrateRoot()`，React 接管已有 DOM，使页面变得可交互

> 注意：在 Nami 当前实现中，路由级 `prefetchData()` 会先执行完成，然后才开始 `renderToPipeableStream()`。因此它的收益主要来自“React 渲染阶段的流式输出”，而不是把 `getServerSideProps` 本身也一起流出去。

### 与传统 SSR 的区别

```text
普通 SSR:
  服务端：prefetchData → renderToString(整棵树) → assembleHTML(完整文档)
  网络：一次性返回完整 HTML
  浏览器：收到完整 HTML 后开始显示 → 下载 JS → hydrateRoot() → 可交互

Streaming SSR + Suspense:
  服务端：prefetchData → renderToPipeableStream()
         ├── onShellReady: 先写 headHTML，再开始输出 React shell
         ├── Suspense 区块 A ready: 输出真实 HTML + patch，替换 fallback
         ├── Suspense 区块 B ready: 输出真实 HTML + patch，替换 fallback
         └── 流结束: 写 tailHTML
  浏览器：先显示 shell/fallback → 后续逐块替换为真实内容 → 下载 JS → hydrateRoot() → 可交互
```

### `Suspense` 在这里的真正作用

`renderToPipeableStream()` 并不要求页面“必须写了 Suspense 才能运行”，但 **Streaming SSR 的核心收益依赖 Suspense 边界来定义“哪里可以先 fallback、后补真实内容”**。

更准确地说：

- `Suspense` 不是“切 HTML 字符串”的工具，而是**声明某个 React 子树当前可以先显示 fallback**
- React 利用这个边界决定 shell 中先放什么、后续 patch 要替换什么
- 没有 Suspense 时，`renderToPipeableStream()` 仍然可以工作，但通常只剩下“更早开始传输”和“减少整页字符串缓冲”的有限收益

`Suspense` 还可以嵌套，用来定义多级渐进展示顺序。外层边界决定“页面最早能展示到哪一步”，内层边界决定“哪些次级区块可以继续后到”。

### 关键概念与文档结构

Nami 当前实现里，`headHTML` 与 `tailHTML` 的边界是明确的：

```typescript
headHTML:
  <!DOCTYPE html>
  <html>
  <head>...</head>
  <body>
    <div id="nami-root">

React shell / patch:
  由 renderToPipeableStream() 持续输出

tailHTML:
    </div>
    <script>window.__NAMI_DATA__=...</script>
    <script defer src="main.[hash].js"></script>
  </body>
  </html>
```

这意味着：

- **先返回的不是一个“完整闭合的 HTML 字符串”**，而是完整文档的前半段
- 浏览器不需要等到 `</html>` 才开始工作；它会对流式到达的字节做**增量解析**
- 真正可见内容通常不是只靠 `headHTML`，而是 `headHTML` 后紧接着到达的 `React shell`

### 执行流程（流模式）

```typescript
// packages/core/src/renderer/streaming-ssr-renderer.ts
async renderToStream(context): Promise<StreamingRenderResult> {
  // 1. 数据预取
  const prefetchResult = await this.prefetchData(context);

  // 2. 构建文档壳
  const { headHTML, tailHTML } = this.buildHTMLShell(context);

  // 3. renderToPipeableStream
  const { pipe, abort } = renderToPipeableStream(appElement, {
    onShellReady: () => {
      passThrough.write(headHTML);   // 文档开头：<!DOCTYPE html> ~ <div id="nami-root">
      pipe(passThrough);             // React shell / patch 持续写入
    },
    onAllReady: () => {
      // 所有 Suspense 边界 resolve，流即将结束
    },
  });

  // 4. 超时保护
  setTimeout(() => { if (!shellReady) abort(); }, streamTimeout);

  // 5. React 流结束后追加 tailHTML
  return { stream: wrappedStream, isStreaming: true, ... };
}
```

对应到网络层，可以把一次响应理解为：

```text
headHTML
  + React shell（首批可见内容，可能含 fallback）
  + patch 1（替换某个 Suspense fallback）
  + patch 2（替换另一个 Suspense fallback）
  + ...
  + tailHTML
```

其中 patch 不是“浏览器自动猜测怎么拼接”，而是 React 在后续流里输出：

- 真实内容对应的 HTML
- 用于定位并替换 fallback 的内联脚本

所以从用户视角看，页面会表现为：

1. 先看到页面主体和若干 Skeleton / Spinner
2. 某个区域准备好后，被真实内容替换
3. 最后客户端下载完成并 Hydration，页面整体变成交互式应用

### 降级链

```
Streaming SSR → 普通 SSR → CSR
```

如果 `renderToPipeableStream` 失败（如 Shell 错误），降级到传统 `renderToString` 的 SSR，再失败则降级到 CSR。

### 两种使用方式

1. **`render()`**：内部使用 `renderToStringFromStream`，等待流全部结束后收集为完整 HTML 字符串。适用于必须拿到完整 HTML 的场景。
2. **`renderToStream()`**：返回 `NodeJS.ReadableStream`，中间件直接 pipe 到 `ctx.res`。这才是真正的流式响应。

两者的关键区别是：

- `render()` 虽然底层也调用 `renderToPipeableStream`，但调用方拿到的是完整字符串，因此没有“渐进传输”收益
- `renderToStream()` 会立即开始把 `headHTML + React shell + patch + tailHTML` 按顺序写给浏览器

因此，**是否真正获得 Streaming SSR 的体验，不取决于是否调用了 `renderToPipeableStream`，而取决于调用方是否使用“流模式”消费它**

### 适用场景

- HTML 体积 > 100KB 的大型页面
- 使用 `React.lazy` + `Suspense` 的页面
- 对 TTFB 敏感的场景
- 需要选择性 Hydration 的复杂页面

不太适合的场景：

- 页面非常简单，没有明显的异步分块
- 主要瓶颈在统一的 `getServerSideProps`，而不是组件树内部的慢区块
- 需要与当前 ISR 的完整 HTML 缓存策略深度绑定的页面

---

## 渲染模式选型决策树

```
                            页面需要 SEO？
                           /            \
                         是              否
                         │               │
                   数据需要实时？     ──▶ CSR
                   /          \
                 是            否
                 │             │
          页面很大/用 Suspense？  数据更新频率？
           /         \        /            \
         是           否    低（天/周）    中（分钟/小时）
         │            │       │              │
    Streaming SSR    SSR     SSG            ISR
```

---

## 混合模式示例

一个电商项目的路由配置：

```typescript
export default defineConfig({
  routes: [
    // 首页 — 实时数据 + SEO
    { path: '/', component: './pages/home', renderMode: 'ssr' },

    // 商品列表 — 搜索结果实时变化
    { path: '/products', component: './pages/product-list', renderMode: 'ssr' },

    // 商品详情 — 半静态，60 秒更新
    { path: '/products/:id', component: './pages/product-detail',
      renderMode: 'isr', revalidate: 60 },

    // 关于页 — 纯静态
    { path: '/about', component: './pages/about', renderMode: 'ssg' },

    // 用户中心 — 纯客户端
    { path: '/account/*', component: './pages/account', renderMode: 'csr' },
  ],
});
```

---

## 常见误区

### 误区一：「所有页面都用 SSR 最安全」

SSR 意味着每次请求都要服务端渲染，CPU 开销高。对于不需要 SEO 的管理后台页面，CSR 反而更合适（零服务端开销）。对于内容更新不频繁的页面，SSG 或 ISR 的性能远优于 SSR。

### 误区二：「ISR 可以替代 SSR」

ISR 的数据有延迟（最长 `revalidate` 秒）。如果你的页面必须展示**每次请求时的最新数据**（如用户购物车、实时股价），必须使用 SSR。ISR 适合「几分钟前的数据也可以接受」的场景。

### 误区三：「Streaming SSR 总是比普通 SSR 好」

更严谨的说法是：`renderToPipeableStream` 并不强制要求页面必须写 `React.Suspense` 才能运行，但如果页面没有可挂起的异步区块，Streaming SSR 的核心收益会非常有限，整体效果往往接近普通 SSR。

另外，当前 Nami 中真正的流式响应是逐块发送的，而 ISR 依赖的是“完整 HTML 缓存”语义，因此两者不适合直接复用同一条缓存链路。

### 误区四：「SSG 页面不需要 JavaScript」

SSG 生成的 HTML 仍然会加载 JS Bundle 并执行 Hydration。Hydration 后页面才能响应交互事件。如果你的页面真的不需要任何客户端交互，可以考虑不引入 React JS（但这超出了 Nami 的默认行为）。

### 误区五：「`window.__NAMI_DATA__` 在 `tailHTML` 里，用户首屏就看不到有意义内容」

这也是对 Streaming SSR 很常见的误解。更准确地说：

- `window.__NAMI_DATA__` 的主要职责是为**客户端 Hydration 提供与服务端一致的初始数据**
- 首屏“能不能先看到内容”主要取决于**服务端是否已经把内容渲染进 `React shell`**
- CSS 也不是“等到最后才处理”，而是在 `headHTML` 中以 `<link rel="stylesheet">` 的形式提前注入，浏览器会尽早发起样式请求

也就是说，Streaming SSR 的时间关系其实是：

```text
服务端：
  prefetchData()
    → 已拿到首屏数据
    → 返回 headHTML（其中已包含 CSS links）
    → 流式返回 React shell / fallback / patch
    → 返回 tailHTML（这里才注入 __NAMI_DATA__ 和 defer JS）

浏览器：
  解析 headHTML
    → 立刻请求 CSS
  解析 React shell
    → 开始显示页面内容
  收到 tailHTML
    → 写入 window.__NAMI_DATA__
    → 执行 defer JS
    → hydrateRoot()
    → 页面变为可交互
```

因此：

- `__NAMI_DATA__` 在后面，并不会阻止用户先看到页面
- 它影响的是“客户端接管时能否拿到同一份初始数据”，不是“首屏 HTML 能否显示”
- 真正决定体验的是 `React shell` 的设计。如果把几乎所有有意义内容都包进慢 `Suspense` 边界里，用户最早看到的就可能只剩导航和 Skeleton，这属于 shell 设计问题，而不是 `tailHTML` 中数据脚本的位置问题

---

## 下一步

- 想了解 ISR 缓存的深入实现？→ [ISR 与缓存](./isr-and-caching.md)
- 想了解渲染失败时的降级流程？→ [错误处理与降级](./error-and-degradation.md)
- 想了解路由匹配如何决定渲染器？→ [路由系统](./routing.md)
