# 架构设计深度解析

本文档面向框架开发者和架构师，详细讲解 Nami 的整体架构、包依赖关系、请求生命周期和关键设计决策。读完后你将理解：

- 为什么代码要这样组织
- 一个 HTTP 请求从进入到返回经历了什么
- 关键设计决策背后的 trade-off

---

## 1. Monorepo 包结构

Nami 采用 pnpm workspace monorepo 组织，各包遵循**单一职责**原则：

```
packages/
├── shared/        零依赖 — 类型、常量、工具函数
├── core/          纯逻辑 — 渲染器、路由、插件、配置、错误
├── server/        Koa 服务 — 中间件、ISR、集群、优雅停机
├── client/        浏览器端 — Hydration、路由、数据、Head
├── webpack/       构建系统 — 配置工厂、Loader、Plugin
├── cli/           命令行 — dev / build / start / generate / analyze
├── create-nami-app/ 脚手架
├── plugin-cache/     缓存插件
├── plugin-monitor/   监控插件
├── plugin-request/   请求插件
├── plugin-skeleton/  骨架屏插件
└── plugin-error-boundary/ 错误边界插件
```

### 依赖关系图

```
                    @nami/shared  ← 所有包都依赖
                    ┌─────┴─────┐
               @nami/core    @nami/client
                 ↑    ↑          ↑
    ┌────────────┤    │          │
    │            │    │          │
@nami/server  @nami/webpack  @nami/cli
    ↑                            ↑
    └────────────────────────────┘
                  │
            @nami/cli (编排层)
```

**设计原则**：
- `shared` 不依赖任何包 — 纯类型和工具，是所有包的「共同语言」
- `core` 不依赖 `server` — 避免循环依赖，通过接口（`PluginManagerLike`、`ISRManagerLike`、`ModuleLoaderLike`）解耦
- `client` 不依赖 `server` — 纯浏览器端代码，不能引入 Node.js API
- `server` 依赖 `core` — 服务层组装核心能力
- `cli` 是顶层编排者 — 串联所有包

> **为什么 core 不直接依赖 server？**
> 因为 `core` 中的渲染器（`ISRRenderer`、`SSRRenderer`）需要与 ISR 缓存和模块加载器交互，但这些是 `server` 包的实现。如果 `core` 依赖 `server`，就会形成循环依赖（`server` → `core` → `server`）。解决方案是在 `core` 中定义接口（如 `ISRManagerLike`、`ModuleLoaderLike`），由 `server` 提供实现，在运行时通过依赖注入传入。这就是**依赖倒置原则**的应用。

## 2. 核心抽象与设计模式

### 2.1 渲染器（模板方法 + 工厂 + 降级链）

```
                 BaseRenderer (抽象基类)
                ┌─────┴──────────────┐
                │ render()           │ ← 抽象方法
                │ prefetchData()     │ ← 抽象方法
                │ getMode()          │ ← 抽象方法
                │ createFallbackRenderer() │ ← 可覆写
                │                    │
                │ resolveAssets()    │ ← 通用实现
                │ callPluginHook()   │ ← 通用实现
                │ withTimeout()      │ ← 通用实现
                └────────────────────┘
         ┌──────────┬──────────┬──────────┬──────────┐
    CSRRenderer  SSRRenderer  SSGRenderer ISRRenderer StreamingSSRRenderer
    fallback:   fallback:    fallback:   fallback:   fallback:
    null        CSR          CSR         CSR         SSR → CSR
```

**降级链**：Streaming SSR → 普通 SSR → CSR → null（终点）。每个渲染器的 `createFallbackRenderer()` 返回下一级渲染器，`assetManifest` 沿链传递确保降级后的资源引用正确。

```
举例：Streaming SSR 渲染失败
  1. StreamingSSRRenderer.render() 抛出异常
  2. 调用 createFallbackRenderer() → 得到 SSRRenderer 实例
  3. SSRRenderer.render() 也失败
  4. 调用 createFallbackRenderer() → 得到 CSRRenderer 实例
  5. CSRRenderer.render() → 返回空壳 HTML（此时不会再失败，因为不执行 React 渲染）
```

**RendererFactory**：`RendererFactory.create(options)` 根据 `RenderMode` 选择具体渲染器实现，是服务端和 CLI 的统一入口。上层代码不需要知道具体是哪个渲染器，只需要调用 `renderer.render(context)`。

### 2.2 插件系统（观察者 + 策略）

```
NamiPlugin.setup(api)
      │
      ▼
PluginAPIImpl ──注册──▶ HookRegistry
      │                    │
      │              handlers: Map<hookName, HookHandler[]>
      │                    │
      │        ┌───────────┼───────────┐
      ▼        ▼           ▼           ▼
PluginManager.runWaterfallHook()  .runParallelHook()  .runBailHook()
```

三种钩子模式：
- **Waterfall**：`modifyWebpackConfig`、`modifyRoutes`、`wrapApp` — 前一个的输出是下一个的输入
- **Parallel**：`onBeforeRender`、`onAfterRender` 等 — 全部并发执行（`Promise.allSettled`）
- **Bail**：未来扩展用 — 第一个返回非空值即为最终结果

**错误隔离**：单个插件的钩子失败不会中断整个钩子链，仅记录日志并异步触发 `onError` 钩子。

### 2.3 路由匹配（优先级排序 + 编译缓存）

```
path-matcher.ts
  compilePath(pattern) → CompiledMatcher (缓存在 ruleCache，上限 1024)
  matchPath(pattern, path) → PathMatchResult | null
  rankRoutes(routes) → 按优先级排序

    评分规则:
    ┌─────────────┬───────┐
    │ 段类型       │ 分值  │
    ├─────────────┼───────┤
    │ 静态 /users │  3    │
    │ 约束 :id(\\d+)│  2  │
    │ 动态 :id    │  1    │
    │ 通配 *      │  0    │
    │ 无通配符加分 │ +1    │
    └─────────────┴───────┘

RouteManager
  → getRankedRoutes() (带缓存)
  → match(path): 逐条 matchPath + 递归 children
```

**单一匹配源**：服务端 `route-match.ts` 的 `matchConfiguredRoute` 被 ISR 缓存中间件、渲染中间件和数据预取中间件共用，确保三者命中同一条路由。

## 3. 请求生命周期（SSR 模式）

一个 HTTP GET 请求在 Nami 中的完整旅程：

```
                           浏览器 GET /products/123
                                    │
    ┌───────────────────────────────┼───────────────────────────┐
    │                           Koa Server                      │
    │                                                           │
    │  ①  shutdownAware  ─ 停机中? → 503                        │
    │           │                                               │
    │  ②  timing  ─ 记录 process.hrtime                         │
    │           │                                               │
    │  ③  security  ─ 设置安全响应头                              │
    │           │                                               │
    │  ④  requestContext  ─ 生成 requestId、创建 logger           │
    │           │                                               │
    │  ⑤  healthCheck  ─ path === /_health? → 短路返回           │
    │           │                                               │
    │  ⑥  staticServe  ─ 匹配 dist/client 静态文件? → 短路返回    │
    │           │                                               │
    │  ⑦  dataPrefetch  ─ path 以 /__nami_data/ 开头? → JSON 返回│
    │           │                                               │
    │  ⑧  [用户中间件]  ─ config.server.middlewares              │
    │           │                                               │
    │  ⑨  [插件中间件]  ─ pluginManager.getServerMiddlewares()   │
    │           │                                               │
    │  ⑩  errorIsolation  ─ try/catch 包裹下游                   │
    │           │                                               │
    │  ⑪  isrCacheMiddleware  ─ ISR 路由? 缓存命中? → 短路返回    │
    │           │ (缓存未命中或非 ISR 路由)                        │
    │           │                                               │
    │  ⑫  renderMiddleware                                      │
    │      │                                                    │
    │      ├── matchConfiguredRoute(path, routes)                │
    │      ├── 构造 RenderContext                                │
    │      ├── RendererFactory.create({ mode, ... })            │
    │      ├── renderer.render(context)                          │
    │      │     ├── callPluginHook('beforeRender')             │
    │      │     ├── prefetchData() (getServerSideProps)        │
    │      │     ├── renderToString() / renderToPipeableStream  │
    │      │     ├── assembleHTML() + resolveAssets()            │
    │      │     └── callPluginHook('afterRender')              │
    │      ├── applyPluginExtras(renderContext.extra)            │
    │      └── setResponse(ctx, result)                         │
    │                                                           │
    │  timing ← 写入 X-Response-Time                             │
    │  security ← 写入 Cache-Control                             │
    │                                                           │
    └───────────────────────────────────────────────────────────┘
                                    │
                           浏览器收到完整 HTML
                                    │
                           加载 JS → Hydration
```

### 渲染失败时的降级流程

```
renderer.render() 失败
        │
        ▼
检查 context.extra.__skeleton_fallback? → 有则返回骨架屏
        │ 没有
        ▼
DegradationManager.executeWithDegradation()
  Level 0: 已失败
  Level 1: 重试 (maxRetries 次)
  Level 2: CSR 降级（空壳 HTML + JS/CSS）
  Level 3: 骨架屏（route.skeleton 配置）
  Level 4: 静态 HTML（fallback.staticHTML）
  Level 5: 503 服务不可用
```

## 4. 构建流程

```
nami build
    │
    ▼
NamiBuilder.build('production')
    │
    ├── 1. 清理 dist/
    ├── 2. prepareBuildContext()
    │      └── pluginManager.runWaterfallHook('modifyRoutes', routes)
    │
    ├── 3. 分析路由 → 决定构建任务
    │      CSR 路由 → client 构建
    │      SSR/ISR 路由 → client + server 构建
    │      SSG 路由 → client + server + ssg 构建
    │
    ├── 4. 生成代码
    │      .nami/generated-route-modules.ts  (路由→组件映射)
    │      .nami/generated-core-client-shim.ts (精简 @nami/core)
    │
    ├── 5. 创建 Webpack 配置
    │      ├── createClientConfig()  → dist/client/
    │      ├── createServerConfig()  → dist/server/
    │      └── createSSGConfig()     → 复用 server 配置
    │
    ├── 6. pluginManager.runWaterfallHook('modifyWebpackConfig', config)
    │
    ├── 7. 并行执行 webpack 编译
    │
    ├── 8. SSG 路由 → generateStaticPages()
    │      ├── require('dist/server/entry-server.js')
    │      ├── 对每个静态路径调用 renderToString
    │      └── 写入 dist/client/xxx.html
    │
    └── 9. 写入 nami-manifest.json (路由→渲染模式映射)
```

### 关键构建产物

```
dist/
├── client/                    # 浏览器端产物
│   ├── static/
│   │   ├── js/
│   │   │   ├── main.[hash].js
│   │   │   ├── vendor.[hash].js
│   │   │   └── runtime.[hash].js
│   │   └── css/
│   │       └── main.[hash].css
│   ├── asset-manifest.json    # 文件名 → URL 映射
│   └── *.html                 # SSG 生成的静态页面
│
├── server/                    # 服务端产物
│   ├── entry-server.js        # 服务端入口（含 createAppElement / renderToHTML）
│   └── [page-chunks].js       # 页面级 server 代码
│
└── nami-manifest.json         # 路由→渲染模式 映射表
```

## 5. 集群架构

```
                    ┌─────────────────────┐
                    │    主进程 (Master)    │
                    │                     │
                    │  cluster.fork() × N │
                    │  监听 worker:ready  │
                    │  SIGTERM → 通知所有  │
                    │  worker 退出 → 重启  │
                    └──────┬──────────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
     ┌──────────┐   ┌──────────┐   ┌──────────┐
     │ Worker 1 │   │ Worker 2 │   │ Worker N │
     │          │   │          │   │          │
     │ Koa App  │   │ Koa App  │   │ Koa App  │
     │ 独立内存  │   │ 独立内存  │   │ 独立内存  │
     │ 共享端口  │   │ 共享端口  │   │ 共享端口  │
     └──────────┘   └──────────┘   └──────────┘
```

**就绪语义**：Worker 在 `app.listen` 回调中（端口已绑定）发送 `{ type: 'worker:ready' }` IPC 消息，而非仅依赖 `online` 事件（此时端口可能尚未绑定）。

**优雅停机**：
1. 主进程收到 SIGTERM → 向所有 Worker 发送 SIGTERM
2. Worker 收到 SIGTERM → `onSignalReceived()` 激活 shutdownAware 中间件 → 新请求 503
3. Worker `server.close()` → 等待进行中请求完成（或超时）
4. Worker 执行清理：ISR 关闭 → 插件 dispose → 自定义 onShutdown
5. Worker `process.exit(0)`
6. 主进程等待所有 Worker 退出（35 秒强制超时）

## 6. 同构（Isomorphic）设计

Nami 的同构边界通过以下机制管理：

### 数据注水（Data Hydration）

SSR 页面需要解决一个核心问题：**服务端获取的数据如何传递给客户端？**

答案是将数据序列化为 JSON，注入到 HTML 的 `<script>` 标签中，客户端 JavaScript 加载后读取这个全局变量。这个过程被称为「数据注水」：

```
服务端                              客户端
────                              ────
getServerSideProps()
   │ 返回 { props: { title, items } }
   ▼
context.initialData = { title, items }
   │
   ▼
generateDataScript(data)           window.__NAMI_DATA__ = { title, items }
   │ (XSS 安全序列化:                     │ (JSON 反序列化为 JS 对象)
   │  将 </script> 等危险字符转义)         │
   ▼                                     ▼
<script>window.__NAMI_DATA__=...</script>  hydrateData('__NAMI_DATA__')
   │                                     │ (从 window 上读取数据)
   ▼                                     ▼
renderToString(<App data={data} />)       hydrateRoot(<App data={data} />)
   │ (服务端用数据渲染出完整 HTML)          │ (客户端用相同数据重新执行一遍 React)
```

> **为什么需要 XSS 安全序列化？** 因为数据会被嵌入到 `<script>` 标签中。如果数据中包含 `</script>` 字符串，会导致 HTML 解析器提前关闭 script 标签，可能被利用执行恶意代码。`generateDataScript()` 会转义这些危险字符。

### 服务端代码剥离

Webpack 的 `data-fetch-loader` 在客户端构建时将 `getServerSideProps`、`getStaticProps`、`getStaticPaths` 替换为空实现，防止敏感服务端逻辑进入浏览器 Bundle。

### 客户端 Bundle 瘦身

`client.config.ts` 生成 `@nami/core-client-shim`，只导出客户端需要的 `PluginManager`、`NamiDataProvider`、`matchPath`，而非整个 `@nami/core`（含渲染器、配置加载等服务端代码）。

## 7. 关键设计决策

| 决策 | 原因 |
|------|------|
| Koa 而非 Express | Koa 的洋葱模型天然适合中间件管线；async/await 优先 |
| 抽象类而非接口做渲染器基类 | 需要共享实现代码（模板方法模式） |
| `asset-manifest.json` 解析资源 | 支持 content hash 长期缓存，避免硬编码文件名 |
| ISR 中间件与渲染中间件分离 | ISR 命中缓存时可短路，不需要进入渲染器 |
| `Promise.allSettled` 执行并行钩子 | 确保所有插件都有执行机会，单个失败不影响整体 |
| 路由优先级评分（而非注册顺序） | 静态路由 > 动态路由 > 通配，符合直觉且不依赖注册顺序 |
| Worker `worker:ready` IPC 而非 `online` | `online` 只表示进程启动，不保证端口已绑定 |
| 降级管理器接受 `assetManifest` | CSR fallback 需要正确的 JS/CSS 引用，否则页面空白 |

---

## 下一步

- 想深入各渲染模式的原理？→ [五种渲染模式](./rendering-modes.md)
- 想了解中间件管线细节？→ [服务器与中间件](./server-and-middleware.md)
- 想了解构建系统？→ [构建系统](./webpack-build.md)
