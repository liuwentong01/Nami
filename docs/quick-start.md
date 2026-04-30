# 快速上手

本文档帮助你在 10 分钟内创建第一个 Nami 项目并理解核心工作流。读完后，你将能够：

- 创建并运行一个 Nami 项目
- 理解配置文件中各字段的含义
- 编写 SSR/SSG/ISR/CSR 四种模式的页面
- 使用数据预取、路由导航和 Head 管理

---

## 1. 创建项目

```bash
# 使用脚手架创建项目
npx create-nami-app my-app

# 交互式选择：
# - 模板类型: csr / ssr / ssg / full
# - 官方插件: cache / monitor / skeleton / error-boundary / request
```

脚手架会生成以下结构：

```
my-app/
├── src/
│   ├── pages/
│   │   ├── home.tsx          # 首页组件
│   │   └── about.tsx         # 关于页
│   ├── layouts/
│   │   └── default.tsx       # 默认布局
│   ├── entry-client.tsx      # 客户端入口
│   ├── entry-server.tsx      # 服务端入口（SSR/SSG 模式）
│   └── global.css            # 全局样式
├── nami.config.ts            # 框架配置文件
├── tsconfig.json
└── package.json
```

## 2. 核心配置文件

`nami.config.ts` 是整个项目的配置中心。下面逐段讲解每个配置项的含义和选型思路：

```typescript
// nami.config.ts
import { defineConfig } from '@nami/core';

export default defineConfig({
  // ===== 基础信息 =====
  // 应用名称 — 用于日志前缀和监控标识，建议和项目名一致（必填）
  appName: 'my-app',

  // 默认渲染模式 — 路由未显式指定 renderMode 时使用此值
  // 大多数项目选 'ssr'（兼顾 SEO 和数据新鲜度）
  defaultRenderMode: 'ssr',

  // ===== 路由配置 =====
  // 每条路由指定：URL 路径 → 组件文件 → 渲染模式 → 数据预取函数
  routes: [
    {
      path: '/',
      component: './pages/home',       // 相对于 srcDir（默认 'src'）
      renderMode: 'ssr',               // 每次请求在服务端渲染
      getServerSideProps: 'getServerSideProps', // 对应组件文件中的导出函数名
    },
    {
      path: '/about',
      component: './pages/about',
      renderMode: 'ssg',               // 构建时生成静态 HTML，运行时直接返回
    },
    {
      path: '/blog/:slug',             // :slug 是动态参数，匹配 /blog/hello-world
      component: './pages/blog-detail',
      renderMode: 'isr',               // 首次请求渲染并缓存，过期后后台重新生成
      revalidate: 60,                  // 60 秒后标记为过期，触发后台重验证
      getStaticProps: 'getStaticProps',
      getStaticPaths: 'getStaticPaths', // 声明构建时需要预生成的路径
    },
    {
      path: '/dashboard',
      component: './pages/dashboard',
      renderMode: 'csr',               // 服务端返回空壳 HTML，浏览器端渲染
    },
  ],

  // ===== 服务端配置 =====
  server: {
    port: 3000,
    host: '0.0.0.0',              // 0.0.0.0 = 监听所有网卡（Docker / K8s 必须）
    ssrTimeout: 5000,             // SSR 渲染超时（毫秒），超时自动降级
    gracefulShutdown: true,       // 启用优雅停机（收到 SIGTERM 后等待进行中请求完成）
    gracefulShutdownTimeout: 30000, // 优雅停机等待上限，应 < K8s terminationGracePeriodSeconds
  },

  // ===== ISR 配置 =====
  isr: {
    enabled: true,
    cacheAdapter: 'memory',       // 开发用 memory，单机多进程用 filesystem，多机用 redis
    defaultRevalidate: 60,        // 路由未指定 revalidate 时的默认值（秒）
  },

  // ===== 降级配置 =====
  // SSR 渲染失败时的容错策略
  fallback: {
    ssrToCSR: true,               // SSR 失败自动降级到 CSR（空壳 HTML + JS）
    maxRetries: 1,                // 渲染失败后重试 1 次（应对瞬时故障）
    timeout: 5000,                // 降级流程超时
  },

  // ===== 静态资源 =====
  assets: {
    publicPath: '/',              // CDN 前缀，如 'https://cdn.example.com/'
    hash: true,                   // 开启 content hash（如 main.abc123.js）实现长期缓存
  },

  // ===== 构建与客户端注入 =====
  webpack: {
    client: (config) => config,    // 修改浏览器端 Webpack 配置
    server: (config) => config,    // 修改 Node 端 Webpack 配置
  },
  monitor: {
    enabled: false,
    sampleRate: 1,
    webVitals: true,
    renderMetrics: true,
  },
  env: {
    NAMI_PUBLIC_API_BASE: '/api',  // NAMI_PUBLIC_ 前缀会被注入客户端代码
  },
  title: 'My Nami App',            // 默认页面标题
  description: 'Powered by Nami',  // 默认页面描述
  // htmlTemplate: './src/document.html',

  // ===== 插件 =====
  plugins: [
    // 可以是插件实例，如 new NamiCachePlugin({...})
    // 也可以是插件包名字符串，如 '@nami/plugin-monitor'
  ],
});
```

> **提示**：`defineConfig` 提供 TypeScript 类型提示，你可以在 IDE 中获得所有配置项的自动补全和类型检查。

## 3. 编写页面组件

### SSR 页面（带数据预取）

```typescript
// src/pages/home.tsx
import React from 'react';

interface HomeProps {
  title: string;
  items: Array<{ id: number; name: string }>;
}

export default function Home({ title, items }: HomeProps) {
  return (
    <div>
      <h1>{title}</h1>
      <ul>
        {items.map(item => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 服务端数据预取函数
 *
 * - 仅在服务端执行，不会进入客户端 Bundle
 * - 每次请求都会调用
 * - 返回的 props 会注入到组件 props 中
 * - 也会被序列化到 HTML 中供客户端 Hydration 读取
 */
export async function getServerSideProps(ctx) {
  const { params, query, headers } = ctx;

  const res = await fetch('https://api.example.com/items');
  const items = await res.json();

  return {
    props: {
      title: '首页',
      items,
    },
  };
}
```

### SSG 页面（构建时生成）

```typescript
// src/pages/about.tsx
import React from 'react';

export default function About() {
  return <div><h1>关于我们</h1></div>;
}
```

### ISR 页面（增量静态再生）

```typescript
// src/pages/blog-detail.tsx
import React from 'react';

export default function BlogDetail({ post }) {
  return (
    <article>
      <h1>{post.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: post.content }} />
    </article>
  );
}

/**
 * 构建时数据预取（ISR 同样使用此函数）
 * 与 getServerSideProps 不同，此函数的结果会被缓存
 */
export async function getStaticProps(ctx) {
  const { params } = ctx;
  const post = await fetch(`https://api.example.com/posts/${params.slug}`).then(r => r.json());

  return {
    props: { post },
  };
}

/**
 * 声明所有需要在构建时生成的路径
 * ISR 模式下，未在此列出的路径会在首次请求时动态生成
 */
export async function getStaticPaths() {
  const posts = await fetch('https://api.example.com/posts').then(r => r.json());

  return {
    paths: posts.map(p => ({ params: { slug: p.slug } })),
    fallback: 'blocking', // 未预生成的路径首次访问时同步渲染
  };
}
```

### CSR 页面（纯客户端渲染）

```typescript
// src/pages/dashboard.tsx
import React, { useState, useEffect } from 'react';

/**
 * CSR 页面不需要 getServerSideProps 或 getStaticProps。
 * 数据在浏览器端通过 useEffect / useClientFetch 获取。
 *
 * 服务端只返回空壳 HTML（<div id="nami-root"></div> + JS），
 * 浏览器下载 JS 后执行 React 渲染。
 */
export default function Dashboard() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetch('/api/dashboard/stats')
      .then(res => res.json())
      .then(setStats);
  }, []);

  if (!stats) return <div>加载中...</div>;
  return <div><h1>控制台</h1>{/* 使用 stats 数据 */}</div>;
}
```

> **什么时候选 CSR？** 不需要 SEO、数据高度个性化（如用户仪表盘）、首屏性能不敏感的页面。CSR 的优势是服务端零负载，空壳 HTML 可以被 CDN 缓存。

## 4. 客户端入口

```typescript
// src/entry-client.tsx
import { initNamiClient } from '@nami/client';

initNamiClient({
  containerId: 'nami-root',
  // 插件会在此阶段初始化
  // plugins: [...],
});
```

## 5. 服务端入口

```typescript
// src/entry-server.tsx
import React from 'react';
import App from './app';

/**
 * 服务端渲染入口函数
 * 框架会在每次 SSR 请求时调用此函数
 */
export function createAppElement(context) {
  return <App url={context.url} initialData={context.initialData} />;
}

// 或者使用 renderToHTML 协议（两者二选一）
// export async function renderToHTML(context, initialData) {
//   return renderToString(<App />);
// }
```

## 6. CLI 命令

```bash
# 开发模式 — HMR + 实时编译 + 服务端代码自动刷新
pnpm nami dev
# 访问 http://localhost:3000
# 修改页面组件或 getServerSideProps 后自动更新

# 生产构建 — 同时构建客户端和服务端产物
pnpm nami build
# 输出到 dist/client/（浏览器端 JS/CSS/HTML）和 dist/server/（Node 端代码）

# 启动生产服务器
pnpm nami start
# 可选 --cluster 启用多进程（利用多核 CPU）

# 静态页面生成（仅 SSG/ISR 路由）
pnpm nami generate
# 可选 --route /blog/hello 仅生成指定路由

# 包分析 — 可视化 Bundle 组成，帮助优化包体积
pnpm nami analyze

# 环境信息 — 打印 Node、pnpm、Webpack 等版本信息
pnpm nami info
```

> **典型开发流程**：
> 1. `nami dev` — 开发调试
> 2. `nami build` — 构建生产产物
> 3. `nami start` — 本地验证生产行为
> 4. 部署到服务器，用 PM2 或 K8s 启动 `nami start --cluster`

## 7. 数据在页面中的使用

### 服务端注入的数据

```typescript
import { useNamiData } from '@nami/client';

function MyComponent() {
  // 读取服务端注入到 window.__NAMI_DATA__ 的数据
  const data = useNamiData();
  // 或读取指定字段
  const user = useNamiData<User>('user');
}
```

### 客户端数据请求

```typescript
import { useClientFetch } from '@nami/client';

function ProductList() {
  const { data, loading, error, refetch } = useClientFetch<Product[]>(
    '/api/products',
    { staleTime: 30000 }, // 30 秒内使用缓存
  );

  if (loading) return <div>加载中...</div>;
  if (error) return <div>出错了: {error.message}</div>;
  return <ul>{data?.map(p => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

## 8. 使用 Head 管理

```tsx
import { NamiHead } from '@nami/client';

function BlogPost({ post }) {
  return (
    <>
      <NamiHead>
        <title>{post.title} - My Blog</title>
        <meta name="description" content={post.excerpt} />
        <meta property="og:title" content={post.title} />
        <link rel="canonical" href={`https://myblog.com/post/${post.slug}`} />
      </NamiHead>
      <article>...</article>
    </>
  );
}
```

## 9. 使用路由

```tsx
import { useRouter, NamiLink } from '@nami/client';

function Navigation() {
  const { path, replace, query } = useRouter();

  return (
    <nav>
      {/* NamiLink 支持 hover / 进入视口预加载 */}
      <NamiLink to="/" prefetchOnHover>首页</NamiLink>
      <NamiLink to="/about">关于</NamiLink>

      {/* 编程式导航 */}
      <button onClick={() => replace('/dashboard')}>
        控制台
      </button>
    </nav>
  );
}
```

## 10. 添加插件

```typescript
// nami.config.ts
import { defineConfig } from '@nami/core';
import { NamiCachePlugin } from '@nami/plugin-cache';
import { NamiMonitorPlugin } from '@nami/plugin-monitor';

export default defineConfig({
  appName: 'my-app',
  plugins: [
    new NamiCachePlugin({
      strategy: 'lru',
      lruOptions: {
        maxSize: 100,
      },
    }),
    new NamiMonitorPlugin({
      endpoint: 'https://monitor.example.com/collect',
      errorCollectorOptions: {
        sampleRate: 0.1,
      },
    }),
  ],
});
```

---

## 下一步

- 想理解框架内部架构？→ [架构设计](./architecture.md)
- 想了解各渲染模式的区别和选型？→ [五种渲染模式](./rendering-modes.md)
- 想编写自定义插件？→ [插件系统](./plugin-system.md)
