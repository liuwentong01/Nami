# 服务器与中间件

Nami 服务端基于 Koa 构建，通过精心设计的中间件管线处理请求。本文档详细讲解每个中间件的职责、管线顺序的设计原因，以及集群模式和优雅停机的实现。

## 前置知识：Koa 洋葱模型

理解 Nami 中间件管线之前，需要理解 Koa 的核心机制——**洋葱模型**：

```
请求 → ┌─ 中间件A（前半段）─┐
       │  ┌─ 中间件B（前半段）─┐
       │  │  ┌─ 中间件C ─┐    │
       │  │  └───────────┘    │
       │  └─ 中间件B（后半段）─┘
       └─ 中间件A（后半段）─┘ → 响应
```

每个中间件在 `await next()` **之前**的代码处理入站请求，`await next()` **之后**的代码处理出站响应。`await next()` 会暂停当前中间件，执行下游所有中间件，全部完成后再回到 `await next()` 之后继续执行。

```typescript
app.use(async (ctx, next) => {
  console.log('A 前');     // 1. 入站
  await next();             // 2. 执行 B → C → C完 → B完
  console.log('A 后');     // 3. 出站（此时 ctx.body 已经被下游设置好了）
});
```

> **与 Express 的关键区别**：Express 的 `next()` 不返回 Promise，中间件无法知道下游何时完成。Koa 的 `await next()` 完全等待下游链路，这使得 timing 中间件可以精确测量整个请求耗时，ISR 中间件可以在渲染完成后读取 `ctx.body` 进行缓存。

---

## 1. 中间件管线总览

```
  请求入站                                   响应出站
     │                                         ▲
     ▼                                         │
 ① shutdownAware ── 停机中? → 503              │
     │                                         │
 ② timing ──────────── 记录开始时间 ────── 写 X-Response-Time
     │                                         │
 ③ security ─────────────────────── 写安全头 + Cache-Control
     │                                         │
 ④ requestContext ── 生成 requestId, logger      │
     │                                         │
 ⑤ healthCheck ──── /_health? → 短路返回        │
     │                                         │
 ⑥ staticServe ──── 匹配静态文件? → 短路返回     │
     │                                         │
 ⑦ dataPrefetch ─── /_nami/data/*? → JSON        │
     │                                         │
 ⑧ [用户中间件] ── config.server.middlewares     │
     │                                         │
 ⑨ [插件中间件] ── pluginManager 收集           │
     │                                         │
 ⑩ errorIsolation ─ try/catch 包裹下游          │
     │                                         │
 ⑪ isrCacheMiddleware ── 缓存命中? → 短路       │
     │                                         │
 ⑫ renderMiddleware ── 核心渲染逻辑             │
     │                                         │
     └──────────────── 响应 ────────────────────┘
```

### 顺序设计考量

| 位置 | 中间件 | 为什么在这里 |
|------|--------|-------------|
| ① | shutdownAware | 最外层，停机时拒绝所有新请求 |
| ② | timing | 覆盖所有后续中间件的耗时 |
| ③ | security | 尽早设置安全头 |
| ④ | requestContext | 后续所有中间件可使用 requestId |
| ⑤ | healthCheck | K8s 探针不需要经过后续流程 |
| ⑥ | staticServe | 静态资源直接返回，不进入渲染 |
| ⑦ | dataPrefetch | 数据 API 短路，不进入渲染 |
| ⑧⑨ | 用户/插件中间件 | 在错误隔离之前，自身错误由 Koa 兜底 |
| ⑩ | errorIsolation | 保护 ISR + 渲染层，500 不崩进程 |
| ⑪ | isrCache | 命中缓存直接返回，跳过渲染 |
| ⑫ | render | 核心渲染，最内层 |

## 2. 各中间件详解

### ① shutdownAware — 停机感知

```typescript
// 停机中对新请求返回 503
if (isShuttingDown) {
  ctx.status = 503;
  ctx.set('Connection', 'close');       // 告知客户端不要复用连接
  ctx.set('Retry-After', '5');          // 建议 5 秒后重试
  ctx.body = { status: 'shutting_down' };
  return;
}
await next();
```

`triggerShutdown()` 由 `setupGracefulShutdown` 在收到 SIGTERM/SIGINT 信号时立即调用。

### ② timing — 请求计时

```typescript
const start = process.hrtime.bigint();
ctx.state.requestStartTime = start;
await next();
const duration = Number(process.hrtime.bigint() - start) / 1e6; // 毫秒
ctx.set('X-Response-Time', `${duration.toFixed(2)}ms`);
```

### ③ security — 安全响应头

| 响应头 | 值 | 作用 |
|--------|-----|------|
| `X-Frame-Options` | `SAMEORIGIN` | 防止 Clickjacking |
| `X-Content-Type-Options` | `nosniff` | 防止 MIME 嗅探 |
| `X-XSS-Protection` | `1; mode=block` | XSS 过滤 |
| `Strict-Transport-Security` | `max-age=31536000` | 强制 HTTPS |
| `Content-Security-Policy` | 可配置 | 内容安全策略 |

同时删除 `X-Powered-By` 头，并在出站时将 `ctx.state.namiCacheControl` 写入 `Cache-Control` 头。

### ④ requestContext — 请求上下文

- 从 `x-request-id` 头读取或生成 UUID v4
- 写入 `ctx.state.requestId` 和 `ctx.state.logger`（child logger）
- 写入 `X-Request-Id` 响应头

所有后续中间件和渲染器可通过 `ctx.state.logger` 获取带 requestId 的日志实例。

### ⑤ healthCheck — 健康检查

```
GET /_health → 200 { status: 'ok', uptime: 12345, timestamp: '...' }
HEAD /_health → 200
POST /_health → 405
```

支持自定义 `checker` 函数，失败时返回 503。K8s 的 `livenessProbe` 和 `readinessProbe` 可以指向此端点。

### ⑥ staticServe — 静态资源

- 基于 `koa-static` 包装
- 默认 root: `dist/client`
- 带 content hash 的文件（如 `main.abc123.js`）设置 `immutable` 强缓存
- 其他文件设置 `no-cache`
- 支持 Gzip 和 Brotli 预压缩文件

### ⑦ dataPrefetch — 数据预取 API

拦截 `GET /_nami/data/*` 路径。这个路径来自 `@nami/shared` 的 `NAMI_DATA_API_PREFIX = '/_nami/data'`，不要和首屏注水使用的 `window.__NAMI_DATA__` 混淆：

1. 匹配路由配置
2. 根据路由的 `renderMode` 找到对应的数据预取函数（GSSP/GSP）
3. 通过 `ModuleLoader` 从 server bundle 加载函数
4. 执行并返回 JSON 结果：
   - `getServerSideProps` 返回 `notFound` 时响应 `404 { notFound: true }`
   - `getServerSideProps` 返回 `redirect` 时响应 `307/308` 或自定义 `statusCode`
   - `getStaticProps` 返回 `redirect` 时响应 `307/308`
   - 没有对应数据函数时响应 `404`，路由存在但无需数据时响应 `204`

客户端只有显式开启 `prefetchData` 时才会请求此 API；普通 `navigate` / `push` 不会自动拉取数据。

### ⑧⑨ 用户 / 插件中间件

用户通过 `config.server.middlewares` 添加的中间件在插件中间件之前执行。插件通过 `api.addServerMiddleware()` 注册的中间件按插件的 `enforce` 顺序排列。

这两类中间件位于 `errorIsolation` 上游，因此 `errorIsolation` 只保护 ISR 缓存层和核心渲染层。用户/插件中间件如果需要把业务异常转换为特定状态码，应在自身内部处理。

### ⑩ errorIsolation — 错误隔离

```typescript
try {
  await next(); // 包裹 ISR + 渲染
} catch (error) {
  logger.error('渲染错误', { error, url: ctx.url });
  ctx.status = 500;
  ctx.body = errorHTML; // 可自定义 500 错误页模板
  ctx.set('X-Nami-Error', 'true');
}
```

**只保护下游**（ISR + render），插件中间件在其上游，错误由 Koa 的 `app.on('error')` 兜底。

### ⑪ isrCacheMiddleware — ISR 缓存层

详见 [ISR 与缓存](./isr-and-caching.md)。核心逻辑：
- 仅处理 GET 请求的 ISR 路由
- 缓存命中时短路返回
- 缓存未命中时 `await next()` 触发渲染中间件

### ⑫ renderMiddleware — 核心渲染

最核心的中间件，流程：

1. **路由匹配**：`matchConfiguredRoute(path, routes)`
2. **构造 RenderContext**：URL、路由、参数、请求头、Cookie、requestId
3. **创建渲染器**：`RendererFactory.create({ mode, config, ... })`
4. **执行渲染**：`renderer.render(context)` 或 `renderToStream(context)`
5. **消费插件数据**：`applyPluginExtras(context.extra)` — 读取缓存命中、自定义头等
6. **设置响应**：状态码、body/stream、Cache-Control、缓存标签

渲染失败时的降级流程：
- 优先使用 `context.extra.__skeleton_fallback`（插件提供的骨架屏）
- 否则走 `DegradationManager` 多级降级

## 3. 集群模式

### 启动流程

```bash
nami start --cluster
```

```
                   ┌── 主进程 (Master) ──┐
                   │                     │
                   │  确定 Worker 数量    │
                   │  (0 = CPU 核心数)    │
                   │                     │
                   │  cluster.fork() × N │
                   │                     │
                   └─────────┬───────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌──────────┐   ┌──────────┐   ┌──────────┐
       │ Worker 1 │   │ Worker 2 │   │ Worker N │
       │          │   │          │   │          │
       │ createNamiServer()      │   │          │
       │ app.listen(port)        │   │          │
       │ process.send(           │   │          │
       │   'worker:ready')       │   │          │
       │          │              │   │          │
       └──────────┘   └──────────┘   └──────────┘
                              │
                   主进程收到所有 worker:ready
                              │
                   onAllWorkersReady() 回调
```

### Worker 数量配置

```typescript
server: {
  cluster: {
    workers: 0,   // 0 = CPU 核心数
    // workers: 4, // 固定 4 个 Worker
    // workers: -1, // CPU 核心数 - 1（保留一个核心给系统）
  }
}
```

### Worker 异常重启

Worker 异常退出时（非 SIGTERM、非 code 0），主进程会自动重启一个新 Worker，并带有频率限制（短时间内多次重启会触发告警）。

## 4. 优雅停机

### 完整流程

```
SIGTERM / SIGINT
    │
    ▼
① onSignalReceived()
   └── triggerShutdown() → shutdownAware 中间件开始返回 503
    │
    ▼
② server.close()
   └── 停止接受新 TCP 连接
   └── 已建立的连接继续处理
    │
    ▼
③ 等待进行中请求完成
   └── Promise.race([ closePromise, timeoutPromise(30s) ])
    │
    ▼
④ onShutdown() 回调
   ├── isrManager.close()     ← 关闭重验证队列、Redis 连接
   ├── pluginManager.dispose() ← 触发所有插件 onDispose
   └── options.onShutdown()    ← 用户自定义清理
    │
    ▼
⑤ process.exit(0)
```

### 活跃连接追踪

```typescript
let activeConnections = 0;
server.on('request', (_req, res) => {
  activeConnections++;
  res.on('finish', () => activeConnections--);
});
```

### 超时强制退出

如果进行中的请求在超时时间内未完成，强制退出。超时默认 30 秒，应小于 K8s 的 `terminationGracePeriodSeconds`。

## 5. 开发服务器

`nami dev` 启动的开发服务器与生产服务器共享核心架构，但有以下区别：

| 特性 | 开发服务器 | 生产服务器 |
|------|-----------|-----------|
| 静态资源 | webpack-dev-middleware（内存） | koa-static（磁盘） |
| HMR | webpack-hot-middleware（SSE） | 无 |
| Server Bundle | 每请求刷新（watch 模式） | 启动时加载一次 |
| ISR 缓存 | 不启用 | 按配置启用 |
| 安全头 | 不设置 | 设置 |
| 停机感知 | 不启用 | 启用 |
| 优雅停机 | 不启用 | 启用 |

开发服务器使用 `runtimeProvider` 每次请求刷新 server bundle，实现服务端代码的"热更新"。

## 6. 服务器创建入口

`createNamiServer` 是服务器实例的工厂函数：

```typescript
const {
  app,                  // Koa 实例
  pluginManager,        // 插件管理器
  isrManager,           // ISR 管理器（可选）
  degradationManager,   // 降级管理器
  triggerShutdown,      // 停机触发函数
} = await createNamiServer(config, options);
```

`startServer` 在此基础上增加了端口绑定、集群判断和优雅停机设置。

## 7. 部署注意事项

### K8s 部署配置建议

```yaml
# deployment.yaml
spec:
  containers:
  - name: nami-app
    command: ["nami", "start", "--cluster"]
    ports:
    - containerPort: 3000
    livenessProbe:
      httpGet:
        path: /_health         # 对应 healthCheck 中间件
        port: 3000
      initialDelaySeconds: 10
      periodSeconds: 10
    readinessProbe:
      httpGet:
        path: /_health
        port: 3000
      initialDelaySeconds: 5
      periodSeconds: 5
    env:
    - name: NODE_ENV
      value: "production"
  terminationGracePeriodSeconds: 35  # 必须 > gracefulShutdownTimeout (30s)
```

### PM2 部署

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'nami-app',
    script: 'nami',
    args: 'start',          // 不需要 --cluster，PM2 自己管理集群
    instances: 'max',        // PM2 cluster 模式
    exec_mode: 'cluster',
    kill_timeout: 35000,     // > gracefulShutdownTimeout
  }]
};
```

> **注意**：使用 PM2 cluster 模式时，不要同时开启 Nami 的 `--cluster`，否则会出现双层集群（PM2 fork N 个进程，每个进程内部又 fork N 个 Worker）。

### 多机 + ISR 部署

多机部署时 ISR 缓存必须使用 `redis` 适配器，否则每台机器的缓存独立，会导致：
- 不同机器返回不同版本的页面
- 按需失效只能清除一台机器的缓存

---

## 下一步

- 想了解构建系统？→ [构建系统](./webpack-build.md)
- 想了解降级策略细节？→ [错误处理与降级](./error-and-degradation.md)
