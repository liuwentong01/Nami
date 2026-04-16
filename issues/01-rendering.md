# 渲染原理（10 题）

---

## 题目 1：SSR 的原理是什么？一个 SSR 请求在 Nami 中经历了哪些步骤？⭐⭐

**答案：**

SSR（Server-Side Rendering）的核心原理是：在服务端执行 React 组件的渲染逻辑，将组件树转换为 HTML 字符串，直接返回给浏览器。浏览器收到的是已经包含内容的完整 HTML，无需等待 JS 下载和执行就能看到页面内容。

在 Nami 中，一个 SSR 请求经历以下步骤：

```
1. Koa 中间件管线前处理（timing → security → requestContext）
2. renderMiddleware 匹配路由 → matchConfiguredRoute(path, routes)
3. 构造 RenderContext（URL、路由、参数、请求头、Cookie、requestId）
4. RendererFactory.create({ mode: 'ssr' }) → 创建 SSRRenderer 实例
5. SSRRenderer.render(context) 内部流程：
   ├── callPluginHook('beforeRender')     // 通知插件
   ├── prefetchData()                     // 调用 getServerSideProps 获取数据
   ├── renderToString(<App data={data}/>) // React 渲染为 HTML 字符串
   ├── assembleHTML()                     // 组装完整 HTML（head + body + scripts）
   ├── resolveAssets()                    // 从 asset-manifest.json 解析 JS/CSS 路径
   ├── generateDataScript()              // 将数据序列化注入 <script> 标签
   └── callPluginHook('afterRender')     // 通知插件
6. 设置响应：ctx.body = html, Cache-Control: private, no-cache
7. Koa 中间件管线后处理（写 X-Response-Time 等）
```

**源码参考：**
- `packages/core/src/renderer/ssr-renderer.ts` — SSRRenderer.render()
- `packages/server/src/middleware/render-middleware.ts` — renderMiddleware

---

## 题目 2：CSR 和 SSR 在性能和用户体验上有什么区别？各适用于什么场景？⭐⭐

**答案：**

**性能对比时间线：**

```
CSR 时间线:
|--- 白屏（下载 HTML 壳）---|--- 下载 JS ---|--- 执行 JS + 请求数据 ---|--- 页面可见 + 可交互 ---|

SSR 时间线:
|--- 服务端渲染 + 数据获取 ---|--- 页面可见（不可交互）---|--- 下载 JS ---|--- Hydration ---|--- 可交互 ---|
```

| 维度 | CSR | SSR |
|------|-----|-----|
| TTFB（首字节时间） | 快（返回空壳 HTML） | 慢（需要服务端渲染） |
| FCP（首次内容绘制） | 慢（需要 JS 执行后才有内容） | 快（HTML 已包含内容） |
| TTI（可交互时间） | FCP 后很快 | 需要等待 Hydration |
| SEO | 差（搜索引擎看到空壳） | 好（返回完整内容） |
| 服务器压力 | 低（只提供静态文件） | 高（每次请求都需要渲染） |

**适用场景：**
- **CSR**：管理后台、内部工具等不需要 SEO、用户已登录的场景
- **SSR**：需要 SEO + 实时数据的场景，如电商首页、新闻详情页

**Nami 的实现差异：**
- CSR 在 `CSRRenderer` 中只生成空壳 HTML（`<div id="nami-root"></div>` + JS/CSS 引用），不执行 React 渲染
- SSR 在 `SSRRenderer` 中动态导入 `react-dom/server`，调用 `renderToString()` 生成完整 HTML

**源码参考：**
- `packages/core/src/renderer/csr-renderer.ts` — generateShellHTML()
- `packages/core/src/renderer/ssr-renderer.ts` — render()

---

## 题目 3：什么是 Hydration？为什么 SSR 页面需要 Hydration？⭐⭐

**答案：**

Hydration（注水/水合）是 SSR 页面在客户端恢复交互能力的过程。

**为什么需要 Hydration？**

SSR 返回的 HTML 是纯静态的——按钮不能点击，表单不能输入，因为没有绑定任何事件处理器。Hydration 做的事情是：React 在客户端重新执行一遍组件树，但**不重新创建 DOM 节点**，而是复用服务端生成的 DOM，将事件处理器、状态管理等 JavaScript 逻辑"附着"上去。

**为什么 SSR 不能直接绑定事件？**

因为事件处理器本质上是运行在浏览器中的 JavaScript 函数，而不是 HTML 本身的一部分。服务端在 SSR 阶段能做的是把组件渲染成 HTML 字符串，但像 `onClick={handleClick}` 这样的事件绑定，背后依赖的是：

- 浏览器中的真实 DOM 节点
- 已经下载并执行的客户端 JavaScript
- 组件当前的状态、props、闭包和上下文

这些内容都不能直接随着 HTML 一起"打包"到浏览器后自动生效。服务端最多只能返回静态标记，真正的事件监听仍然必须在浏览器里注册。

换句话说，SSR 解决的是"先把页面内容显示出来"，而 Hydration 解决的是"让这份静态 HTML 重新连接上 React 的运行时能力"，包括事件处理、状态更新和后续重渲染。

```
SSR 返回的 HTML（静态）      Hydration 后（动态）
┌─────────────────┐         ┌─────────────────┐
│ <button>点击</button>│ →     │ <button onClick={fn}>点击</button>│
│ （不能点击）       │         │ （可以点击了）      │
└─────────────────┘         └─────────────────┘
```

**Nami 的实现：**

```typescript
// packages/client/src/hydration/hydrate.ts
if (isSSR && container.childNodes.length > 0) {
  // SSR 页面：使用 hydrateRoot 复用已有 DOM
  hydrateRoot(container, appElement, {
    onRecoverableError: (error) => { /* 处理 Hydration Mismatch */ }
  });
} else {
  // CSR 页面：使用 createRoot 从头渲染
  createRoot(container).render(appElement);
}
```

**Hydration Mismatch 的常见原因：**
1. 使用了 `Date.now()` 或 `Math.random()`（服务端和客户端值不同）
2. 访问了 `window.innerWidth` 等客户端 API（服务端不存在）
3. 浏览器插件修改了 DOM 结构

**源码参考：**
- `packages/client/src/hydration/hydrate.ts` — hydrateApp() / renderApp()

---

## 题目 4：SSG 和 ISR 的区别是什么？ISR 解决了 SSG 的什么问题？⭐⭐⭐

**答案：**

| 维度 | SSG | ISR |
|------|-----|-----|
| 生成时机 | 构建时一次性生成所有页面 | 构建时生成 + 运行时增量更新 |
| 数据新鲜度 | 重新构建才能更新 | 可配置更新间隔（revalidate） |
| 数据预取函数 | `getStaticProps` + `getStaticPaths` | `getStaticProps`（复用 SSG 语义） |
| 运行时依赖 | 不需要服务器（可部署到 CDN） | 需要服务器（处理过期重验证） |
| 适用场景 | 博客、文档、几乎不变的页面 | 电商商品页、新闻列表 |

**ISR 解决了 SSG 的核心痛点：**

1. **更新延迟**：SSG 页面更新必须重新构建整个项目。ISR 通过 stale-while-revalidate 语义在后台增量更新
2. **构建时间**：10 万个商品页全部 SSG 需要几小时。ISR 可以先生成热门页面，其余按需生成
3. **数据实效性**：SSG 页面在两次构建之间数据不变。ISR 页面可以几分钟就更新一次

**ISR 的 SWR 语义：**

```
假设 revalidate = 60 秒

0-60s:  Fresh 状态 → 直接返回缓存（零渲染成本）
60-120s: Stale 状态 → 返回旧缓存 + 后台触发重验证
>120s:  Expired 状态 → 同步重新渲染
```

**源码参考：**
- `packages/core/src/renderer/ssg-renderer.ts` — generateStatic()
- `packages/core/src/renderer/isr-renderer.ts` — handleCacheMiss()
- `packages/server/src/isr/stale-while-revalidate.ts` — evaluateCacheFreshness()

---

## 题目 5：Streaming SSR 和普通 SSR 有什么区别？它带来了什么好处？⭐⭐⭐

**答案：**

**核心区别：**
- 普通 SSR 使用 `renderToString()`：等整个组件树渲染完毕后，一次性返回完整 HTML
- Streaming SSR 使用 `renderToPipeableStream()`：渲染一部分就发送一部分，流式传输

```
普通 SSR:
Server: [======渲染全部======] → 一次性发送 → Client

Streaming SSR:
Server: [==渲染 shell==] → 发送 head + 已有内容 → Client 开始展示
        [==渲染剩余==]   → 逐步发送 → Client 逐步填充
```

**带来的好处：**

1. **更快的 TTFB**：Shell（页面骨架）渲染完就开始发送，不需要等 Suspense 内的数据
2. **更低的内存占用**：不需要在内存中缓存完整 HTML 字符串
3. **与 React Suspense 配合**：Suspense 组件的 fallback 先发送，真实内容准备好后流式替换

**Nami 的双模式实现：**

```typescript
// packages/core/src/renderer/streaming-ssr-renderer.ts

// 模式 1：流式返回（直接发送到 HTTP 响应）
async renderToStream(context): Promise<Readable> {
  // renderToPipeableStream → onShellReady → pipe head + React stream
}

// 模式 2：缓冲为字符串（用于 ISR 缓存等需要完整 HTML 的场景）
async render(context): Promise<RenderResult> {
  // renderToPipeableStream → 收集所有 chunk → 拼接为完整字符串
}
```

**Stream 生命周期事件：**
- `onShellReady`：非 Suspense 内容渲染完成 → 开始发送 head HTML + React 输出
- `onAllReady`：所有内容（含 Suspense）渲染完成 → 发送 tail HTML
- `onError`：渲染出错 → 降级到普通 SSR

**降级链：**
```
Streaming SSR → 普通 SSR → CSR
```

**源码参考：**
- `packages/core/src/renderer/streaming-ssr-renderer.ts`

---

## 题目 6：SSR 失败后是如何降级的？描述完整的 5 级降级策略。⭐⭐⭐⭐

**答案：**

Nami 实现了 5 级降级保护机制，确保在渲染失败时仍能返回可用的响应：

```
Level 0: 正常渲染
    │ 失败
    ▼
Level 1: 重试（configurable maxRetries 次）
    │ 全部失败
    ▼
Level 2: CSR 降级（空壳 HTML + JS/CSS 引用）
    │ 如果有骨架屏配置
    ▼
Level 3: 骨架屏（route.skeleton 指定的组件文件路径）
    │ 如果有静态 HTML 兜底
    ▼
Level 4: 静态 HTML（预配置的兜底页面）
    │ 全部失败
    ▼
Level 5: 503 服务不可用（Retry-After: 30）
```

**各级别的实现细节：**

**Level 1 - 重试：**
```typescript
for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
  try {
    const result = await renderFn(context);
    result.meta.degraded = true;
    result.meta.degradeReason = `重试第 ${attempt} 次成功`;
    return { result, level: DegradationLevel.Retry, errors };
  } catch (error) {
    errors.push(error);
  }
}
```

**Level 2 - CSR 降级：**
返回只包含 `<div id="nami-root"></div>` + JS/CSS 引用的空壳 HTML。浏览器加载 JS 后在客户端渲染。关键点：必须正确引用 `assetManifest` 中的资源路径，否则页面空白。

**Level 3 - 骨架屏：**
`NamiRoute.skeleton` 是一个字符串（组件文件路径），指定了该路由的骨架屏组件。返回预定义的灰色占位块 HTML。

**Level 4 - 静态 HTML：**
从 `FallbackConfig.staticHTML` 读取预配置的兜底页面内容。

**Level 5 - 503：**
硬编码的 503 响应页面，包含 `Retry-After: 30` 头。

**可观测性：**
- 每个降级级别都设置 `X-Nami-Degraded` 响应头，标识降级原因
- `result.meta.degraded = true` 标记在渲染结果中
- 所有失败的 error 都收集到数组中，供事后分析

**源码参考：**
- `packages/core/src/error/degradation.ts` — DegradationManager.executeWithDegradation()
- `packages/server/src/middleware/render-middleware.ts` — 错误处理逻辑（362-410 行）

---

## 题目 7：Nami 为什么用 `renderToString` 而不是直接拼接 HTML 字符串？⭐⭐⭐

**答案：**

`renderToString` 是 `react-dom/server` 提供的函数，将 React 组件树转换为 HTML 字符串。它不仅仅是"拼接 HTML"，还做了以下关键事情：

1. **组件生命周期执行**：执行所有组件的构造函数和渲染逻辑，处理 state、props、context
2. **数据绑定**：将 `getServerSideProps` 返回的数据注入组件 props，生成包含真实数据的 HTML
3. **Hydration 标记**：生成的 HTML 包含 React 用于 Hydration 的内部属性，使客户端 `hydrateRoot` 能正确"对接"
4. **安全转义**：自动处理 HTML 特殊字符的转义，防止 XSS
5. **一致性保证**：确保服务端渲染的输出和客户端 React 执行后的输出一致（前提是不使用客户端 API）

**Nami 中 SSRRenderer 的动态导入：**
```typescript
// 用 dynamic import + webpackIgnore 确保 react-dom/server 不被客户端 bundle 引入
const ReactDOMServer = await import(/* webpackIgnore: true */ 'react-dom/server');
const html = ReactDOMServer.renderToString(appElement);
```

**为什么用 `/* webpackIgnore: true */`？**
因为 `react-dom/server` 是纯 Node.js 模块，不应该出现在客户端 Bundle 中。这个注释告诉 Webpack 不要分析这个 import。

**源码参考：**
- `packages/core/src/renderer/ssr-renderer.ts` — render() 方法中的 renderToString 调用

---

## 题目 8：RendererFactory 使用了什么设计模式？为什么要这样设计？⭐⭐⭐

**答案：**

RendererFactory 使用了**工厂模式（Factory Pattern）**结合**模板方法模式（Template Method Pattern）**。

**工厂模式：**
```typescript
// RendererFactory.create() 根据 RenderMode 创建不同的渲染器实例
static create(options: CreateRendererOptions): BaseRenderer {
  switch (options.mode) {
    case RenderMode.CSR: return new CSRRenderer(options);
    case RenderMode.SSR:
      return options.preferStreaming
        ? new StreamingSSRRenderer(options)
        : new SSRRenderer(options);
    case RenderMode.SSG: return new SSGRenderer(options);
    case RenderMode.ISR: return new ISRRenderer(options);
    default:
      const exhaustiveCheck: never = options.mode; // 编译期穷举检查
      throw new RenderError(...);
  }
}
```

**模板方法模式：**
```
BaseRenderer（抽象基类）
├── render()          ← 抽象方法（子类实现具体渲染逻辑）
├── prefetchData()    ← 抽象方法（子类实现数据预取）
├── getMode()         ← 抽象方法（子类返回模式标识）
│
├── resolveAssets()   ← 通用实现（所有渲染器共享资源解析逻辑）
├── callPluginHook()  ← 通用实现（所有渲染器共享插件调用）
├── withTimeout()     ← 通用实现（所有渲染器共享超时包装）
└── createFallbackRenderer() ← 可覆写（定义降级链）
```

**为什么不用接口而用抽象类？**

因为需要在基类中共享实现代码。接口只能定义契约（方法签名），不能提供实现。但 `resolveAssets()`、`callPluginHook()`、`withTimeout()` 等方法在所有渲染器中逻辑相同，抽取到基类避免重复。

**`resolveAssets()` 的作用：**

负责把构建产物里的 JS/CSS 资源解析成最终可注入 HTML 的标签字符串，供所有渲染器复用。这样 `CSRRenderer`、`SSRRenderer`、`SSGRenderer`、`ISRRenderer` 在组装 HTML 时都不需要关心：

- 资源文件是否带 content hash
- 资源路径应该如何拼接 `publicPath`
- manifest 是从 `entrypoints`、`js/css` 还是 `files` 字段取值

它的实现分两层：

- `BaseRenderer.resolveAssets()` 负责统一入口：优先读取 `assetManifest`，没有 manifest 时降级到约定路径 `static/css/main.css` 和 `static/js/main.js`
- `ScriptInjector` 负责具体解析 manifest，生成 `<link rel="stylesheet">` 和 `<script defer>` 标签

这样设计的好处是：渲染器只关心"把哪些标签塞进 HTML"，而不关心"这些标签对应的真实构建文件名是什么"。

**`callPluginHook()` 的作用：**

负责在渲染生命周期中统一通知插件系统，例如：

- 渲染开始前触发 `beforeRender`
- 渲染成功后触发 `afterRender`
- 渲染失败时触发 `renderError`

它本身并不实现复杂的插件调度逻辑，而是作为渲染器和插件系统之间的一层安全封装：

- 如果没有配置 `pluginManager`，则直接跳过
- 如果有，就转发给 `pluginManager.callHook()`
- 如果插件执行报错，只记录 warning，不中断主渲染流程

底层 `PluginManager` 还会继续做两件事：

- 把旧钩子名映射成正式钩子名，例如 `beforeRender -> onBeforeRender`
- 以并行方式执行所有插件处理器，并做错误隔离

因此 `callPluginHook()` 的核心价值是：让所有渲染器都能以统一方式接入插件能力，同时保证"插件失败不能拖垮核心渲染链路"。

**`exhaustiveCheck: never` 的作用：**

TypeScript 的 never 类型技巧——如果未来新增了 `RenderMode` 枚举值但忘记在 switch 中处理，编译器会在 `const exhaustiveCheck: never = mode` 处报错，确保所有枚举值都被覆盖。

**源码参考：**
- `packages/core/src/renderer/index.ts` — RendererFactory
- `packages/core/src/renderer/base-renderer.ts` — BaseRenderer

---

## 题目 9：数据注水（Data Hydration）是什么？如何防止 XSS 攻击？⭐⭐⭐

**答案：**

**数据注水** 解决的核心问题是：服务端获取的数据如何传递给客户端？

```
服务端                                客户端
getServerSideProps()
  → { props: { title, items } }
  → 序列化为 JSON
  → 注入到 <script> 标签中              → 从 window.__NAMI_DATA__ 读取
  → 和 HTML 一起发送给浏览器              → React 组件用相同数据 Hydration
```

**具体实现：**

服务端在 HTML 中注入：
```html
<script>window.__NAMI_DATA__ = {"title":"商品列表","items":[...]}</script>
```

客户端读取：
```typescript
// packages/client/src/data/hydrate-data.ts
function readServerData() {
  if (typeof window !== 'undefined' && window.__NAMI_DATA__) {
    cachedData = { ...window.__NAMI_DATA__ }; // 缓存到内部变量
    return cachedData;
  }
  return {};
}
```

**为什么需要内部缓存？**
读取后会调用 `cleanupServerData()` 删除 `window.__NAMI_DATA__` 释放内存。但 `useNamiData` Hook 可能在清理之后才被调用，所以需要先缓存。

**XSS 防护：**

如果用户数据中包含 `</script><script>alert('xss')</script>`，会导致 HTML 解析器提前关闭 `<script>` 标签，注入恶意脚本。

`generateDataScript()` 对数据做安全序列化：
- `</script>` → `<\/script>`（转义闭合标签）
- `&`、`<`、`>` 等特殊字符转义
- 确保 JSON 数据不会"逃逸"出 `<script>` 标签

**源码参考：**
- `packages/core/src/renderer/ssr-renderer.ts` — generateDataScript()
- `packages/client/src/data/hydrate-data.ts` — readServerData(), cleanupServerData()
- `packages/client/src/data/use-nami-data.ts` — useNamiData Hook

---

## 题目 10：如何为一个页面选择合适的渲染模式？描述选型决策过程。⭐⭐

**答案：**

**决策树：**

```
需要 SEO 吗？
├── 否 → CSR（管理后台、内部工具）
└── 是 → 数据每次请求都需要最新吗？
    ├── 是 → 页面数据量大、有 Suspense 吗？
    │   ├── 是 → Streaming SSR（大型页面、Suspense 场景）
    │   └── 否 → SSR（电商首页、用户个人页）
    └── 否 → 数据多久更新一次？
        ├── 几乎不变 → SSG（文档、关于页、博客）
        └── 分钟/小时级 → ISR（商品详情、新闻列表）
```

**Nami 支持按路由粒度配置渲染模式：**

```typescript
// nami.config.ts
routes: [
  { path: '/', component: './pages/home', renderMode: 'ssr' },         // 首页用 SSR
  { path: '/about', component: './pages/about', renderMode: 'ssg' },   // 关于页用 SSG
  { path: '/products/:slug', component: './pages/product',
    renderMode: 'isr', revalidate: 300 },                              // 商品页用 ISR
  { path: '/admin', component: './pages/admin', renderMode: 'csr' },   // 后台用 CSR
]
```

**各模式对比：**

| 模式 | TTFB | 数据新鲜度 | SEO | 服务器成本 |
|------|------|-----------|-----|-----------|
| CSR | 最快 | 实时 | 差 | 最低 |
| SSR | 较慢 | 实时 | 好 | 最高 |
| SSG | 最快 | 构建时 | 好 | 最低 |
| ISR | 快 | 可配置 | 好 | 中等 |
| Streaming SSR | 中等 | 实时 | 好 | 较高 |
