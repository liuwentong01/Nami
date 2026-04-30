# Nami 框架学习文档

> Nami 是一个基于 React 18 + Koa + Webpack 的全栈同构渲染框架，支持 CSR / SSR / SSG / ISR / Streaming SSR 五种渲染模式，提供 Vite 风格的插件系统、5 级降级保护、集群部署和增量静态再生等企业级能力。

本文档体系面向开发人员培训，目标是让你**不仅会用 Nami，还能理解背后的原理**。每篇文档都包含：代码示例、原理图解、常见误区和最佳实践。

---

## 文档索引

| 文档 | 内容 | 适合谁 |
|------|------|--------|
| [快速上手](./quick-start.md) | 项目创建、配置编写、CLI 命令、第一个页面 | 所有开发人员 |
| [架构设计](./architecture.md) | Monorepo 结构、包依赖、请求生命周期、数据流 | 架构师、核心开发 |
| [五种渲染模式](./rendering-modes.md) | CSR / SSR / SSG / ISR / Streaming SSR 原理与选型 | 全栈开发 |
| [插件系统](./plugin-system.md) | 钩子机制、编写插件、官方插件、最佳实践 | 插件开发者 |
| [路由系统](./routing.md) | 路由配置、匹配算法、懒加载、数据预取 | 前端开发 |
| [ISR 与缓存](./isr-and-caching.md) | SWR 策略、三种缓存后端、按需失效、缓存预热 | 后端 / 运维 |
| [服务器与中间件](./server-and-middleware.md) | Koa 中间件管线、集群模式、优雅停机 | 后端开发 / 运维 |
| [构建系统](./webpack-build.md) | Webpack 配置、Loader、Plugin、代码分割 | 构建工程师 |
| [错误处理与降级](./error-and-degradation.md) | 5 级降级策略、Error Boundary、错误上报 | 全栈开发 |

---

## 框架全景图

```
┌─────────────────────────────────────────────────────────────┐
│                       nami.config.ts                        │
│              （应用配置：路由、渲染模式、插件）                  │
└─────────────────────┬───────────────────────────────────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │  nami    │ │  nami    │ │  nami    │
   │  build   │ │  dev     │ │  start   │
   │ (CLI)    │ │ (CLI)    │ │ (CLI)    │
   └────┬─────┘ └────┬─────┘ └────┬─────┘
        │            │            │
        ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌───────────────────────┐
   │ @nami/   │ │ Dev      │ │ Koa Server            │
   │ webpack  │ │ Server   │ │ (中间件管线)            │
   │ Builder  │ │ + HMR    │ │                       │
   └────┬─────┘ └──────────┘ │ shutdown → timing →   │
        │                    │ security → context →   │
        ▼                    │ health → static →      │
   ┌──────────┐              │ dataPrefetch → user →  │
   │ dist/    │              │ plugin → errorIso →    │
   │ client/  │              │ ISR cache → render     │
   │ server/  │              └───────────┬───────────┘
   └──────────┘                          ▼
                              ┌────────────────────┐
                              │   @nami/core        │
                              │ RendererFactory     │
                              │ CSR│SSR│SSG│ISR│    │
                              │ StreamingSSR        │
                              └────────┬───────────┘
                                       │
                              ┌────────┴───────────┐
                              │   DegradationMgr   │
                              │ L0→L1→L2→L3→L4→L5  │
                              └────────────────────┘
```

---

## 核心概念速览

### 渲染模式

| 模式 | 全称 | 渲染发生在 | 适用场景 |
|------|------|-----------|---------|
| **CSR** | Client-Side Rendering | 浏览器 | 管理后台、内部工具 |
| **SSR** | Server-Side Rendering | 每次请求时服务端 | 需要 SEO + 实时数据 |
| **SSG** | Static Site Generation | 构建时 | 博客、文档、营销页 |
| **ISR** | Incremental Static Regeneration | 构建时 + 后台增量更新 | 电商商品页、新闻 |
| **Streaming SSR** | Streaming Server-Side Rendering | 每次请求时流式发送 | 大型页面、Suspense |

### 包结构

| 包 | 职责 |
|----|------|
| `@nami/shared` | 类型定义、常量、工具函数（零依赖） |
| `@nami/core` | 渲染器、路由、插件管理、配置、错误处理 |
| `@nami/server` | Koa 服务器、中间件管线、ISR、集群 |
| `@nami/client` | 客户端入口、Hydration、路由、数据读取 |
| `@nami/webpack` | Webpack 构建配置、Loader、Plugin |
| `@nami/cli` | 命令行工具（dev / build / start / generate / analyze / info） |
| `create-nami-app` | 项目脚手架 |
| `plugin-*` | 官方插件（cache / monitor / request / skeleton / error-boundary） |

### 插件生命周期

```
构建阶段                服务端阶段                客户端阶段
────────               ────────                ────────
modifyRoutes      →    onServerStart      →    onClientInit
modifyWebpackConfig    onRequest               wrapApp
onBuildStart           onBeforeRender          onHydrated
onBuildEnd             onAfterRender           onRouteChange
                       onRenderError

                  通用：onError / onDispose
```

---

## 学习路径建议

### 路径一：业务开发者（1-2 天）

1. [快速上手](./quick-start.md) — 创建项目、写配置、启动开发
2. [五种渲染模式](./rendering-modes.md) — 理解各模式差异，为页面选择合适模式
3. [路由系统](./routing.md) — 路由配置、数据预取、懒加载
4. [错误处理与降级](./error-and-degradation.md) — 了解框架的容错保障

### 路径二：框架开发者 / 插件作者（3-5 天）

1. 先走完路径一
2. [架构设计](./architecture.md) — 理解整体架构和数据流
3. [插件系统](./plugin-system.md) — 掌握钩子机制，编写自定义插件
4. [服务器与中间件](./server-and-middleware.md) — 理解 Koa 中间件管线
5. [构建系统](./webpack-build.md) — 理解构建流程和产物

### 路径三：运维 / SRE（1-2 天）

1. [快速上手](./quick-start.md) — 了解部署命令
2. [服务器与中间件](./server-and-middleware.md) — 集群、优雅停机、健康检查、K8s/PM2 部署
3. [ISR 与缓存](./isr-and-caching.md) — 缓存策略、Redis 配置、按需失效

---

## 常见问题

### Q: 我的页面应该用什么渲染模式？

问自己三个问题：
1. **需要 SEO 吗？** 不需要 → CSR
2. **数据需要每次请求都最新吗？** 是 → SSR，否 → 继续
3. **数据多久更新一次？** 几乎不变 → SSG，分钟/小时级 → ISR

详见 [五种渲染模式 · 选型决策树](./rendering-modes.md#渲染模式选型决策树)

### Q: ISR 和 SSR 可以混用吗？

可以。Nami 支持**按路由粒度**设置渲染模式。同一个项目中，首页用 SSR，商品详情页用 ISR，关于页用 SSG，后台用 CSR，完全没问题。

### Q: 插件报错会导致页面渲染失败吗？

不会。插件钩子执行被 try/catch 包裹，单个插件失败只会打 warn 日志，不会中断渲染流程。详见 [插件系统 · 错误隔离](./plugin-system.md#4-钩子执行模式深度解析)
