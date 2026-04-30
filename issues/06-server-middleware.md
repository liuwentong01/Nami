# 服务端与中间件（7 题）

---

## 题目 41：描述 Nami 的完整中间件管线。为什么中间件按这个顺序排列？⭐⭐⭐

**答案：**

### 完整管线（从外到内）

```
请求入站                                   响应出站
   │                                         ▲
   ▼                                         │
① shutdownAware ── 停机中? → 503              │
② timing ──────────── 记录开始时间 ────── 写 X-Response-Time
③ security ─────────────────────── 写安全头 + Cache-Control
④ requestContext ── 生成 requestId, logger      │
⑤ healthCheck ──── /_health? → 短路返回        │
⑥ staticServe ──── 匹配静态文件? → 短路返回     │
⑦ dataPrefetch ─── /_nami/data/*? → JSON        │
⑧ [用户中间件] ── config.server.middlewares     │
⑨ [插件中间件] ── pluginManager 收集           │
⑩ errorIsolation ─ try/catch 包裹下游          │
⑪ isrCacheMiddleware ── 缓存命中? → 短路       │
⑫ renderMiddleware ── 核心渲染逻辑             │
```

### 顺序设计考量

| 位置 | 中间件 | 为什么在这里 |
|------|--------|-------------|
| ① | shutdownAware | **最外层**：停机时拒绝所有新请求，包括健康检查 |
| ② | timing | 覆盖所有后续中间件的耗时（利用 Koa 洋葱模型的"后半段"写响应时间） |
| ③ | security | **尽早设置安全头**：即使后续中间件出错，响应也带有安全头 |
| ④ | requestContext | 后续所有中间件可使用 `ctx.state.requestId` 和 `ctx.state.logger` |
| ⑤ | healthCheck | K8s 探针**不需要经过**后续渲染流程，尽早短路 |
| ⑥ | staticServe | 静态资源直接返回，**不进入渲染**（节省服务器资源） |
| ⑦ | dataPrefetch | `/_nami/data/*` 数据 API 请求短路返回 JSON，不需要渲染 HTML |
| ⑧⑨ | 用户/插件 | 在 errorIsolation **之前**：自身错误由 Koa 全局 `app.on('error')` 兜底 |
| ⑩ | errorIsolation | **保护 ISR + 渲染层**：500 不崩进程 |
| ⑪ | isrCache | **在渲染之前**：缓存命中直接返回，跳过昂贵的渲染操作 |
| ⑫ | render | 核心渲染逻辑，最内层 |

### 洋葱模型的利用

```typescript
// timing 中间件利用洋葱模型
async function timing(ctx, next) {
  const start = process.hrtime.bigint();  // 入站：记录开始
  await next();                            // 等待所有下游完成
  const duration = /* 计算耗时 */;          // 出站：写响应头
  ctx.set('X-Response-Time', `${duration}ms`);
}

// security 中间件利用洋葱模型
async function security(ctx, next) {
  ctx.set('X-Frame-Options', 'SAMEORIGIN');  // 入站：设置安全头
  await next();                                // 等待下游
  if (ctx.state.namiCacheControl) {            // 出站：写 Cache-Control
    ctx.set('Cache-Control', ctx.state.namiCacheControl);
  }
}
```

**源码参考：**
- `packages/server/src/app.ts` — createNamiServer() 中的中间件注册顺序
- `packages/shared/src/constants/defaults.ts` — `NAMI_DATA_API_PREFIX = '/_nami/data'`

---

## 题目 42：errorIsolation 中间件为什么只保护 ISR + 渲染层，而不保护所有中间件？⭐⭐⭐⭐

**答案：**

```typescript
// packages/server/src/middleware/error-isolation.ts
async function errorIsolation(ctx, next) {
  try {
    await next(); // 包裹 ISR 缓存 + 渲染中间件
  } catch (error) {
    logger.error('渲染错误', { error, url: ctx.url });
    ctx.status = 500;
    ctx.body = errorHTML;
    ctx.set('X-Nami-Error', 'true');
  }
}
```

**为什么不包裹所有中间件？**

### 1. 关注点分离

errorIsolation 的职责是**保护渲染层**：渲染失败返回 500 错误页面，而不是崩溃进程。

用户中间件和插件中间件的错误由 Koa 的全局错误处理兜底：
```typescript
app.on('error', (err, ctx) => {
  logger.error('Koa 全局错误', err);
});
```

### 2. 错误处理策略不同

| 中间件 | 错误来源 | 处理策略 |
|--------|---------|---------|
| 用户中间件 | 业务代码 bug | 应该由用户自己 try/catch |
| 插件中间件 | 第三方插件 | 插件应该内部处理错误 |
| ISR + 渲染 | 框架核心流程 | 框架必须兜底，启动降级 |

### 3. 500 错误页面只对渲染有意义

如果用户中间件（如鉴权中间件）抛错，返回 500 错误 HTML 是不合理的——应该返回 401/403。只有渲染失败时，返回 500 错误页面才有意义。

### 4. 避免掩盖问题

如果 errorIsolation 包裹了所有中间件，用户中间件的 bug 会被静默地转换为 500 错误页面，开发者很难发现问题。让 Koa 全局错误处理器打印完整的 stack trace，有助于快速定位。

**源码参考：**
- `packages/server/src/middleware/error-isolation.ts`
- `packages/server/src/app.ts` — app.on('error')

---

## 题目 43：Nami 的集群模式是如何工作的？Worker 的就绪判断为什么不用 `online` 事件？⭐⭐⭐⭐

**答案：**

### 集群启动流程

```
                   ┌── 主进程 (Master) ──┐
                   │  确定 Worker 数量    │
                   │  (0 = CPU 核心数)    │
                   │  cluster.fork() × N │
                   └─────────┬───────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌──────────┐   ┌──────────┐   ┌──────────┐
       │ Worker 1 │   │ Worker 2 │   │ Worker N │
       │ createNamiServer()       │   │          │
       │ app.listen(port) 回调中: │   │          │
       │  process.send({          │   │          │
       │    type: 'worker:ready'  │   │          │
       │  })                      │   │          │
       └──────────┘   └──────────┘   └──────────┘
```

### 为什么不用 `online` 事件？

`cluster` 模块的 `online` 事件和自定义 `worker:ready` IPC 消息的区别：

| 事件 | 时机 | 含义 |
|------|------|------|
| `online` | Worker 进程启动成功 | 进程存活，但端口**可能还没绑定** |
| `worker:ready` | `app.listen()` 回调执行 | 端口已绑定，**真正准备好接收请求** |

```typescript
// Worker 进程中
const server = app.listen(port, () => {
  // 端口已绑定，可以接收请求了
  process.send({
    type: 'worker:ready',
    workerId: cluster.worker.id,
    pid: process.pid,
    port,
  });
});
```

如果使用 `online` 事件，可能出现：
1. 主进程认为 Worker 已就绪
2. K8s readinessProbe 通过
3. 流量开始进入
4. 但 Worker 还在初始化（加载配置、注册插件、绑定端口）
5. 请求被拒绝或超时

### Worker 异常重启

```typescript
// 主进程监听 Worker 退出
cluster.on('exit', (worker, code, signal) => {
  // 正常退出（SIGTERM 或 code=0）不重启
  if (signal === 'SIGTERM' || code === 0) return;

  // 检查重启频率限制
  if (restartsInWindow >= maxRestarts) {
    logger.error('重启过于频繁，停止重启');
    return;
  }

  // 延迟重启（防止 thrashing）
  setTimeout(() => cluster.fork(), restartDelay);
});
```

**源码参考：**
- `packages/server/src/cluster/master.ts` — Master 进程逻辑
- `packages/server/src/server.ts` — Worker 在 `app.listen` 回调中发送 `worker:ready`

---

## 题目 44：描述 Nami 优雅停机的完整流程。为什么 K8s 的 terminationGracePeriodSeconds 必须大于 Nami 的 gracefulShutdownTimeout？⭐⭐⭐⭐⭐

**答案：**

### 完整的优雅停机流程

```
SIGTERM / SIGINT 信号到达
    │
    ▼
① onSignalReceived()
   └── triggerShutdown() → shutdownAware 中间件开始返回 503
   └── 设置 isShuttingDown = true（防止重复触发）
    │
    ▼
② server.close()
   └── 停止接受新 TCP 连接
   └── 已建立的连接继续处理（keep-alive 连接标记 Connection: close）
    │
    ▼
③ 等待进行中请求完成
   └── Promise.race([
         closePromise,           // 所有请求完成
         timeoutPromise(30s)     // 超时强制退出
       ])
    │
    ▼
④ onShutdown() 回调
   ├── isrManager.close()      ← 关闭重验证队列，释放 Redis 连接
   ├── pluginManager.dispose()  ← 触发所有插件的 onDispose 钩子
   └── options.onShutdown()     ← 用户自定义清理（如关闭数据库连接）
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

**为什么用 `finish` 而不是 `end`？**
- `end` 事件在数据发送给操作系统网络栈时触发
- `finish` 事件在 HTTP 响应完全发送完成后触发
- 使用 `finish` 确保响应真正送达

### 为什么 terminationGracePeriodSeconds > gracefulShutdownTimeout？

```
K8s 发送 SIGTERM
├── Nami 开始优雅停机（最多 30 秒）
│   ├── 处理剩余请求
│   ├── 清理资源
│   └── process.exit(0)
│
├── 如果 30 秒内没完成...
│   └── Nami 自己的超时强制退出
│
├── 如果 terminationGracePeriodSeconds 也到了（比如 30 秒）...
│   └── K8s 发送 SIGKILL → 进程立即被杀死
│       → 正在清理的资源（Redis 连接、ISR 队列）无法正常关闭
│       → 可能导致数据损坏或资源泄漏
```

**推荐配置：**
```yaml
# K8s
terminationGracePeriodSeconds: 35  # 比 Nami 的 30 秒多 5 秒缓冲

# Nami
server:
  gracefulShutdownTimeout: 30000  # 30 秒
```

多出的 5 秒确保 Nami 的清理逻辑（步骤④）有足够时间执行完毕后 `process.exit(0)`，而不是被 SIGKILL 强制杀死。

**源码参考：**
- `packages/server/src/middleware/graceful-shutdown.ts`

---

## 题目 45：shutdownAware 中间件的 `Connection: close` 和 `Retry-After` 头分别有什么作用？⭐⭐⭐

**答案：**

```typescript
// packages/server/src/middleware/shutdown-aware.ts
if (isShuttingDown) {
  ctx.status = 503;
  ctx.set('Connection', 'close');    // ①
  ctx.set('Retry-After', '5');       // ②
  ctx.body = { status: 'shutting_down' };
  return;
}
```

### ① Connection: close

**作用：** 告知客户端/反向代理不要在当前 TCP 连接上发送后续请求。

HTTP/1.1 默认使用 keep-alive，一个 TCP 连接可以处理多个请求。如果停机时不发 `Connection: close`：
1. 客户端可能在同一连接上发送新请求
2. 新请求到达时，服务器可能已经关闭 socket
3. 客户端收到 "connection reset" 错误

发送 `Connection: close` 后：
1. 客户端知道这个连接不能复用
2. 下一个请求会建立新连接
3. 新连接会被负载均衡器路由到其他健康的 Pod

### ② Retry-After: 5

**作用：** 建议客户端在 5 秒后重试。

**对不同客户端的影响：**
- **浏览器**：大多数浏览器会显示 503 错误页面，不会自动重试
- **HTTP 客户端库（如 axios）**：可以配置为读取 `Retry-After` 头自动重试
- **负载均衡器/CDN**：一些负载均衡器（如 Nginx、AWS ALB）会读取此头，在指定时间后将请求路由到其他后端
- **爬虫**：搜索引擎爬虫会根据此头延迟重新抓取，避免将 503 索引为正式内容

### 为什么是 5 秒？

典型的滚动部署中，新 Pod 启动并通过 readinessProbe 大约需要 5-15 秒。5 秒后重试，新 Pod 可能已经就绪。

**源码参考：**
- `packages/server/src/middleware/shutdown-aware.ts`

---

## 题目 46：PM2 cluster 模式和 Nami 内置集群模式可以同时使用吗？为什么？⭐⭐⭐

**答案：**

**不可以同时使用。**

### 问题：双层集群

```
PM2 (cluster mode, instances: 4)
├── PM2 Worker 1 (nami start --cluster)
│   ├── Nami Master
│   │   ├── Nami Worker 1.1
│   │   ├── Nami Worker 1.2
│   │   ├── Nami Worker 1.3
│   │   └── Nami Worker 1.4
├── PM2 Worker 2 (nami start --cluster)
│   ├── Nami Master
│   │   ├── Nami Worker 2.1
│   │   ├── Nami Worker 2.2
│   │   └── ...
└── ... (共 4 × 4 = 16 个 Worker 进程!)
```

8 核 CPU 的机器上，这会产生 16 个 Worker 进程，远超 CPU 核心数，导致：
1. **过多的上下文切换**：CPU 不断在进程间切换，实际处理时间减少
2. **内存浪费**：每个 Node.js 进程消耗 ~100MB 基础内存，16 个就是 1.6GB
3. **端口冲突**：可能出现端口绑定问题

### 正确的部署方式

**方式一：PM2 管集群，Nami 不开集群**
```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'nami-app',
    script: 'nami',
    args: 'start',           // 不加 --cluster
    instances: 'max',         // PM2 负责 fork
    exec_mode: 'cluster',
    kill_timeout: 35000,
  }]
};
```

**方式二：Nami 管集群，不用 PM2 cluster**
```bash
nami start --cluster  # Nami 自己管理 Worker
```

### 选择建议

| 场景 | 推荐 |
|------|------|
| 已有 PM2 基础设施 | PM2 cluster + Nami 单进程 |
| K8s 部署 | Nami 内置 --cluster 或单进程（K8s 本身可以多 Pod） |
| Docker 容器 | Nami 内置 --cluster（容器内 PM2 意义不大） |
| 传统 VPS | PM2 cluster + Nami 单进程 |

**源码参考：**
- `packages/server/src/cluster/master.ts` — Nami 集群实现

---

## 题目 47：requestContext 中间件的 requestId 有什么作用？为什么优先从 x-request-id 头读取？⭐⭐⭐

**答案：**

### requestId 的作用

```typescript
// packages/server/src/middleware/request-context.ts
const requestId = ctx.headers['x-request-id'] || uuid.v4();
ctx.state.requestId = requestId;
ctx.state.logger = logger.child({ requestId });
ctx.set('X-Request-Id', requestId);
```

**requestId 用于请求追踪（Distributed Tracing）：**

一个用户操作可能经过多个服务：

```
Browser → Nginx → Nami Server → API Service → Database
```

如果所有日志都带有同一个 requestId，可以在日志系统中串联完整的请求链路：

```
[req-abc123] Nami: 收到请求 GET /products/123
[req-abc123] Nami: 调用 getServerSideProps
[req-abc123] API: 收到请求 GET /api/products/123
[req-abc123] API: 查询数据库
[req-abc123] Nami: SSR 渲染完成，耗时 120ms
```

### 为什么优先从请求头读取？

在微服务架构中，requestId 通常由**入口网关**（如 Nginx、API Gateway）生成并通过 `X-Request-Id` 头传递给所有下游服务。

```
Nginx (生成 X-Request-Id: abc123)
  → Nami Server (读取 abc123，不重新生成)
    → API Service (透传 abc123)
```

如果 Nami 不读取上游传入的 ID 而是自己生成，就无法和 Nginx 的访问日志关联。

**没有上游网关时：** `X-Request-Id` 头为空，Nami 生成一个 UUID v4 作为 requestId。

### Child Logger

```typescript
ctx.state.logger = logger.child({ requestId });
```

`child()` 创建一个带有固定字段的子 logger，该 logger 输出的每条日志都自动带上 requestId，不需要在每个 log 调用中手动传入。

**源码参考：**
- `packages/server/src/middleware/request-context.ts`
