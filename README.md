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
      return ctx;
    });

    api.onAfterRender(async (result) => {
      result.headers['X-Custom'] = 'hello';
      return result;
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
    cacheBackend: 'redis',
    redis: { host: '127.0.0.1', port: 6379 },
  },
});
```

---

## CLI 命令

```bash
nami dev        # 启动开发服务器（HMR）
nami build      # 生产构建（Client + Server + SSG）
nami start      # 启动生产服务器
nami generate   # SSG 静态页面生成
nami analyze    # 构建产物分析
nami info       # 输出环境信息
```

---

## 示例项目

仓库内包含 4 个示例，分别演示不同渲染模式：

| 示例 | 渲染模式 | 说明 |
|------|---------|------|
| `examples/basic-csr` | CSR | 交互式计数器 + 主题切换 |
| `examples/basic-ssr` | SSR | 文章列表 + 详情页（服务端数据预取） |
| `examples/basic-ssg` | SSG | 博客站点（构建时生成） |
| `examples/basic-isr` | ISR | 电商产品页（60s 自动重新生成） |

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
请求 →  timing           计时 + X-Response-Time
     →  security         安全头（CSP / HSTS / X-Frame-Options）
     →  requestContext   请求上下文 + requestId
     →  healthCheck      /_health 健康检查
     →  staticServe      静态资源服务
     →  [plugins]        插件中间件
     →  errorIsolation   错误隔离（防止单请求崩溃进程）
     →  isrCache         ISR 缓存层（命中则直接返回）
     →  render           核心渲染（路由匹配 + 数据预取 + 渲染）
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
