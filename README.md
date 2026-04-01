# Nami

<p align="center">
  <strong>集团级前端框架 — CSR / SSR / SSG / ISR 四种渲染模式统一方案</strong>
</p>

<p align="center">
  Koa 3 · React 18 · Webpack 5 · TypeScript
</p>

---

## 简介

Nami 是一个面向大规模前端团队的企业级框架，提供从开发、构建到部署的全链路解决方案。通过统一的渲染器抽象，在同一套代码中无缝切换 CSR（客户端渲染）、SSR（服务端渲染）、SSG（静态站点生成）、ISR（增量静态再生）四种模式，支撑 50+ 核心项目、日均 PV 过亿的生产规模。

### 核心特性

- **四种渲染模式** — BaseRenderer 统一抽象，RendererFactory 工厂模式，路由级渲染模式配置
- **流式 SSR** — 基于 React 18 `renderToPipeableStream`，Suspense 支持、更快的 TTFB、选择性 Hydration
- **插件系统** — waterfall / parallel / bail 三种钩子执行模式，覆盖构建、服务端、客户端全生命周期
- **ISR 引擎** — stale-while-revalidate 语义，可插拔缓存后端（Memory / FileSystem / Redis），后台重验证队列
- **多级降级** — 正常渲染 → 重试 → CSR 降级 → 骨架屏 → 静态 HTML → 503，逐级自动兜底
- **模块加载器** — ModuleLoader 桥接路由配置与 server bundle，自动解析 getServerSideProps / getStaticProps / getStaticPaths
- **智能路由匹配** — PathMatcher 支持优先级评分（静态 > 约束参数 > 动态参数 > 通配符）、正则约束、可选参数
- **Koa 中间件管线** — timing → security → requestContext → healthCheck → staticServe → [plugins] → errorIsolation → isrCache → render
- **集群模式** — Master/Worker 进程管理，崩溃自动重启，优雅停机
- **构建系统** — Client / Server / SSG / Dev 四套 Webpack 配置，持久化文件系统缓存，自定义 Loader 与 Plugin
- **CLI 工具** — `nami dev` / `build` / `start` / `generate` / `analyze` / `info` 一站式命令
- **脚手架** — `create-nami-app` 交互式项目初始化
- **测试体系** — Vitest 单元测试，覆盖渲染器、路由匹配、插件系统等核心模块

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      @nami/cli                          │
│              dev · build · start · generate             │
├──────────────────────┬──────────────────────────────────┤
│    @nami/server      │          @nami/client            │
│  Koa 中间件管线       │  Hydration · Router · Data Hook  │
│  ISR 引擎 · 集群      │  Head 管理 · 性能采集             │
│  PathMatcher 路由     │  Streaming SSR 支持              │
├──────────────────────┴──────────────────────────────────┤
│                      @nami/core                         │
│  渲染器：CSR / SSR / StreamingSSR / SSG / ISR            │
│  ModuleLoader · 插件系统 · 数据预取 · 配置 · 错误处理      │
├─────────────────────────────────────────────────────────┤
│                    @nami/webpack                        │
│  构建配置 · FS 缓存 · 自定义 Loader · Plugin · 代码分割   │
├─────────────────────────────────────────────────────────┤
│                    @nami/shared                         │
│           类型定义 · 常量 · 工具函数（零依赖）              │
└─────────────────────────────────────────────────────────┘
```

---

## 包结构

```
packages/
├── shared/                 # @nami/shared — 共享类型与工具（零依赖基础层）
├── core/                   # @nami/core — 核心运行时
│   ├── renderer/           #   渲染器：Base / CSR / SSR / SSG / ISR / StreamingSSR
│   ├── module/             #   模块加载器：ModuleLoader（server bundle → 页面导出函数）
│   ├── plugin/             #   插件系统：HookRegistry / PluginManager / PluginAPI
│   ├── data/               #   数据层：PrefetchManager / DataContext / Serializer
│   ├── config/             #   配置：ConfigLoader / ConfigValidator
│   ├── error/              #   错误：ErrorHandler / ErrorBoundary / Degradation
│   ├── html/               #   HTML：DocumentTemplate / HeadManager / ScriptInjector
│   └── router/             #   路由：RouteManager / RouteMatcher / PathMatcher / lazyRoute
├── server/                 # @nami/server — Koa SSR 服务
│   ├── middleware/         #   9 层中间件管线
│   ├── isr/                #   ISR 引擎 + 缓存存储
│   ├── cluster/            #   Master / Worker 集群
│   └── dev/                #   开发服务器 + HMR
├── client/                 # @nami/client — 客户端运行时
│   ├── hydration/          #   React 18 Hydration + 选择性 Hydration
│   ├── router/             #   NamiRouter / Link 预取 / useRouter
│   ├── data/               #   useNamiData / useClientFetch / DataHydrator
│   ├── head/               #   NamiHead（SSR + CSR 两种模式）
│   ├── error/              #   ClientErrorBoundary / ErrorOverlay
│   └── performance/        #   Web Vitals / Performance Mark
├── webpack/                # @nami/webpack — 构建配置
│   ├── configs/            #   base / client / server / ssg / dev
│   ├── rules/              #   TypeScript / CSS / Assets / SVG
│   ├── plugins/            #   Manifest / RouteCollect / SSR Externals
│   ├── loaders/            #   page-loader / data-fetch-loader
│   └── optimization/       #   SplitChunks / Terser
├── cli/                    # @nami/cli — 命令行工具
├── create-nami-app/        # create-nami-app — 项目脚手架
├── plugin-cache/           # @nami/plugin-cache — LRU / TTL / CDN 缓存策略
├── plugin-monitor/         # @nami/plugin-monitor — 性能、错误、渲染指标采集
├── plugin-skeleton/        # @nami/plugin-skeleton — 骨架屏组件 + 自动生成
├── plugin-request/         # @nami/plugin-request — 同构请求 + useRequest Hook
└── plugin-error-boundary/  # @nami/plugin-error-boundary — 路由级错误边界
```

---

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 8

### 使用脚手架创建项目

```bash
npx create-nami-app my-app
cd my-app
pnpm dev
```

交互式问答将引导你选择渲染模式（CSR / SSR / SSG / Full）和官方插件。

### 手动配置

```bash
pnpm add @nami/core @nami/client react react-dom
pnpm add -D @nami/cli @nami/webpack typescript
```

创建 `nami.config.ts`：

```typescript
import { defineConfig, RenderMode } from '@nami/core';

export default defineConfig({
  appName: 'my-app',
  defaultRenderMode: RenderMode.SSR,

  routes: [
    {
      path: '/',
      component: './pages/home',
      renderMode: RenderMode.SSR,
    },
    {
      path: '/about',
      component: './pages/about',
      renderMode: RenderMode.CSR,
    },
  ],

  server: {
    port: 3000,
  },

  plugins: [],
});
```

---

## 渲染模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **CSR** | 客户端渲染，服务端返回空 HTML Shell | 后台管理、SPA 应用 |
| **SSR** | 服务端渲染，每次请求实时生成 HTML | SEO 要求高、首屏性能敏感的页面 |
| **Streaming SSR** | 流式 SSR，基于 React 18 `renderToPipeableStream` | 大型页面、Suspense 密集页面、TTFB 敏感场景 |
| **SSG** | 构建时生成静态 HTML | 文档、博客等内容型站点 |
| **ISR** | 增量静态再生，后台自动重新生成过期页面 | 电商商品页、新闻列表等频繁更新的内容 |

每条路由可独立配置渲染模式，同一应用内可混合使用：

```typescript
routes: [
  { path: '/',         component: './pages/home',    renderMode: RenderMode.ISR  },
  { path: '/blog/:id', component: './pages/blog',    renderMode: RenderMode.SSG  },
  { path: '/app',      component: './pages/app',     renderMode: RenderMode.CSR  },
  { path: '/api/data', component: './pages/api',     renderMode: RenderMode.SSR  },
]
```

### Streaming SSR

Nami 支持 React 18 的流式 SSR，通过 `renderToPipeableStream` 实现边渲染边传输：

```
┌─────────────────────────────────────────────────────────────┐
│ 传统 SSR（renderToString）                                    │
│                                                             │
│ 服务端：[========= 渲染完成 =========]                         │
│ 客户端：                              [收到完整 HTML]          │
│                                                             │
│ Streaming SSR（renderToPipeableStream）                       │
│                                                             │
│ 服务端：[== shell ==][=== 内容流 ===][== Suspense 补丁 ==]     │
│ 客户端：            [shell]  [...内容]   [...Suspense 内容]    │
│         ↑ 更快的 TTFB                                        │
└─────────────────────────────────────────────────────────────┘
```

优势：
- **更快的 TTFB** — HTML `<head>` 和页面 Shell 立即发送，无需等待完整渲染
- **Suspense 支持** — `<Suspense>` 边界内容异步加载，先发送 fallback，数据就绪后发送补丁
- **选择性 Hydration** — 客户端可优先 hydrate 用户正在交互的部分
- **降级链** — Streaming SSR 失败 → 普通 SSR → CSR，三级自动兜底

当前接入方式：

```typescript
export default defineConfig({
  routes: [
    {
      path: '/dashboard',
      component: './pages/dashboard',
      renderMode: RenderMode.SSR,
      meta: {
        streaming: true,
      },
    },
  ],
});
```

说明：
- `Streaming SSR` 仍归属 `RenderMode.SSR`，通过路由级 `meta.streaming = true` 开启
- 仅在存在可执行的服务端渲染入口时生效（如 `entry-server.tsx`）
- `HEAD` 请求仍走普通 SSR 响应头路径，不启用流式输出

---

## 模块加载器

ModuleLoader 是连接路由配置与 server bundle 的桥梁，负责从编译产物中解析页面级导出函数：

```typescript
import { ModuleLoader } from '@nami/core';

const loader = new ModuleLoader({
  serverBundlePath: 'dist/server/entry-server.js',
});

// 从 server bundle 中提取页面的 getServerSideProps 函数
const gssp = await loader.getExportedFunction(
  './pages/home',           // 组件路径
  'getServerSideProps',     // 导出函数名
);

if (gssp) {
  const result = await gssp({ params: {}, query: {} });
  console.log(result.props); // 页面数据
}
```

模块查找策略（按优先级）：
1. 通过 moduleManifest 映射查找
2. 直接以组件路径为 key 查找
3. 标准化路径后查找（去前缀、加 pages/ 前缀等）
4. 兜底返回 bundle 自身（单模块场景）

---

## 数据预取

### SSR — getServerSideProps

```typescript
export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const data = await fetch('https://api.example.com/posts');
  return {
    props: { posts: await data.json() },
  };
}
```

### SSG / ISR — getStaticProps + getStaticPaths

```typescript
export async function getStaticPaths() {
  return {
    paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
    fallback: 'blocking',
  };
}

export async function getStaticProps(ctx: GetStaticPropsContext) {
  const post = await fetch(`https://api.example.com/posts/${ctx.params.id}`);
  return {
    props: { post: await post.json() },
    revalidate: 60, // ISR: 60 秒后重新生成
  };
}
```

---

## 插件系统

Nami 的插件系统支持 **waterfall**（串行管道）、**parallel**（并行执行）、**bail**（短路返回）三种钩子模式：

```typescript
import { defineConfig } from '@nami/core';
import cachePlugin from '@nami/plugin-cache';
import monitorPlugin from '@nami/plugin-monitor';
import requestPlugin from '@nami/plugin-request';

export default defineConfig({
  plugins: [
    cachePlugin({ strategy: 'lru', maxSize: 1000 }),
    monitorPlugin({ reportUrl: '/api/monitor', sampleRate: 0.1 }),
    requestPlugin({ baseURL: '/api', timeout: 10000 }),
  ],
});
```

### 官方插件

| 插件 | 说明 |
|------|------|
| `@nami/plugin-cache` | LRU / TTL / CDN 多级缓存策略 |
| `@nami/plugin-monitor` | 性能指标、错误、渲染数据采集 + Beacon 上报 |
| `@nami/plugin-skeleton` | 骨架屏组件库 + 自动生成 |
| `@nami/plugin-request` | 同构 HTTP 客户端 + 拦截器 + `useRequest` Hook |
| `@nami/plugin-error-boundary` | 路由级错误边界 + 5 级渐进降级 |

### 自定义插件

```typescript
import type { NamiPlugin } from '@nami/shared';

const myPlugin: NamiPlugin = {
  name: 'my-plugin',
  setup(api) {
    api.onBeforeRender(async (ctx) => {
      console.log(`Rendering: ${ctx.path}`);
    });

    api.onAfterRender(async (ctx, result) => {
      console.log(`Rendered: ${ctx.path}`);
      result.headers['X-Custom'] = 'hello';
    });
  },
};
```

---

## 路由匹配

Nami 内置两级路由匹配器：

### RouteMatcher（基础匹配器）

支持静态路径、动态参数 `:param`、可选参数 `:param?`、通配符 `*`。

### PathMatcher（高级匹配器）

在基础匹配能力之上增加：

- **优先级评分** — 自动选择最佳匹配，避免路由顺序依赖
- **正则约束** — `/user/:id(\\d+)` 限制参数必须为数字
- **多值通配符** — `/docs/:path+` 匹配一个或多个路径段

```
优先级评分算法：
  静态段（/about）     → 3 分
  带约束参数（:id(\\d+)）→ 2 分
  普通参数（:id）       → 1 分
  通配符（*）           → 0 分
  精确匹配加分         → +1 分

示例：请求 /user/profile
  /user/:id     → 得分 4（静态 3 + 参数 1）
  /user/profile → 得分 7（静态 3 + 静态 3 + 精确 1） ← 胜出
```

---

## 多级降级

当渲染出错时，Nami 自动执行五级降级：

```
L0 正常渲染
 ↓ 失败
L1 重试（可配置次数）
 ↓ 失败
L2 CSR 降级（返回空 Shell + JS）
 ↓ 失败
L3 骨架屏（预生成的 HTML 骨架）
 ↓ 失败
L4 静态兜底 HTML
 ↓ 失败
L5 503 Service Unavailable
```

---

## ISR 缓存架构

ISR 引擎支持三种可插拔的缓存后端：

| 缓存后端 | 适用场景 |
|---------|---------|
| **MemoryStore** | 单机开发 / 小规模部署 |
| **FileSystemStore** | 单机生产 / 持久化需求 |
| **RedisStore** | 多机集群 / 分布式部署 |

```typescript
export default defineConfig({
  isr: {
    enabled: true,
    defaultRevalidate: 60,
    cacheAdapter: 'redis',
    redis: { host: '127.0.0.1', port: 6379 },
  },
});
```

说明：
- 当前正式字段为 `cacheAdapter`
- 历史项目中的 `cacheStrategy` 仍兼容，会在 CLI 加载配置时自动归一化为 `cacheAdapter`
- 当默认渲染模式或任一路由使用 `ISR` 时，若未显式关闭，CLI 会自动开启 `isr.enabled`

---

## CLI 命令

```bash
nami dev        # 启动开发服务器（HMR）
nami build      # 生产构建（Client + Server + SSG/ISR 预生成，可配合 --analyze / --no-minimize）
nami start      # 启动生产服务器
nami generate   # SSG / ISR 静态页面生成（支持 --route 只生成指定路由）
nami analyze    # 构建产物分析
nami info       # 输出环境信息
```

补充说明：
- `nami build --analyze` 会为 client / server 构建注入 bundle report
- `nami build --no-minimize` 会关闭 client 侧压缩，便于排查产物问题
- `nami generate --route /foo --route /bar` 会只生成匹配到的 SSG / ISR 路由

---

## 路由预取与数据接口

客户端路由预取默认包含两条链路：

- **Chunk 预取** — 直接复用构建阶段生成的静态 import 工厂，支持动态路由匹配
- **数据预取** — 通过 `/_nami/data/*` 调用对应页面的 `getServerSideProps / getStaticProps`

例如：

```bash
curl http://localhost:3002/_nami/data/
curl http://localhost:3004/_nami/data/products/1001
```

这条接口主要服务于客户端 route prefetch，不替代业务 API。

---

## 示例项目

仓库内包含 4 个示例，分别演示不同渲染模式：

| 示例 | 渲染模式 | 说明 |
|------|---------|------|
| `examples/basic-csr` | CSR | 交互式计数器 + 主题切换 |
| `examples/basic-ssr` | SSR | 文章列表 + 详情页（服务端数据预取） |
| `examples/basic-ssg` | SSG | 博客站点（构建时生成） |
| `examples/basic-isr` | ISR | 电商产品页（首页 60s、列表/详情 30s 重验证，含 `getStaticPaths + fallback: 'blocking'` 动态预生成示例） |

```bash
# 克隆后运行示例
cd examples/basic-ssr
pnpm install
pnpm dev
```

---

## Koa 中间件管线

服务端请求按以下顺序经过中间件处理：

```
请求 →  shutdownAware    停机感知（停机中返回 503）
     →  timing           计时 + X-Response-Time
     →  security         安全头（CSP / HSTS / X-Frame-Options）
     →  requestContext   请求上下文 + requestId
     →  healthCheck      /_health 健康检查
     →  staticServe      静态资源服务
     →  dataPrefetch     `/_nami/data/*` 路由数据预取接口
     →  [plugins]        插件中间件
     →  errorIsolation   错误隔离（防止单请求崩溃进程）
     →  isrCache         ISR 缓存层（命中则直接返回）
     →  render           核心渲染（路由匹配 + 数据预取 + 渲染 + 插件 extra 消费）
→ 响应
```

---

## 技术栈

| 层次 | 技术 |
|------|------|
| UI 框架 | React 18（hydrateRoot / createRoot / renderToPipeableStream） |
| 服务端框架 | Koa 3 |
| 构建工具 | Webpack 5（持久化文件系统缓存） |
| 语言 | TypeScript 5（strict 模式） |
| 测试框架 | Vitest |
| 包管理 | pnpm workspace（Monorepo） |
| 版本管理 | Changesets |
| 代码规范 | ESLint + Prettier |

---

## 项目统计

- **12** 个包（packages）
- **4** 个示例项目
- **197** 个 TypeScript 源文件
- **44,000+** 行代码（含测试）

---

## 测试

Nami 使用 [Vitest](https://vitest.dev/) 作为测试框架，测试覆盖核心运行时模块：

```bash
# 运行所有测试
pnpm test

# 监听模式（开发时使用）
pnpm test:watch

# 生成覆盖率报告
pnpm test:coverage
```

测试模块覆盖：

| 模块 | 测试文件 | 覆盖内容 |
|------|---------|---------|
| RendererFactory | `core/tests/renderer-factory.test.ts` | 渲染器创建、降级链、模式判断 |
| RouteMatcher | `core/tests/route-matcher.test.ts` | 静态/动态/可选/通配符路径匹配 |
| CSRRenderer | `core/src/renderer/__tests__/csr-renderer.test.ts` | CSR 渲染流程 |

---

## 与 Next.js 的对比

Nami 的渲染模型和数据预取 API 高度借鉴了 Next.js（降低团队迁移和学习成本），但在中间件管线、插件系统、降级策略、缓存后端、部署模型等方面做了面向企业场景的重新设计。

### 相似之处

| 维度 | Next.js | Nami |
|------|---------|------|
| 多渲染模式 | CSR / SSR / SSG / ISR | 同样四种 + Streaming SSR |
| 路由级渲染配置 | 每个页面独立选择渲染模式 | 每条路由独立配置 `renderMode` |
| 数据预取 API | `getServerSideProps` / `getStaticProps` / `getStaticPaths` | 完全相同的三个 API 命名和语义 |
| ISR 语义 | `revalidate: 60` stale-while-revalidate | 同样的 SWR 语义 + 可插拔缓存后端 |
| Hydration | React 18 `hydrateRoot` | 同样基于 React 18 |
| 构建产物 | Client Bundle + Server Bundle | 同样双产物 + SSG 静态文件 |

### 核心差异

#### 服务端框架

| | Next.js | Nami |
|---|---------|------|
| 底层 | 自研 HTTP 服务器 | **Koa 3** |
| 中间件 | 自有 Middleware API（Edge Runtime） | 标准 Koa 中间件管线（9 层） |
| 影响 | 生态封闭，不能直接用 Express/Koa 中间件 | 可复用公司已有的 Koa 中间件资产 |

#### 构建工具

| | Next.js | Nami |
|---|---------|------|
| 构建器 | Turbopack + SWC | **Webpack 5**（持久化 FS 缓存） |
| 原因 | 追求极致开发体验 | 兼容企业已有的大量 Webpack Loader / Plugin |

#### 插件系统

| | Next.js | Nami |
|---|---------|------|
| 扩展方式 | `next.config.js` + `withXxx()` 包装函数 | 正式的 Plugin API（waterfall / parallel / bail 三种钩子） |
| 生命周期覆盖 | 主要覆盖构建阶段 | 覆盖构建 + 服务端 + 客户端全生命周期 |
| 隔离性 | 无 | 插件错误隔离，不影响核心渲染 |

#### 降级策略

| | Next.js | Nami |
|---|---------|------|
| SSR 失败 | 返回 500 错误页 | **5 级渐进降级**：重试 → CSR → 骨架屏 → 兜底 HTML → 503 |
| 设计理念 | 开发者自行处理 | 框架级保障"永远有内容返回" |

#### ISR 缓存后端

| | Next.js | Nami |
|---|---------|------|
| 默认 | 文件系统缓存 | Memory / FileSystem / **Redis** 可插拔 |
| 分布式 | 需要 Vercel 或第三方方案 | 原生支持 Redis 集群缓存 + tag 批量失效 |
| 按需失效 | `revalidatePath()` / `revalidateTag()` | `invalidate(path)` / `invalidateByTag(tag)` + 预热 |

#### 部署模型

| | Next.js | Nami |
|---|---------|------|
| 最佳实践 | Vercel（深度绑定） | **自建集群部署**（Master/Worker 进程管理） |
| 集群 | 依赖 K8s / PM2 | 内置 cluster 模式 + 优雅停机 |

### 何时选择 Next.js

- 团队规模较小（< 20 前端），维护自研框架的人力成本不划算
- 没有历史中间件包袱，可以使用 Vercel 部署
- 追求前沿特性（App Router、Server Components、Partial Prerendering）
- 招聘考量，Next.js 是市场主流，新人上手快

### 何时选择自研框架（Nami 的定位）

- **基础设施深度定制** — 公司有自己的鉴权、链路追踪、灰度、配置中心，需要深度集成到中间件管线
- **部署环境受限** — 不能用 Vercel，必须部署在内网/私有云；ISR 需要 Redis 集群做分布式缓存
- **稳定性要求极高** — 日均 PV 过亿场景下，5 级降级 > 500 错误页；插件错误隔离保障核心可用
- **大量 Webpack 资产** — 50+ 项目已有自定义 Loader / Plugin，Next.js 迁移到 Turbopack 后兼容性存疑
- **技术主权** — 不依赖单一商业公司的技术路线，框架升级节奏由自己掌控
- **统一技术栈治理** — 通过框架内置插件统一全公司的监控、错误上报、缓存策略

> 国内头部大厂（字节 Modern.js、阿里 ICE、腾讯 Hippy）都走了类似路线——借鉴社区方案的渲染模型，但用自己的服务端框架和部署基础设施重新实现。

---

## 架构改进日志

### v0.2.0 — P0/P1 缺陷修复

#### P0 — 核心功能修复

| 编号 | 问题 | 修复 |
|------|------|------|
| P0-1 | 插件 `context.extra` 写入后无人消费 | `render-middleware` 新增 `applyPluginExtras()`，读取 `__cache_hit`、`__skeleton_fallback`、`__custom_headers`、`__retry_attempted` 并映射到 HTTP 响应 |
| P0-2 | 渲染器硬编码 `static/css/main.css` / `static/js/main.js` | `BaseRenderer` 新增 `resolveAssets()` + `ScriptInjector`，优先从 `asset-manifest.json` 读取真实文件路径（含 content hash），CSR/SSR/SSG/ISR/StreamingSSR 全部切换 |
| P0-3 | `RouteManager.match()` 按注册顺序匹配，未使用 `rankRoutes` | 引入 `rankRoutes` 优先级排序（静态 > 约束参数 > 动态参数 > 通配符），带缓存，注册/移除时自动失效 |
| P0-4 | `SelectiveHydration` 未触发前渲染 `fallback \|\| null`，与 SSR HTML 不一致 | 未 hydrate 时使用 `suppressHydrationWarning` 保留服务端 DOM，不渲染子节点 |

#### P1 — 重要改进

| 编号 | 问题 | 修复 |
|------|------|------|
| P1-5 | `RedisStore` 只有 `disconnect()`，`ISRManager.close()` 无法正确关闭 | 新增 `close()` 别名方法，与 `CacheStore` 接口对齐 |
| P1-6 | 集群主进程用 `online` 事件判断 Worker 就绪，但此时端口尚未绑定 | 改为监听 `worker:ready` IPC 消息（Worker 在 `app.listen` 回调中发送） |
| P1-7 | `createShutdownAwareMiddleware` 已实现但未接入 `app.ts` | 注册为中间件管线最外层，停机时新请求返回 503 + `Connection: close` |
| P1-8 | SSG 单路由生成失败仅 `logger.error`，`BuildResult.errors` 为空 | 收集 `ssgErrors`，合并到 `BuildResult.errors`，CI 可感知 |
| P1-9 | `RevalidationQueue` 渲染失败时超时计时器未 `clearTimeout` | 将 `timeoutHandle` 提升到 `try` 外，`finally` 中统一清理 |
| P1-10 | `NamiHead` 在 SSR 分支 `return null` 后调用 `useEffect`，违反 Hooks 规则 | 移除条件 return，SSR 分支仅收集标签，`useEffect` 内部通过 `isSSR` 守卫跳过 DOM 操作 |

### v0.3.0 — 第二轮 P0/P1 缺陷修复

#### P0 — 核心功能修复

| 编号 | 问题 | 修复 |
|------|------|------|
| P0-1 | 集群模式 `startServer` 中 Worker 进程不发送 `worker:ready` | 在 `server.ts` 的 `app.listen` 回调中增加 `process.send({ type: 'worker:ready' })`，使主进程能正确感知 Worker 就绪 |
| P0-2 | `triggerShutdown` 未接入 `setupGracefulShutdown` 信号处理 | `GracefulShutdownOptions` 新增 `onSignalReceived` 回调，收到 SIGTERM/SIGINT 后首先激活 shutdownAware 中间件，再执行 server.close |
| P0-3 | `PluginManager.runParallelHook` 失败统计永远为 0 | `handleHookError` 记录日志后 re-throw，使 `Promise.allSettled` 能正确感知 rejected 状态；`dispose()` 同步修复 |
| P0-4 | `DegradationManager` CSR fallback 缺少 JS/CSS 引用 | 构造函数接受 `publicPath` 和 `assetManifest`，`createCSRFallback` 通过 `resolveAssets()` 注入正确的资源标签 |

#### P1 — 重要改进

| 编号 | 问题 | 修复 |
|------|------|------|
| P1-5 | `startWorker` 优雅停机不释放 ISR / 插件资源 | 解构 `createNamiServer` 返回值获取 `pluginManager`、`isrManager`、`triggerShutdown`，在 `onShutdown` 中依次关闭 ISR → 销毁插件 |
| P1-6 | 渲染器降级链未传递 `assetManifest` | `StreamingSSR → SSR → CSR`、`ISR → CSR`、`SSG → CSR` 四处 `createFallbackRenderer` 均传递 `this.assetManifest` |
| P1-7 | `lazyRoute` `errorFallback` 选项声明但未实现 | 内置轻量 `LazyErrorBoundary`（React Error Boundary），当提供 `errorFallback` 时包裹 Suspense 树 |
| P1-9 | ISR 后台重验证写入缓存 TTL 与主路径不一致 | `RevalidationQueue.executeJob` 的 `cacheStore.set` TTL 从 `revalidateSeconds` 改为 `revalidateSeconds * 2`，与 `ISRManager.getOrRevalidate` 对齐 |

---

## 开发

```bash
# 克隆仓库
git clone https://github.com/liuwentong01/Nami.git
cd Nami

# 安装依赖
pnpm install

# 类型检查
pnpm typecheck

# 构建所有包
pnpm build

# 运行测试
pnpm test

# 代码格式化
pnpm format
```

---

## License

MIT
