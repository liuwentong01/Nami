# 服务器与中间件

Nami 服务端基于 Koa 组装请求处理管线。要读懂这一章，重点不是只记住“第几个中间件做什么”，而是理解三件事：

1. Koa 中间件是洋葱模型，`await next()` 之前处理入站请求，`await next()` 之后处理出站响应。
2. “注册顺序”和“真正产生响应的位置”不总是完全相同，例如静态资源中间件默认 `defer: true`，会先把控制权交给下游。
3. 生产服务器、开发服务器、集群模式、优雅停机共用一部分能力，但入口和管线并不完全相同。

本章主要对应以下源码：

| 主题 | 源码 |
|------|------|
| Koa 应用创建与生产管线 | `packages/server/src/app.ts` |
| 服务启动、监听、优雅停机挂载 | `packages/server/src/server.ts` |
| 停机感知与优雅停机 | `packages/server/src/middleware/graceful-shutdown.ts` |
| 请求计时 | `packages/server/src/middleware/timing.ts` |
| 安全响应头 | `packages/server/src/middleware/security.ts` |
| 请求上下文 | `packages/server/src/middleware/request-context.ts` |
| 健康检查 | `packages/server/src/middleware/health-check.ts` |
| 静态资源 | `packages/server/src/middleware/static-serve.ts` |
| 路由数据预取接口 | `packages/server/src/middleware/data-prefetch-middleware.ts` |
| 路由匹配 | `packages/server/src/middleware/route-match.ts` |
| 错误隔离 | `packages/server/src/middleware/error-isolation.ts` |
| ISR 缓存中间件 | `packages/server/src/middleware/isr-cache-middleware.ts` |
| 核心渲染中间件 | `packages/server/src/middleware/render-middleware.ts` |
| ISR 管理器与 SWR 判断 | `packages/server/src/isr/isr-manager.ts`、`packages/server/src/isr/stale-while-revalidate.ts` |
| 集群主进程和 Worker | `packages/server/src/cluster/master.ts`、`packages/server/src/cluster/worker.ts` |
| 开发服务器 | `packages/server/src/dev/dev-server.ts`、`packages/server/src/dev/hmr-middleware.ts` |

---

## 1. Koa 洋葱模型

Koa 中间件的基本形态是：

```typescript
app.use(async (ctx, next) => {
  // 入站阶段：请求从外层进入内层
  await next();
  // 出站阶段：下游完成后，响应从内层回到外层
});
```

请求进入时按注册顺序向下执行；响应返回时按相反顺序回到外层。Nami 利用这个机制实现了几个关键能力：

| 能力 | 为什么依赖洋葱模型 |
|------|--------------------|
| `timingMiddleware` | 入站记录高精度开始时间，出站时计算完整链路耗时并写入 `X-Response-Time` |
| `securityMiddleware` | 下游先决定响应体和缓存语义，出站时统一补安全头和最终 `Cache-Control` |
| `isrCacheMiddleware` | 缓存未命中时 `await next()` 触发渲染，渲染完成后读取 `ctx.body` 写入 ISR 缓存 |
| `errorIsolationMiddleware` | 用 `try { await next() } catch { ... }` 只包裹下游 ISR 和渲染层 |

需要特别注意：如果某个中间件不调用 `next()`，请求会在该中间件短路返回。例如健康检查命中 `/_health` 后不会进入静态资源、数据预取和渲染层。

---

## 2. 生产中间件管线总览

生产服务器由 `createNamiServer(config, options)` 创建，核心管线在 `packages/server/src/app.ts` 中按以下顺序注册：

```text
请求入站
  │
  ▼
① shutdownAware
  │  停机标记已打开时直接 503，不进入后续中间件
  ▼
② timing
  │  入站记录 process.hrtime.bigint()
  ▼
③ security
  │  出站阶段写安全头，并兜底回写 ctx.state.namiCacheControl
  ▼
④ requestContext
  │  生成或透传 requestId，创建请求级 logger
  ▼
⑤ healthCheck
  │  命中 /_health 时短路返回
  ▼
⑥ staticServe
  │  注册在这里，但默认 defer: true，会先让下游处理，再回退尝试发送静态文件
  ▼
⑦ dataPrefetch
  │  命中 GET /_nami/data/* 时执行页面数据函数并返回 JSON
  ▼
⑧ config.server.middlewares
  │  用户自定义 Koa 中间件，位于插件中间件之前
  ▼
⑨ pluginManager.getServerMiddlewares()
  │  插件通过 api.addServerMiddleware() 注册，按插件 enforce 顺序收集
  ▼
⑩ errorIsolation
  │  try/catch 包裹下游 ISR 和 render
  ▼
⑪ isrCacheMiddleware
  │  仅 config.isr.enabled 时注册；命中 ISR 缓存时短路返回 HTML
  ▼
⑫ renderMiddleware
  │  路由匹配、构造 RenderContext、选择渲染器、设置响应
  │
  ▼
响应出站
```

### 顺序设计

| 位置 | 中间件 | 顺序原因 |
|------|--------|----------|
| ① | `shutdownAware` | 最外层，收到停机信号后新请求应尽快返回 `503`，避免继续占用正在退出的实例 |
| ② | `timing` | 需要覆盖除停机短路外的完整请求链路 |
| ③ | `security` | 注册靠前，但真正写头在出站阶段，可以拿到下游最终缓存语义 |
| ④ | `requestContext` | 后续健康检查、数据预取、渲染、日志都能使用同一个 `requestId` |
| ⑤ | `healthCheck` | 探针请求不应触发静态资源查找、插件逻辑或渲染 |
| ⑥ | `staticServe` | 静态资源由框架统一兜底发送；包装层会按最终路径为 2xx 响应补缓存头 |
| ⑦ | `dataPrefetch` | 数据预取 API 是路由数据接口，命中后返回 JSON，不进入页面渲染 |
| ⑧ | 用户中间件 | 业务可在插件前注入 Koa 逻辑，例如鉴权、代理、API mock |
| ⑨ | 插件中间件 | 插件按 `enforce: pre -> normal -> post` 注册顺序提供服务端扩展 |
| ⑩ | `errorIsolation` | 保护框架核心的 ISR 和渲染层，不吞掉用户/插件中间件本身的异常 |
| ⑪ | `isrCache` | 必须在渲染前，缓存命中才能跳过昂贵的 React SSR/ISR 渲染 |
| ⑫ | `render` | 最内层负责最终页面响应 |

用户中间件和插件中间件在 `errorIsolation` 上游，这是当前源码的真实行为。它们抛出的异常不会被 `errorIsolationMiddleware` 捕获，而是继续向外冒泡到 Koa 的 `app.on('error')` 兜底处理；如果业务希望返回特定状态码，应在自己的中间件内部捕获并设置 `ctx.status` / `ctx.body`。

---

## 3. 每个中间件的原理

### ① `shutdownAware`：停机感知

源码位置：`packages/server/src/middleware/graceful-shutdown.ts`

`createShutdownAwareMiddleware()` 返回两个东西：

```typescript
{
  middleware,
  triggerShutdown,
}
```

内部只有一个闭包变量：

```typescript
let isShuttingDown = false;
```

正常情况下，中间件直接 `await next()`。一旦 `triggerShutdown()` 被调用，后续新请求会直接得到：

| 响应项 | 值 | 作用 |
|--------|----|------|
| 状态码 | `503` | 告诉负载均衡器当前实例不可用 |
| `Connection` | `close` | 告诉客户端不要复用当前连接 |
| `Retry-After` | `5` | 建议客户端或代理稍后重试 |
| Body | `{ status: 'shutting_down', message: '服务正在停机中，请稍后重试' }` | 明确停机状态 |

`triggerShutdown()` 在 `startServer()` 里传给 `setupGracefulShutdown()` 的 `onSignalReceived`。也就是说，进程收到 `SIGTERM` 或 `SIGINT` 后，会先打开停机感知开关，再调用 `server.close()` 停止接收新 TCP 连接。

这个中间件只影响“停机标记打开之后进入 Koa 的新请求”。已经进入下游的请求不会被它中断，而是交给优雅停机流程等待完成。

### ② `timingMiddleware`：请求计时

源码位置：`packages/server/src/middleware/timing.ts`

它的入站逻辑：

```typescript
const startTime = process.hrtime.bigint();
ctx.state.requestStartTime = startTime;
await next();
```

出站逻辑：

```typescript
const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
ctx.set('X-Response-Time', `${durationMs.toFixed(2)}ms`);
```

这里使用 `process.hrtime.bigint()` 而不是 `Date.now()`，因为它是单调时钟，不受系统时间回拨或校准影响，更适合计算耗时。`ctx.state.requestStartTime` 也会传给下游，便于其他中间件或渲染层基于同一个起点计算阶段耗时。

由于写响应头发生在 `await next()` 之后，只有当下游正常返回，或下游错误被更内层的 `errorIsolation` 转换成响应后，`X-Response-Time` 才能被写入。如果用户/插件中间件在 `errorIsolation` 上游抛错并向外冒泡，Koa 兜底错误处理不一定会保留这个头。

### ③ `securityMiddleware`：安全响应头与缓存头兜底

源码位置：`packages/server/src/middleware/security.ts`

这个中间件也是“先下游，后写头”：

```typescript
await next();

if (typeof ctx.state.namiCacheControl === 'string') {
  ctx.set('Cache-Control', ctx.state.namiCacheControl);
}

ctx.set('X-Frame-Options', 'SAMEORIGIN');
ctx.set('X-Content-Type-Options', 'nosniff');
ctx.set('X-XSS-Protection', '1; mode=block');
ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
ctx.set('Content-Security-Policy', DEFAULT_CSP);
ctx.remove('X-Powered-By');
```

默认安全头如下：

| 响应头 | 默认值 | 含义 |
|--------|--------|------|
| `X-Frame-Options` | `SAMEORIGIN` | 只允许同源页面通过 iframe 嵌入，降低点击劫持风险 |
| `X-Content-Type-Options` | `nosniff` | 禁止浏览器进行 MIME 嗅探 |
| `X-XSS-Protection` | `1; mode=block` | 启用旧浏览器内置 XSS 过滤器 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | 告诉浏览器一年内对子域名也强制使用 HTTPS |
| `Content-Security-Policy` | `DEFAULT_CSP` | 限制脚本、样式、图片、字体、连接等资源来源 |

默认 CSP 为：

```text
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self';
media-src 'self';
object-src 'none';
frame-ancestors 'self'
```

`'unsafe-inline'` 和 `'unsafe-eval'` 是为了兼容 SSR 注水脚本、开发调试和部分运行时需求。生产项目如果有更严格安全要求，应通过 `securityMiddleware(options)` 的 `csp` / `cspEnabled` 等选项收紧策略。

`Cache-Control` 不是在安全中间件里计算的。ISR 中间件或渲染结果会把最终缓存语义挂到 `ctx.state.namiCacheControl`，`securityMiddleware` 在出站阶段再兜底回写一次，避免更内层的历史逻辑覆盖了核心缓存协议。

### ④ `requestContextMiddleware`：请求上下文与日志链路

源码位置：`packages/server/src/middleware/request-context.ts`

请求上下文中间件做四件事：

1. 从请求头读取 `x-request-id`。
2. 如果上游没有传入，则用 `uuidv4()` 生成新的请求 ID。
3. 写入 `ctx.state.requestId` 和 `ctx.state.logger`。
4. 在响应头回传 `X-Request-Id`。

下游中间件可以直接使用：

```typescript
const requestId = ctx.state.requestId;
const logger = ctx.state.logger;
```

`ctx.state.logger` 是基于 `createLogger('@nami/server')` 创建的 child logger，会自动携带 `requestId`。因此数据预取、ISR、渲染、错误隔离日志都能关联到同一个请求。

### ⑤ `healthCheckMiddleware`：健康检查短路

源码位置：`packages/server/src/middleware/health-check.ts`

默认路径来自 `@nami/shared` 的 `HEALTH_CHECK_PATH`：

```typescript
export const HEALTH_CHECK_PATH = '/_health';
```

执行规则：

| 请求 | 行为 |
|------|------|
| `GET /_health` | 返回 `200` JSON |
| `HEAD /_health` | 返回 `200`，Koa 会按 HEAD 语义处理响应体 |
| 其他方法访问 `/_health` | 返回 `405 { error: 'Method Not Allowed' }` |
| 非 `/_health` 路径 | `await next()` 交给下游 |

默认健康响应：

```json
{
  "status": "ok",
  "uptime": 12.34,
  "timestamp": "2026-04-30T00:00:00.000Z"
}
```

如果创建中间件时传入 `checker`，它会在返回 `ok` 前执行自定义检查。`checker` 返回 `false` 或抛错时，响应 `503`：

| 场景 | 状态码 | Body |
|------|--------|------|
| `checker()` 返回 `false` | `503` | `{ status: 'unhealthy', uptime, timestamp }` |
| `checker()` 抛异常 | `503` | `{ status: 'error', error, uptime, timestamp }` |

健康检查命中后不会调用 `next()`。这保证了 K8s、负载均衡器或监控探针不会触发静态文件查找、路由数据函数或 React 渲染。

### ⑥ `staticServeMiddleware`：静态资源服务

源码位置：`packages/server/src/middleware/static-serve.ts`

静态资源中间件基于 `koa-static` 包装，默认配置：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `root` | `${process.cwd()}/dist/client` | 客户端构建产物目录 |
| `maxAge` | `31536000` | 带 hash 资源的缓存秒数 |
| `htmlMaxAge` | `0` | 非 hash 资源的基础缓存秒数 |
| `gzip` | `true` | 支持 `.gz` 预压缩文件 |
| `brotli` | `true` | 支持 `.br` 预压缩文件 |
| `defer` | `true` | 先执行下游，再在下游未处理时尝试发送文件 |

这里最容易误解的是 `defer: true`。虽然 `staticServeMiddleware` 在 `dataPrefetchMiddleware` 和 `renderMiddleware` 之前注册，但 `koa-static` 会先 `await next()`，下游没有产生响应时才尝试从 `dist/client` 发送文件。实际效果是：

```text
静态资源请求 /assets/main.abcdef12.js
  ├─ staticServe 入站
  ├─ 先进入 dataPrefetch / 用户中间件 / 插件中间件 / errorIsolation / render
  ├─ render 未匹配页面路由，返回
  └─ staticServe 回退查找 dist/client/assets/main.abcdef12.js 并发送
```

这种设计让静态资源作为框架兜底能力存在，同时避免无条件抢占后续业务中间件。需要注意的是，当前包装层并不额外判断“文件是否由 `koa-static` 命中”，而是在 `koa-static` 返回后检查最终 `ctx.status` 是否为 2xx，并根据 `ctx.path` 写入缓存头。因此它既会给静态文件补缓存策略，也可能给下游成功生成的页面补上默认 `public, no-cache`；如果渲染结果或 ISR 中间件设置了 `ctx.state.namiCacheControl`，外层 `securityMiddleware` 会在更后的出站阶段把最终缓存语义重新写回。

| 最终 `ctx.path` | 匹配规则 | `Cache-Control` |
|------------------|----------|-----------------|
| `/assets/main.abcdef12.js` | 包含 8 位以上十六进制 hash：`/\.[a-f0-9]{8,}\.\w+$/i` | `public, max-age=31536000, immutable` |
| `/index.html`、`/dashboard`、`/asset-manifest.json` 等 | 不匹配 hash 规则 | `public, no-cache` |

`koa-static` 底层通过 `koa-send` 发送文件，支持 ETag、Last-Modified、Range 请求和路径安全校验。Nami 只在它外层补充资源缓存策略。

### ⑦ `dataPrefetchMiddleware`：路由数据预取 API

源码位置：`packages/server/src/middleware/data-prefetch-middleware.ts`

数据预取 API 的前缀来自 `@nami/shared`：

```typescript
export const NAMI_DATA_API_PREFIX = '/_nami/data';
```

它只处理 `GET /_nami/data/*`。其他方法或其他路径都会 `await next()`。

完整流程：

1. 去掉 `/_nami/data` 前缀，把剩余部分规范化为页面路径。
2. 调用 `matchConfiguredRoute(requestPath, config.routes)` 匹配路由。
3. 通过 `runtimeProvider()` 获取最新运行时，或使用启动时注入的 `moduleLoader`。
4. 根据路由 `renderMode` 选择 `getServerSideProps` 或 `getStaticProps`。
5. 用 `moduleLoader.getExportedFunction(route.component, exportName)` 从 server bundle 找到页面数据函数。
6. 执行数据函数并把结果转换为 JSON 响应。

路由匹配使用 `packages/server/src/middleware/route-match.ts`，内部复用 `@nami/core` 的 `rankRoutes + matchPath`：

```typescript
const sortedRoutes = rankRoutes(routes);
for (const route of sortedRoutes) {
  const exact = route.exact !== false;
  const result = matchPath(route.path, requestPath, { exact });
}
```

这样 `dataPrefetch`、`isrCache` 和 `render` 使用同一套路由优先级，避免“数据接口命中 A 路由，实际渲染命中 B 路由”的分叉。

#### SSR 路由

当路由满足：

```typescript
route.renderMode === RenderMode.SSR && route.getServerSideProps
```

中间件会加载并执行 `getServerSideProps`。传入参数包括：

| 字段 | 来源 |
|------|------|
| `params` | 路由动态参数 |
| `query` | Koa `ctx.query`，只保留字符串或字符串数组 |
| `headers` | 请求头，小写 key |
| `path` | 去掉数据 API 前缀后的页面路径 |
| `url` | 页面路径 + querystring |
| `cookies` | 从 `Cookie` 头解析出的键值对 |
| `requestId` | `ctx.state.requestId`，没有则为 `'unknown'` |

响应规则：

| `getServerSideProps` 结果 | HTTP 响应 |
|--------------------------|-----------|
| 函数导出不存在 | `404 { message: 'getServerSideProps not found' }` |
| `{ notFound: true }` | `404 { notFound: true }` |
| `{ redirect }` | `statusCode` 优先，否则永久跳转 `308`、临时跳转 `307`，Body 为 `{ redirect }` |
| `{ props }` 或空结果 | `200`，Body 为 `props ?? {}` |

#### SSG / ISR 路由

当路由满足：

```typescript
(route.renderMode === RenderMode.SSG || route.renderMode === RenderMode.ISR)
  && route.getStaticProps
```

中间件会加载并执行 `getStaticProps`，当前数据 API 只传入：

```typescript
{ params: matchResult.params }
```

响应规则：

| `getStaticProps` 结果 | HTTP 响应 |
|----------------------|-----------|
| 函数导出不存在 | `404 { message: 'getStaticProps not found' }` |
| `{ notFound: true }` | `404 { notFound: true }` |
| `{ redirect }` | 永久跳转 `308`，临时跳转 `307`，Body 为 `{ redirect }` |
| `{ props }` 或空结果 | `200`，Body 为 `props ?? {}` |

如果路由存在但不需要页面数据，返回：

```http
204 No Content
```

如果没有可用 `moduleLoader`，中间件会记录 debug 日志并 `await next()`。这在开发服务器首次编译完成前或调用方未注入 server runtime 时非常重要，避免数据 API 直接让整个请求失败。

数据预取 API 和首屏注水不是同一个东西：

| 机制 | 位置 | 用途 |
|------|------|------|
| `/_nami/data/*` | Koa 中间件 | 客户端路由预取数据 |
| `window.__NAMI_DATA__` | HTML 注入脚本 | 首屏 SSR/SSG/ISR 把服务端数据带给浏览器 hydration |

### ⑧ `config.server.middlewares`：用户自定义中间件

源码位置：`packages/server/src/app.ts`、`packages/shared/src/types/config.ts`

配置类型：

```typescript
server: {
  middlewares?: Array<import('koa').Middleware>;
}
```

注册逻辑：

```typescript
if (config.server.middlewares && config.server.middlewares.length > 0) {
  for (const mw of config.server.middlewares) {
    app.use(mw);
  }
}
```

这些中间件位于数据预取之后、插件中间件之前、错误隔离之前。常见用途：

| 用途 | 说明 |
|------|------|
| API mock | 拦截 `/api/*` 并返回测试数据 |
| 自定义鉴权 | 在进入插件和渲染前检查 Cookie / Header |
| 代理 | 将特定路径转发到后端服务 |
| 灰度标记 | 写入 `ctx.state`，供后续插件或渲染逻辑读取 |

如果希望某个请求不进入页面渲染，用户中间件应设置 `ctx.status` / `ctx.body` 并且不调用 `next()`。

### ⑨ 插件中间件：`api.addServerMiddleware()`

源码位置：

- `packages/server/src/app.ts`
- `packages/core/src/plugin/plugin-manager.ts`
- `packages/core/src/plugin/plugin-api-impl.ts`

插件在 `setup(api)` 阶段调用：

```typescript
api.addServerMiddleware(async (ctx, next) => {
  await next();
});
```

`PluginAPIImpl` 会把中间件连同插件名存入该插件自己的 `middlewares` 列表。`PluginManager.getServerMiddlewares()` 再按插件注册顺序收集所有插件中间件。

插件注册前会按 `enforce` 排序：

```text
enforce: 'pre' -> 普通插件 -> enforce: 'post'
```

因此插件中间件的整体顺序也是：

```text
pre 插件中间件 -> 普通插件中间件 -> post 插件中间件
```

当前生产管线中，插件中间件和用户中间件一样位于 `errorIsolation` 上游。插件中间件内部异常不会被 `errorIsolationMiddleware` 捕获；插件作者应在自己的中间件中处理可预期错误，并避免让插件扩展影响核心渲染稳定性。

### ⑩ `errorIsolationMiddleware`：框架核心错误边界

源码位置：`packages/server/src/middleware/error-isolation.ts`

错误隔离中间件的核心结构：

```typescript
try {
  await next();
} catch (error) {
  ctx.status = 500;
  ctx.type = 'text/html; charset=utf-8';
  ctx.set('X-Nami-Error', 'true');
  ctx.body = errorPageHTML ?? getDefaultErrorPage(requestId, isDev, error);
}
```

它包裹的是下游：

```text
errorIsolation
  └─ isrCacheMiddleware
       └─ renderMiddleware
```

捕获到异常后会：

1. 把非 `Error` 抛出值规范化为 `Error`。
2. 从 `ctx.state` 读取 `requestId` 和请求级 logger。
3. 记录方法、URL、User-Agent、IP、错误消息和堆栈。
4. 可选执行 `onError(error, ctx)`，但该回调自身也被 try/catch 包裹。
5. 返回静态 500 HTML，避免错误页再次依赖 React 渲染。

开发环境下默认错误页会展示错误消息和堆栈；生产环境只展示通用错误和 `requestId`，避免泄露内部信息。错误页里的错误消息会经过 HTML 转义，降低二次 XSS 风险。

### ⑪ `isrCacheMiddleware`：ISR 缓存层

源码位置：

- `packages/server/src/middleware/isr-cache-middleware.ts`
- `packages/server/src/isr/isr-manager.ts`
- `packages/server/src/isr/stale-while-revalidate.ts`

这个中间件只在 `config.isr.enabled` 为 `true` 时注册。它只处理普通页面 `GET` 请求，并且会跳过内部重验证请求：

```typescript
if (ctx.method !== 'GET') await next();
if (ctx.get(NAMI_ISR_REVALIDATE_HEADER) === '1') await next();
```

内部重验证请求头来自 `@nami/shared`：

```typescript
export const NAMI_ISR_REVALIDATE_HEADER = 'x-nami-isr-revalidate';
```

ISR 路由判断条件：

```typescript
route.renderMode === RenderMode.ISR && config.isr.enabled
```

缓存键默认是：

```typescript
ctx.path
```

也就是说默认不包含 query、Cookie 或 Header。如果页面内容依赖这些因素，需要通过 `generateCacheKey` 自定义缓存键，否则不同变体可能共用同一份缓存。

#### 命中流程

`isrCacheMiddleware` 调用：

```typescript
isrManager.getOrRevalidate(cacheKey, renderFn, revalidateSeconds, backgroundRevalidateFn)
```

`ISRManager` 使用 SWR 语义判断缓存状态：

```text
0 ───────────── revalidateAfter ───────────── revalidateAfter * 2 ─────▶ 时间
      Fresh                      Stale                         Expired
```

| 状态 | 判断 | 行为 |
|------|------|------|
| `Fresh` | 缓存年龄 `<= revalidateAfter` | 直接返回缓存 HTML |
| `Stale` | 超过 `revalidateAfter`，但未超过 `revalidateAfter * staleMultiplier` | 返回旧 HTML，同时后台重新验证 |
| `Expired` | 超过 stale 宽限期 | 不返回旧 HTML，同步重新渲染 |
| 缓存不存在 | 无缓存条目 | 同步渲染并异步写入缓存 |

默认 `staleMultiplier` 是 `2`。例如 `revalidate = 60`：

```text
0-60 秒：Fresh，直接返回 HIT
60-120 秒：Stale，返回旧内容并后台重验证
120 秒后：Expired，同步渲染
```

#### 缓存命中响应头

缓存命中且不是 cache miss 时，中间件直接设置：

| 响应头 | 值 |
|--------|----|
| `Content-Type` | `text/html; charset=utf-8` |
| `X-Nami-Cache` | `HIT` 或 `STALE` |
| `X-Nami-Render-Mode` | `isr` |
| `Cache-Control` | `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}` |
| `ETag` | 缓存条目里的 ETag，可选 |
| `X-Nami-Cache-Age` | 缓存创建至今秒数，可选 |

缓存未命中时，`renderFn` 会执行 `await next()` 进入 `renderMiddleware`。渲染完成后，ISR 中间件读取：

```typescript
{
  html: typeof ctx.body === 'string' ? ctx.body : String(ctx.body || ''),
  tags: ctx.state.namiCacheTags,
}
```

然后由 `ISRManager` 写入缓存。写缓存是异步的，不阻塞本次响应。

#### 后台重验证

Stale 状态下，中间件不会直接在当前请求里重新渲染，而是通过 `revalidateByInternalRequest(ctx)` 发起一次内部 GET 请求：

```typescript
fetch(currentUrl, {
  method: 'GET',
  headers: {
    [NAMI_ISR_REVALIDATE_HEADER]: '1',
    'X-Requested-With': 'nami-isr-revalidate',
  },
});
```

该请求带有 `x-nami-isr-revalidate: 1`，所以再次经过 ISR 中间件时会绕过缓存层，直接进入渲染中间件生成新 HTML，避免“后台重验证又命中 stale 缓存”的循环。

缓存查询失败时，ISR 中间件不会让页面失败，而是降级为直接 `await next()` 渲染，并设置：

```http
X-Nami-Cache: BYPASS
```

### ⑫ `renderMiddleware`：核心页面渲染

源码位置：`packages/server/src/middleware/render-middleware.ts`

渲染中间件只处理：

```text
GET / HEAD
```

其他方法直接 `await next()`。页面渲染流程如下：

```text
1. matchConfiguredRoute(ctx.path, config.routes)
2. createRenderContext(ctx, matchResult, requestId)
3. runtimeProvider() 获取最新 server runtime（开发模式尤其重要）
4. RendererFactory.create({ mode, config, pluginManager, ... })
5. renderer.render(context) 或 streaming renderer.renderToStream(context)
6. applyPluginExtras(ctx, renderContext, result, logger)
7. setResponse(ctx, result, logger)
```

#### 路由未匹配

如果 `matchConfiguredRoute()` 没有匹配到页面路由，渲染中间件不会主动返回 404，而是：

```typescript
await next();
return;
```

由于它是生产管线最内层，通常这意味着请求最终由外层的静态资源中间件回退处理，或者由 Koa 默认 404 语义结束。

#### `RenderContext`

`createRenderContext()` 会从 Koa 上下文构造框架渲染上下文：

| 字段 | 内容 |
|------|------|
| `url` / `path` | 当前请求 URL 和 pathname |
| `query` | 查询参数，只保留字符串和字符串数组 |
| `headers` | 请求头，小写 key |
| `route` | 命中的 `NamiRoute` |
| `params` | 动态路由参数 |
| `koaContext` | method、path、url、querystring、protocol、ip、origin、hostname、secure、cookies |
| `timing.startTime` | 渲染上下文创建时间 |
| `requestId` | 请求 ID |
| `extra` | 每个请求独立的新对象，用于插件和中间件间传递约定字段 |

`extra` 是在每次请求创建 `RenderContext` 时初始化的 `{}`，不会跨请求共享。

#### 渲染器选择

渲染模式取自：

```typescript
matchResult.route.renderMode || config.defaultRenderMode
```

随后通过 `RendererFactory.create()` 创建渲染器。传入的重要参数包括：

| 参数 | 作用 |
|------|------|
| `config` | 全局配置 |
| `pluginManager` | 让渲染器内部触发插件生命周期 |
| `appElementFactory` | 新 SSR 协议下创建 React 元素树 |
| `htmlRenderer` | 兼容 `entry-server.renderToHTML()` |
| `moduleLoader` | 加载页面数据函数 |
| `isrManager` | ISR 渲染器使用 |
| `preferStreaming` | 当 SSR 路由 `meta.streaming === true` 时启用流式偏好 |

创建渲染器失败时，会记录错误并退回 CSR 渲染器。

#### Streaming SSR

当同时满足：

```typescript
renderMode === RenderMode.SSR
  && matchResult.route.meta?.streaming === true
  && ctx.method !== 'HEAD'
  && typeof renderer.renderToStream === 'function'
```

渲染中间件会调用 `renderToStream(context)`。否则调用普通 `renderer.render(context)`。响应写入时，如果 `RenderResult` 标记 `isStreaming` 且包含 `stream`，`ctx.body` 会被设置为流对象。

#### 插件 `extra` 协议

渲染器内部触发插件钩子后，插件可能向 `context.extra` 写入约定字段。`renderMiddleware` 在 `applyPluginExtras()` 中统一消费：

| 字段 | 行为 |
|------|------|
| `__cache_hit === true` 且 `__cache_content` 是字符串 | 用插件缓存内容替换 `result.html`，并写 `X-Nami-Plugin-Cache: HIT` |
| `__custom_headers` | 合并到 `result.headers` |
| `__retry_attempted === true` | 写 `X-Nami-Retry: 1` |
| 任意 `extra` | 挂到 `ctx.state.namiExtra`，供后续逻辑读取 |

#### 响应设置

`setResponse()` 会：

1. 设置 `ctx.status = result.statusCode`。
2. 遍历 `result.headers` 写入响应头。
3. 如果 `result.cacheControl` 存在，生成 `Cache-Control`：

   ```text
   s-maxage=${revalidate}, stale-while-revalidate=${staleWhileRevalidate}
   ```

4. 如果有缓存标签，写入 `X-Nami-Cache-Tags`。
5. 将缓存语义写入 `ctx.state.namiCacheControl`，供外层 `securityMiddleware` 兜底回写。
6. 写入 `ctx.body`：流式结果写 stream，普通结果写 HTML 字符串。

#### 渲染失败降级

渲染过程抛错时，中间件会先记录错误。随后按顺序尝试：

1. 如果插件提供了 `renderContext.extra.__skeleton_fallback`，直接返回骨架屏 HTML，状态码 `200`，响应头 `X-Nami-Render-Mode: skeleton-fallback`。
2. 否则调用 `degradationManager.executeWithDegradation()`，按 `config.fallback` 执行框架降级策略。
3. 将降级结果通过 `setResponse()` 写回。

如果渲染异常没有在这里被降级处理并继续抛出，外层 `errorIsolationMiddleware` 会兜底返回 500 错误页。

---

## 4. 请求类型与短路路径

### 健康检查请求

```text
GET /_health
  -> shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck 短路返回 200
  <- security 写安全头
  <- timing 写 X-Response-Time
```

### 数据预取请求

```text
GET /_nami/data/products/1
  -> shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck 放行
  -> staticServe 入站，因 defer 先进入下游
  -> dataPrefetch 匹配数据 API，执行页面数据函数并返回 JSON
  <- staticServe 通常不会覆盖已生成的数据响应
  <- security / timing 出站补头
```

### 静态资源请求

```text
GET /assets/main.abcdef12.js
  -> shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck 放行
  -> staticServe 入站，defer 到下游
  -> dataPrefetch 放行
  -> 用户/插件中间件
  -> errorIsolation
  -> isrCache 放行
  -> render 路由未匹配，放行
  <- staticServe 从 dist/client 发送文件，并因路径带 hash 设置长期缓存
  <- security / timing 出站补头
```

### ISR 页面缓存命中

```text
GET /blog/hello
  -> ...前置中间件
  -> errorIsolation
  -> isrCache 匹配 ISR 路由并命中缓存
     ├─ Fresh: 直接返回 HIT
     └─ Stale: 返回 STALE，同时后台重验证
  <- 不进入 renderMiddleware
```

### 普通 SSR 页面

```text
GET /dashboard
  -> ...前置中间件
  -> errorIsolation
  -> isrCache 放行
  -> renderMiddleware
     ├─ 路由匹配
     ├─ 构造 RenderContext
     ├─ 创建 SSRRenderer
     ├─ 执行数据预取和 React 渲染
     ├─ 消费插件 extra
     └─ 写 HTML 响应
```

---

## 5. 服务启动与优雅停机

### `startServer()` 启动流程

源码位置：`packages/server/src/server.ts`

`startServer(config, options)` 是生产启动入口。流程：

```text
1. 读取 config.server.port / host / cluster
2. 如果配置 cluster 且当前是主进程：
   -> startMaster()
   -> 主进程只管理 Worker，不创建 Koa app
3. 单进程或 Worker 进程：
   -> createNamiServer(config, options)
   -> app.listen(port, host)
   -> 如果是 Worker，发送 worker:ready 给主进程
   -> 如果 gracefulShutdown 开启，注册 setupGracefulShutdown()
   -> 触发 pluginManager.runParallelHook('onServerStart', { port, host })
   -> 执行 options.onReady()
```

默认服务端配置来自 `packages/shared/src/constants/defaults.ts`：

```typescript
export const DEFAULT_SERVER_CONFIG = {
  port: 3000,
  host: '0.0.0.0',
  ssrTimeout: 5000,
  gracefulShutdown: true,
  gracefulShutdownTimeout: 30000,
};
```

### 优雅停机流程

源码位置：`packages/server/src/middleware/graceful-shutdown.ts`

`setupGracefulShutdown()` 注册 `SIGTERM` 和 `SIGINT` 处理器。核心流程：

```text
SIGTERM / SIGINT
  │
  ▼
设置内部 isShuttingDown，防止重复触发
  │
  ▼
调用 onSignalReceived()
  │  即 createNamiServer 返回的 triggerShutdown()
  │  让 shutdownAware 开始对新请求返回 503
  ▼
server.close()
  │  停止接受新的 TCP 连接，已建立连接继续处理
  ▼
Promise.race([closePromise, timeoutPromise])
  │  默认最多等待 30000ms
  ▼
onShutdown()
  ├─ isrManager.close()
  ├─ pluginManager.dispose()
  └─ options.onShutdown()
  ▼
process.exit(0)
```

活跃请求数通过 HTTP server 事件统计：

```typescript
let activeConnections = 0;

server.on('request', (_req, res) => {
  activeConnections++;
  res.on('finish', () => {
    activeConnections--;
  });
});
```

这个计数主要用于日志和排查。真正停止接收新连接依赖 `server.close()`；等待关闭与超时依赖 `Promise.race()`。

部署到 K8s 时，`terminationGracePeriodSeconds` 应大于 `gracefulShutdownTimeout`。默认超时是 30 秒，建议 K8s 设置 35 秒或更高，给 Node 进程清理和退出留出余量。

---

## 6. 集群模式

### 启用方式

配置中只要存在 `server.cluster`，`startServer()` 就会进入集群判断：

```typescript
server: {
  cluster: {
    workers: 0,
  },
}
```

`workers` 语义来自 `packages/server/src/cluster/master.ts`：

| 配置 | 实际 Worker 数 |
|------|----------------|
| 不配置 `cluster` | 单进程 |
| `workers: 0` 或未传 | CPU 核心数 |
| `workers: 4` | 固定 4 个 |
| `workers: -1` | CPU 核心数减 1，最少 1 个 |

### 主进程职责

源码位置：`packages/server/src/cluster/master.ts`

主进程不处理 HTTP 请求，它负责：

1. 计算 Worker 数量。
2. `cluster.fork()` 创建 Worker。
3. 等待 Worker 发送 `worker:ready`。
4. 所有 Worker 就绪后调用 `onAllWorkersReady()`。
5. 监听 Worker 异常退出并按限制重启。
6. 收到 `SIGTERM` / `SIGINT` 后向所有 Worker 发送 `SIGTERM`。

主进程使用 `worker:ready` 消息判断就绪，而不是只依赖 cluster 的 `online` 事件。原因是 `online` 只表示进程 fork 成功，不能保证 Koa 已经 `app.listen()` 成功；`worker:ready` 是 Worker 在监听端口成功后发送的。

### Worker 职责

源码位置：

- `packages/server/src/server.ts`
- `packages/server/src/cluster/worker.ts`

Worker 进程会创建 Koa 应用并绑定端口。启动成功后发送：

```typescript
process.send({
  type: 'worker:ready',
  workerId,
  pid,
  port,
});
```

每个 Worker 都有独立的 Node.js 进程、事件循环和内存空间。使用内存 ISR 缓存时，各 Worker 的缓存互不共享；如果生产环境多 Worker 或多机器部署且要求 ISR 内容一致，应使用 Redis 等共享缓存适配器。

### 异常重启

主进程监听 `cluster.on('exit')`。以下情况不会重启：

| 退出情况 | 是否重启 |
|----------|----------|
| `code === 0` | 否，认为是正常退出 |
| `signal === 'SIGTERM'` | 否，通常是优雅停机 |
| 非 0 退出码且非 SIGTERM | 是，按频率限制重启 |

默认重启保护：

| 选项 | 默认值 | 作用 |
|------|--------|------|
| `restartDelay` | `1000ms` | 崩溃后延迟重启 |
| `maxRestarts` | `10` | 一个窗口内最多连续重启次数 |
| `restartWindow` | `60000ms` | 重启计数窗口 |

如果 Worker 在窗口内连续崩溃超过上限，主进程会停止重启，避免无限重启消耗 CPU。

### 主进程停机

主进程收到 `SIGTERM` 或 `SIGINT` 后，会对所有 Worker 执行：

```typescript
worker.process.kill('SIGTERM');
```

Worker 收到信号后执行自己的 `setupGracefulShutdown()`。主进程会等待 35 秒，超时后 `process.exit(1)`。这个 35 秒比默认 Worker 优雅停机超时 30 秒多 5 秒。

---

## 7. 开发服务器

源码位置：

- `packages/server/src/dev/dev-server.ts`
- `packages/server/src/dev/hmr-middleware.ts`

`nami dev` 使用的开发服务器不是简单调用 `createNamiServer()`，而是创建自己的 Koa app，并组装开发专用管线：

```text
webpack-dev-middleware
  -> webpack-hot-middleware
  -> timing
  -> requestContext
  -> healthCheck
  -> dataPrefetch
  -> errorIsolation
  -> renderMiddleware
```

与生产服务器相比：

| 能力 | 生产服务器 | 开发服务器 |
|------|------------|------------|
| 静态资源 | `koa-static` 读取 `dist/client` | `webpack-dev-middleware` 从内存编译产物响应 |
| HMR | 无 | `webpack-hot-middleware`，默认 SSE 路径 `/__webpack_hmr` |
| 安全头 | 注册 `securityMiddleware` | 不注册 |
| 停机感知 | 注册 `shutdownAware` | 不注册 |
| 优雅停机 | `startServer()` 按配置注册 | `DevServer.close()` 手动关闭 watcher 和 HTTP server |
| ISR 缓存 | `config.isr.enabled` 时注册 | 不注册 ISR 缓存层 |
| server bundle 更新 | 启动时注入或由运行时提供 | 可通过 `runtimeProvider` 每请求读取最新 runtime |

### Webpack dev middleware

开发服务器动态导入 `webpack`，创建客户端 compiler，并注册：

```typescript
createWebpackDevMiddleware(clientCompiler, {
  publicPath: clientWebpackConfig.output?.publicPath || '/',
});
```

它负责拦截客户端 JS、CSS、source map 等构建产物请求，产物来自 Webpack 内存文件系统，不需要写入磁盘。

### HMR middleware

`createHMRMiddleware()` 把 Express 风格的 `webpack-hot-middleware` 适配成 Koa 中间件。HMR 的核心链路是：

```text
浏览器 EventSource 连接 /__webpack_hmr
  -> Webpack 编译完成
  -> hot middleware 通过 SSE 推送更新消息
  -> 客户端 HMR runtime 下载并替换更新模块
```

适配层需要处理 SSE 的特殊性：SSE 连接建立后响应不会很快 `finish`，所以源码除了监听 `finish` / `close`，还拦截 `res.writeHead` 判断响应头是否已经发送。适配器还有 30 秒超时兜底，避免 Promise 永远挂起。

### SSR 开发模式

如果传入 `serverWebpackConfig`，开发服务器会启动 server compiler 的 watch：

```typescript
activeServerCompiler.watch({ aggregateTimeout: 300 }, callback);
```

服务端 bundle 重新编译后，`renderMiddleware` 可以通过 `runtimeProvider` 在每个请求前拿到最新的 `appElementFactory`、`htmlRenderer`、`moduleLoader`，避免 SSR 使用旧入口或旧页面模块。

---

## 8. 部署注意事项

### K8s

```yaml
spec:
  containers:
    - name: nami-app
      command: ["nami", "start"]
      ports:
        - containerPort: 3000
      livenessProbe:
        httpGet:
          path: /_health
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
  terminationGracePeriodSeconds: 35
```

如果开启 Nami 自身集群模式，可以让命令带上对应配置或 CLI 参数；如果由容器平台横向扩容，通常不需要每个 Pod 内再 fork 过多 Worker。

### PM2

```javascript
module.exports = {
  apps: [{
    name: 'nami-app',
    script: 'nami',
    args: 'start',
    instances: 'max',
    exec_mode: 'cluster',
    kill_timeout: 35000,
  }],
};
```

使用 PM2 cluster 模式时，不建议同时开启 Nami 的 `server.cluster`。否则会形成双层集群：PM2 fork 多个进程，每个进程内部又通过 Node cluster fork 多个 Worker，进程数和端口竞争都更难控制。

### 多机 / 多 Worker 的 ISR

默认 ISR 缓存适配器是 `memory`。它适合本地开发、单进程或对一致性要求不高的场景。多 Worker 或多机器部署时，如果仍使用内存缓存，会出现：

| 问题 | 原因 |
|------|------|
| 不同实例返回不同 HTML | 每个进程有自己的缓存 |
| 后台重验证只更新本进程 | 重验证队列和缓存存储不共享 |
| 按标签失效不完整 | 失效操作只影响当前缓存后端 |

生产多实例部署建议使用 Redis 缓存适配器，并确保所有实例连接同一套 Redis。

---

## 9. 快速排查表

| 现象 | 优先检查 |
|------|----------|
| `/_health` 慢或触发渲染 | 是否改过健康检查路径，或上游代理没有直接请求 `/_health` |
| 页面没有 `X-Request-Id` | `requestContextMiddleware` 是否被绕过，或异常是否发生在它之前 |
| 静态资源缓存不符合预期 | 文件名是否包含 8 位以上十六进制 hash，是否被下游中间件提前处理 |
| 数据预取 API 返回 204 | 路由存在，但没有对应 `getServerSideProps` / `getStaticProps` |
| 数据预取 API 进入页面渲染 | 缺少 `moduleLoader` 且中间件降级到 `await next()` |
| 插件中间件异常没有返回框架 500 页 | 插件中间件位于 `errorIsolation` 上游，需要插件自行处理可预期异常 |
| ISR 一直 `MISS` | 路由是否为 `RenderMode.ISR`，`config.isr.enabled` 是否为 `true`，缓存写入是否失败 |
| ISR 后台重验证循环命中旧缓存 | 检查内部请求头 `x-nami-isr-revalidate: 1` 是否被代理转发 |
| 集群启动后 onReady 不触发 | Worker 是否发送 `worker:ready`，端口是否成功绑定 |
| K8s 滚动更新仍有 5xx | `terminationGracePeriodSeconds` 是否大于 `gracefulShutdownTimeout`，负载均衡是否尊重 `/_health` |

---

## 下一步

- 想了解 ISR 存储和失效策略：阅读 [ISR 与缓存](./isr-and-caching.md)
- 想了解渲染器和降级链：阅读 [错误处理与降级](./error-and-degradation.md)
- 想了解构建产物如何提供 server runtime：阅读 [构建系统](./webpack-build.md)