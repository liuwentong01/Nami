# ISR 与缓存原理

ISR（Incremental Static Regeneration，增量静态再生）让页面在大多数请求中像 SSG 一样直接返回缓存 HTML，同时在缓存变旧后像 SSR 一样重新渲染更新内容。

Nami 的标准服务端链路中，ISR 的 HTML 缓存由 `isrCacheMiddleware + ISRManager + CacheStore` 负责；`ISRRenderer` 主要负责“确实需要重新渲染时产出 HTML”。这点很重要：缓存命中时请求会在中间件层短路，不会进入渲染器。

---

## 1. 源码地图

| 主题 | 源码 |
|------|------|
| ISR 配置类型 | `packages/shared/src/types/config.ts` |
| 默认 ISR 配置与常量 | `packages/shared/src/constants/defaults.ts` |
| 缓存条目与缓存接口 | `packages/shared/src/types/cache.ts` |
| ISR 管理器 | `packages/server/src/isr/isr-manager.ts` |
| SWR 状态判断 | `packages/server/src/isr/stale-while-revalidate.ts` |
| 后台重验证队列 | `packages/server/src/isr/revalidation-queue.ts` |
| 缓存后端工厂 | `packages/server/src/isr/cache-store.ts` |
| 内存缓存 | `packages/server/src/isr/memory-store.ts` |
| 文件系统缓存 | `packages/server/src/isr/filesystem-store.ts` |
| Redis 缓存 | `packages/server/src/isr/redis-store.ts` |
| ISR 缓存中间件 | `packages/server/src/middleware/isr-cache-middleware.ts` |
| 渲染响应头与标签回写 | `packages/server/src/middleware/render-middleware.ts` |
| ISR Renderer | `packages/core/src/renderer/isr-renderer.ts` |
| 服务端装配 | `packages/server/src/app.ts` |
| 插件缓存系统 | `packages/plugin-cache/src/cache-plugin.ts` |

---

## 2. ISR 配置

源码位置：

- `packages/shared/src/types/config.ts`
- `packages/shared/src/constants/defaults.ts`

`ISRConfig`：

```typescript
export interface ISRConfig {
  enabled: boolean;
  cacheDir: string;
  defaultRevalidate: number;
  cacheAdapter: 'filesystem' | 'redis' | 'memory';
  redis?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
  };
}
```

默认值：

```typescript
export const DEFAULT_ISR_CONFIG = {
  enabled: false,
  cacheDir: '.nami-cache/isr',
  defaultRevalidate: 60,
  cacheAdapter: 'memory',
};
```

示例：

```typescript
export default defineConfig({
  isr: {
    enabled: true,
    cacheAdapter: 'redis',
    cacheDir: '.nami-cache/isr',
    defaultRevalidate: 60,
    redis: {
      host: '127.0.0.1',
      port: 6379,
      password: 'secret',
      db: 0,
      keyPrefix: 'nami:isr:',
    },
  },
  routes: [
    {
      path: '/products/:slug',
      component: './pages/product',
      renderMode: 'isr',
      revalidate: 120,
      getStaticProps: 'getStaticProps',
      getStaticPaths: 'getStaticPaths',
      meta: {
        cacheTags: ['product'],
      },
    },
  ],
});
```

配置校验在 `packages/core/src/config/config-validator.ts` 中完成。当前主要校验：

| 项目 | 规则 |
|------|------|
| `isr.enabled === true` 时 | 校验 `isr.defaultRevalidate` |
| `defaultRevalidate` | 必须是 `1` 到 `604800` 秒之间的有限整数 |
| `route.revalidate` | 必须是以秒为单位的非负有限整数，允许 `0` |
| `getStaticProps().revalidate` | 运行时同样要求非负有限整数，允许 `0` |
| `cacheAdapter: 'redis'` | Redis 配置需要满足必填字段 |

`defaultRevalidate` 是全局兜底，所以仍要求至少 `1` 秒；路由值和 GSP 动态值
可以显式返回 `0`，但 `NaN`、`Infinity`、负数和小数都不合法。

---

## 3. 服务端装配位置

源码位置：`packages/server/src/app.ts`

服务启动时：

```text
if (config.isr.enabled)
  -> createCacheStore({ cacheAdapter, cacheDir, redis })
  -> new ISRManager(config.isr, cacheStore)
  -> app.use(isrCacheMiddleware({ config, isrManager }))
```

`createNamiServer()` 返回值里也暴露 `isrManager`：

```typescript
export interface NamiServerInstance {
  app: Koa;
  pluginManager: PluginManager;
  isrManager?: ISRManager;
  degradationManager: DegradationManager;
  triggerShutdown: () => void;
}
```

中间件顺序中，ISR 缓存层位于 `errorIsolation` 之后、`renderMiddleware` 之前：

```text
shutdownAware
timing
security
requestContext
healthCheck
staticServe
用户 middlewares
插件 middlewares
dataPrefetch
errorIsolation
isrCacheMiddleware     仅 isr.enabled 时注册
renderMiddleware
```

因此：

1. ISR 缓存命中时会短路，不进入渲染中间件。
2. 缓存未命中时，`isrCacheMiddleware` 在 `renderFn` 中调用 `await next()`，让请求继续进入 `renderMiddleware` 产出 HTML。
3. ISR 缓存层异常时会降级为直接 `await next()`，并设置 `X-Nami-Cache: BYPASS`。

---

## 4. ISR 缓存中间件

源码位置：`packages/server/src/middleware/isr-cache-middleware.ts`

中间件只处理 GET 请求：

```text
非 GET
  -> next()

GET + x-nami-isr-revalidate: 1 + 可信本机来源 + 可选 token 校验通过
  -> next()，绕过缓存

GET + 匹配 ISR 路由 + isr.enabled
  -> ISRManager.getOrRevalidate()

其他 GET
  -> next()
```

ISR 路由判定：

```typescript
route.renderMode === RenderMode.ISR && config.isr.enabled
```

默认缓存键：

```typescript
function defaultGenerateCacheKey(ctx: Koa.Context): string {
  return ctx.url;
}
```

默认包含 pathname 与原始 query，但不包含 Cookie、Header 或租户身份；query 顺序也不会归一化。页面内容如果依赖额外维度，或希望忽略营销参数，需要在中间件层自定义 `generateCacheKey(ctx)`。

`getOrRevalidate()` 的调用结构：

```typescript
const cacheResult = await isrManager.getOrRevalidate(
  cacheKey,
  async () => {
    await next();
    const renderResult = ctx.state.namiRenderResult as RenderResult | undefined;
    const statusCode = renderResult?.statusCode ?? ctx.status;
    return {
      html: typeof ctx.body === 'string' ? ctx.body : String(ctx.body || ''),
      tags: Array.isArray(ctx.state.namiCacheTags)
        ? ctx.state.namiCacheTags
        : undefined,
      cacheable:
        ctx.state.namiCacheable === true
        && renderResult?.meta.renderMode === RenderMode.ISR,
      statusCode,
      headers: renderResult ? { ...renderResult.headers } : undefined,
      revalidate: renderResult?.cacheControl?.revalidate,
      invalidate:
        renderResult?.meta.degraded !== true
        && (statusCode === 404 || [301, 302, 303, 307, 308].includes(statusCode)),
    };
  },
  revalidateSeconds,
  async () => await revalidateByInternalRequest(ctx),
);
```

命中响应头：

| 状态 | 响应头 |
|------|--------|
| Fresh | `X-Nami-Cache: HIT` |
| Stale | `X-Nami-Cache: STALE` |
| Miss（可缓存） | `X-Nami-Cache: MISS` |
| Miss（不可缓存） | `X-Nami-Cache: SKIP`，并使用 `private, no-store, max-age=0` |
| 缓存故障旁路 | `X-Nami-Cache: BYPASS` |

命中时还会设置：

```http
X-Nami-Render-Mode: isr
X-Nami-Cache-Age: <seconds>
Cache-Control: public, s-maxage=<revalidate>, stale-while-revalidate=<revalidate * 2>
ETag: <etag>    # 若缓存条目含 etag
```

---

## 5. SWR 状态机

源码位置：`packages/server/src/isr/stale-while-revalidate.ts`

SWR 把缓存分成三种状态：

```text
创建时间
  │
  ├── Fresh:  age <= revalidateAfter
  │     直接返回缓存
  │
  ├── Stale:  revalidateAfter < age <= revalidateAfter * staleMultiplier
  │     返回旧缓存，并后台重验证
  │
  └── Expired: age > revalidateAfter * staleMultiplier
        不返回旧缓存，同步重新渲染
```

默认 `staleMultiplier = 2`：

```text
revalidate = 60s

0s ---------------- 60s ---------------- 120s ---------------->
      Fresh                 Stale                  Expired
```

`evaluateCacheFreshness()` 返回：

```typescript
{
  state: SWRState.Fresh | SWRState.Stale | SWRState.Expired,
  age,
  ttl,
  needsRevalidation,
}
```

注意：存储层 TTL 使用“本次渲染最终生效的 `revalidate * 2`”。`getStaticProps` 返回的动态 `revalidate` 优先于路由或全局默认值，因此缓存条目的 Fresh/Stale 窗口不必固定。

---

## 6. `ISRManager.getOrRevalidate()`

源码位置：`packages/server/src/isr/isr-manager.ts`

核心签名：

```typescript
async getOrRevalidate(
  key: string,
  renderFn: () => Promise<ISRRenderPayload | string>,
  revalidateSeconds: number,
  backgroundRevalidateFn?: () => Promise<ISRRenderPayload | string>,
): Promise<ISRCacheResult>
```

有效重验证间隔：

```typescript
const effectiveRevalidate = normalizeRevalidate(
  revalidateSeconds,
  this.config.defaultRevalidate,
);
```

`normalizeRevalidate()` 仅在值未定义或非法时回退；`0` 是合法值，但它不是
“写一条立即过期的持久缓存”。当请求进入管理器时的有效值为 `0`，框架会跳过
`cacheStore.get()` / `set()`、尽力删除该 key 的历史条目，只保留同一 Node
进程内正在执行的 `inFlightRenders` Promise 合并。若 GSP 在渲染后动态返回
`0`，也会删除旧条目并以 `SKIP + private, no-store` 返回本次结果。

流程：

```text
effectiveRevalidate === 0 ? 删除旧条目并跳过 cacheStore.get(key)
  : 读取 cacheStore.get(key)
  │
  ├── 命中 Fresh
  │     -> 返回 cached.content
  │     -> isStale: false
  │     -> isCacheMiss: false
  │
  ├── 命中 Stale
  │     -> revalidationQueue.enqueue(...)
  │     -> 立即返回 cached.content
  │     -> isStale: true
  │     -> isCacheMiss: false
  │
  └── 未命中或 Expired
        -> 复用同 key 的 in-flight 渲染，或创建新的 renderAndCache()
        -> await renderFn()
        -> 解析本次 payload.revalidate（GSP 动态值优先）
        -> redirect/notFound? 删除旧 key，不缓存控制响应
        -> renderedRevalidate === 0? 删除旧 key，不写 CacheStore
        -> 否则 generateETag(html)
        -> await cacheStore.set(key, entry, renderedRevalidate * 2)
        -> 返回新 HTML
        -> isCacheMiss: true
```

未命中和 Expired 的同步渲染路径会按缓存 key 做请求合并：同一 key 已经在渲染时，后续请求会等待并复用同一个 Promise，不会并发触发多次 SSR/数据请求。`revalidate = 0` 也只复用这一层瞬时结果，不会形成持久 HIT/STALE。这个合并只作用于当前 Node 进程；多进程或多机部署仍需要共享缓存后端和上游限流策略。

同步冷渲染写入的 `CacheEntry`：

```typescript
{
  content: html,
  createdAt: Date.now(),
  revalidateAfter: renderedRevalidate,
  tags: tags ?? [],
  etag,
  statusCode,
  headers: cachedHeaders,
}
```

`headers` 只保存可安全重放的端到端响应头。hop-by-hop、
`Content-Length`/`Content-Encoding`、`Set-Cookie`、`Cache-Control`、ETag 和
Nami 命中诊断头会被过滤；ETag 由缓存层基于 HTML 重新生成。Fresh/STALE
命中会恢复条目的 `statusCode` 与安全 headers，再覆盖本次请求自己的
`X-Nami-Cache`、`Cache-Control`、`ETag` 和 age。

同步冷渲染会先解析本次 GSP 返回的动态 `revalidate`，再等待缓存写入结束，最后释放同 key 的并发合并 Promise。这样，等待中的请求拿到完整的 HTML、状态码和响应头契约，也不会在首个写入尚未完成时再次触发冷 MISS。缓存后端写入失败只记录日志，当前页面仍正常返回。

渲染结果只有在状态码为 2xx、渲染模式仍为 ISR、最终 `revalidate > 0`，且没有被降级链标记为不可缓存时才会写入。GSP 的 redirect 仅接受显式 `301/302/303/307/308`（未显式设置时 permanent 为 `308`、临时为 `307`）；redirect 和 `notFound` 会删除旧 key，并以控制响应返回而不写缓存。任何 `RenderResult.meta.degraded === true` 的响应都会显式携带 `X-Nami-Degraded`（保留已有语义值，无值时为 `1`）与 `Cache-Control: private, no-store, max-age=0`；带临时骨架的降级 CSR Shell、Level 3 静态应急页、静态兜底和 503 等不可缓存结果还会返回 `X-Nami-Cache: SKIP`。

---

## 7. 后台重验证队列

源码位置：`packages/server/src/isr/revalidation-queue.ts`

Stale 状态不会阻塞用户请求，而是入队后台任务。

默认配置：

| 项目 | 默认值 |
|------|--------|
| `maxConcurrency` | `2` |
| `timeout` | `30000` ms |

队列能力：

| 能力 | 实现 |
|------|------|
| 去重 | `pendingKeys` + `activeKeys`，同一 key 同时只允许一个被队列跟踪的任务；超时后底层任务可能仍在继续 |
| 并发控制 | `activeCount < maxConcurrency` 才取任务执行 |
| 超时保护 | `Promise.race([renderFn(), timeout])`，只停止等待，不取消底层 render/fetch |
| 失败隔离 | 失败只记录日志，不影响旧缓存 |
| 关闭 | `close()` 停止接受新任务、清空 pending、清理 timer |

成功后写入的缓存条目：

```typescript
{
  content: normalized.html,
  createdAt: Date.now(),
  revalidateAfter: normalized.revalidate,
  tags: normalized.tags,
  etag: generateETag(normalized.html),
  statusCode: normalized.statusCode,
  headers: normalized.headers,
}
```

后台内部请求会从新响应 `Cache-Control` 解析 `s-maxage`，将它作为 `normalized.revalidate`；因此 GSP 在重建时返回的新值会同时更新 `revalidateAfter` 和存储 TTL。若本次未提供新值，才回退到队列中原条目的间隔。

内部请求若收到降级标记或普通 `private/no-store` 失败响应，会拒绝该结果。队列
因此进入失败隔离分支，不执行 `cacheStore.set()`，继续保留并对外提供原来的
stale 内容。redirect（仅 `301/302/303/307/308`）或 `404 notFound` 则属于
业务控制响应：队列删除旧 key，但不把控制响应写成成功页缓存；动态
`revalidate = 0` 同样删除旧 key 且不写新条目。

正常的后台成功页会和同步冷渲染一样生成 ETag，并把安全过滤后的 status/headers
写进 `CacheEntry`。队列的 `pendingKeys` / `activeKeys` 也只在当前进程去重；
`Promise.race()` 超时只让队列忽略结果、释放槽位，无法取消已经开始的底层
render 或内部 fetch，因此业务数据函数仍应支持自身超时/取消并避免不可重入副作用。

---

## 8. 内部重验证请求

源码位置：`packages/server/src/middleware/isr-cache-middleware.ts`

后台重验证默认通过内部 HTTP 请求重新渲染。内部 URL 的网络目标固定到本机
监听地址，不使用入站请求的 `Host` 来选择目标；如果配置了环境变量
`NAMI_ISR_REVALIDATE_TOKEN`，请求还会携带匹配的 token 头：

```typescript
fetch(`http://${serverHost}:${serverPort}${ctx.path}${querystring}`, {
  method: 'GET',
  headers: {
    ...buildInternalRevalidateHeaders(ctx),
    [NAMI_ISR_REVALIDATE_HEADER]: '1',
    'x-nami-isr-revalidate-token': process.env.NAMI_ISR_REVALIDATE_TOKEN,
    'X-Requested-With': 'nami-isr-revalidate',
  },
});
```

请求头常量：

```typescript
NAMI_ISR_REVALIDATE_HEADER = 'x-nami-isr-revalidate'
```

`isrCacheMiddleware` 检测到该头值为 `'1'` 时，还会校验请求来源是可信本机地址；配置了 `NAMI_ISR_REVALIDATE_TOKEN` 时还会校验 token。校验通过后才直接 `next()`，不读缓存，避免后台重验证再次命中旧缓存并重复入队。

虽然网络目标是 loopback，请求仍会从触发 stale 的 `ctx.headers` 端到端转发
`Cookie`、`Authorization`、原始 `Host` 以及 tenant/locale 等业务头。框架只
剔除 hop-by-hop、`Content-Length`、条件请求头和 `Range` 等不能安全重放的
字段。这保证自定义 `generateCacheKey()` 的身份、租户、语言等 vary 语义在
后台重建时不丢失，新 HTML 仍属于触发任务的那个缓存变体。

内部请求完成后会读取响应头：

```http
X-Nami-Cache-Tags: tag1,tag2
```

源码使用小写读取 `x-nami-cache-tags`，HTTP 头大小写不敏感。该响应头由 `render-middleware.ts` 在 `result.cacheControl.tags` 存在时设置。

---

## 9. ISRRenderer 的职责

源码位置：`packages/core/src/renderer/isr-renderer.ts`

标准服务端链路里，ISR 缓存命中由上游中间件处理。走到 `ISRRenderer.render()` 时，通常说明当前请求需要真实渲染，例如缓存未命中、完全过期、或内部重验证请求。

`ISRRenderer` 做这些事：

1. 调用 `beforeRender` 插件钩子。
2. 执行 `prefetchData()`，读取 `getStaticProps`。
3. `redirect` / `notFound` 在 React 前短路为 30x / 稳定静态 404，并标记 `no-store`。
4. 正常 props 写入 `context.initialData`，再执行 React/HTML 渲染。
5. 组装完整 HTML 与注水 envelope。
6. 返回带动态 `revalidate` 与 tags 的 `RenderResult`。

`prefetchData()` 的上下文只有：

```typescript
{
  params: context.params,
}
```

当前不传 query、headers、cookies。

`RenderResult.cacheControl`：

```typescript
{
  revalidate: effectiveRevalidate,
  staleWhileRevalidate: effectiveRevalidate * 2,
  tags: extractCacheTags(context),
}
```

`extractCacheTags()` 会合并：

1. `context.route.meta.cacheTags`
2. `context.extra.cacheTags`

`render-middleware.ts` 会把这些 tags 写入 `ctx.state.namiCacheTags`，供 `isrCacheMiddleware` 在冷渲染后写入缓存条目。

---

## 10. 缓存键差异

这里是 ISR 最容易踩坑的点。

| 位置 | 默认缓存键 |
|------|------------|
| `isrCacheMiddleware` | `ctx.url`（pathname + query） |
| `ISRRenderer.buildCacheKey()` | `context.url`（pathname + query） |

标准服务端链路真正读写 `CacheStore` 的是 `isrCacheMiddleware`。现在外层中间件、core renderer 和 Hydration 的 `routePath` 都采用完整 URL，因此同一路径的不同 query 不会互相污染 HTML 或首屏 props。

命中、Stale、Expired 的判断仍由上游中间件完成；core 中的键用于保持独立使用 renderer 时的同一语义。query 的顺序属于键的一部分，例如 `?a=1&b=2` 与 `?b=2&a=1` 默认是两个条目。

如果页面内容依赖 query，例如：

```text
/products?sort=price
/products?sort=new
```

默认会生成两份 ISR HTML。若业务希望忽略营销参数，或还需要纳入 Cookie、租户等因素，应通过 `generateCacheKey(ctx)` 显式定义缓存维度，并确保页面输出不会超出该维度。

---

## 11. 三种缓存后端

工厂源码：`packages/server/src/isr/cache-store.ts`

```typescript
createCacheStore({
  cacheAdapter,
  cacheDir,
  redis,
  cacheOptions,
})
```

`createNamiServer()` 当前只传 `cacheAdapter`、`cacheDir`、`redis`，没有把 `cacheOptions` 暴露到 `nami.config.ts` 的 `ISRConfig` 中。因此默认 `memory` 最大条目数是 `1000`。

### MemoryStore

源码位置：`packages/server/src/isr/memory-store.ts`

| 项目 | 行为 |
|------|------|
| 存储结构 | `Map<string, MemoryCacheItem>` |
| TTL | `expireAt`，`0` 表示永不过期 |
| LRU | `get()` 命中后删除再插入，移到 Map 末尾 |
| 淘汰 | 超过 `maxEntries` 后从 Map 头部删除约 10% |
| 标签 | `tagIndex: Map<tag, Set<key>>` |
| 统计 | 进程内 hits/misses |

适合开发环境和单进程部署。多进程/多机不共享缓存。

### FilesystemStore

源码位置：`packages/server/src/isr/filesystem-store.ts`

| 项目 | 行为 |
|------|------|
| 目录 | `cacheDir/entries`、`cacheDir/tags` |
| 文件名 | `SHA256(key).json` |
| 条目格式 | `{ entry, expireAt, writtenAt }` |
| 写入 | 先写临时文件，再 `rename` 原子替换 |
| 过期 | `get()` 时发现过期会异步删除条目文件 |
| 标签 | 每个 tag 一个 SHA256 文件，存 key 列表 |
| 统计 | 当前实现为进程内计数 |

文件头注释中出现过 `stats.json`，但实现中没有看到持久化写入 `stats.json` 的逻辑。运维时不要依赖这个文件。

适合同一台机器上的多进程共享，不适合多机部署。

### RedisStore

源码位置：`packages/server/src/isr/redis-store.ts`

Redis key 设计：

```text
{prefix}entry:{key}   -> JSON 序列化 CacheEntry
{prefix}tag:{tag}     -> SET，存该标签关联的缓存 key
{prefix}stats:hits
{prefix}stats:misses
```

| 项目 | 行为 |
|------|------|
| 默认前缀 | `nami:isr:` |
| TTL 写入 | 有 ttl 时使用 `SETEX` |
| 标签索引 | `SADD` / `SMEMBERS` |
| 按标签失效 | 取 SET 后批量删除 entry，再删除 tag key |
| 清空 | `SCAN` + `DEL ${prefix}*`，不是 `FLUSHDB` |
| 连接 | 使用 `ioredis`，`lazyConnect: true` |

Redis 适合多机部署。需要注意：重验证队列仍是每个 Node 进程本地的，多个进程可能同时对同一 key 发起后台重验证，Redis 层不会全局去重队列任务。

---

## 12. 标签与按需失效

缓存条目类型：

```typescript
export interface CacheEntry {
  content: string;
  createdAt: number;
  revalidateAfter: number;
  tags: string[];
  meta?: Record<string, unknown>;
  etag?: string;
  statusCode?: number;
  headers?: Record<string, string>;
}
```

`statusCode` 与 `headers` 让冷 MISS 的完整安全响应语义可以被 Fresh/STALE 命中
重放；后台重建也写入同样字段并生成新 ETag。缓存层不会持久化 hop-by-hop、
`Set-Cookie`、压缩/长度、缓存控制或 Nami 自身诊断头。

标签来源：

1. 路由配置：`route.meta.cacheTags`
2. 插件或渲染链路写入：`context.extra.cacheTags`
3. `render-middleware.ts` 转换为 `ctx.state.namiCacheTags`
4. `isrCacheMiddleware` 冷渲染写缓存时读取 `ctx.state.namiCacheTags`

按完整 URL 精确失效：

```typescript
await isrManager.invalidate('/products/iphone-15?locale=zh');
```

该方法只删除一个 full-URL key，不会自动删除同 pathname 的其他 query 变体。若要让所有变体一起失效，应为它们设置共同 tag，再调用 `invalidateByTag(tag)`。

按标签失效：

```typescript
await isrManager.invalidateByTag('product:123');
```

`packages/shared/src/constants/defaults.ts` 中定义了：

```typescript
ISR_REVALIDATE_PATH = '/_nami/revalidate'
```

但当前仓库热路径中没有看到该常量对应的内置 HTTP handler。也就是说，不应把它写成“开箱即用的 Webhook API”。如果需要 CMS Webhook，可以在持有 `isrManager` 的服务集成层自行注册 Koa 中间件。

示例：

```typescript
const { app, isrManager } = await createNamiServer(config);

app.use(async (ctx, next) => {
  if (ctx.path === '/api/revalidate' && ctx.method === 'POST') {
    const { path, tag } = ctx.request.body as { path?: string; tag?: string };

    if (path) await isrManager?.invalidate(path);
    if (tag) await isrManager?.invalidateByTag(tag);

    ctx.body = { revalidated: true };
    return;
  }

  await next();
});
```

具体 body 解析需要业务项目自己接入 Koa body parser。

---

## 13. 缓存预热

源码位置：`packages/server/src/isr/isr-manager.ts`

`ISRManager.warmup()` 可以预先渲染一组路径：

```typescript
await isrManager.warmup(
  ['/', '/products', '/products/popular-item'],
  async (path) => renderPage(path),
);
```

行为：

1. 顺序遍历路径。
2. 调用 `renderFn(path)`。
3. 生成 ETag。
4. 用 `defaultRevalidate * 2` 作为 TTL 写入缓存。
5. 某个路径失败只记录日志，不影响后续路径。

---

## 14. HTTP 缓存头

ISR 中间件命中时使用：

```typescript
public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}
```

`ISRRenderer` 返回的 `RenderResult.headers` 也包含类似值：

```http
Cache-Control: public, s-maxage=60, stale-while-revalidate=120
```

但 `render-middleware.ts` 在处理 `result.cacheControl` 时会重新设置：

```http
Cache-Control: s-maxage=60, stale-while-revalidate=120
```

也就是说，冷渲染链路最终看到的 `Cache-Control` 可能由 `render-middleware` 的 `cacheControl` 逻辑覆盖，形式上不一定带 `public`。排查 Network 面板时应以最终响应头为准。

---

## 15. ISR 与 `@nami/plugin-cache`

源码位置：`packages/plugin-cache/src/cache-plugin.ts`

Nami 还有一个插件缓存系统，提供 LRU/TTL 策略和 CDN Header 辅助。它与 ISR 是两条不同管线：

| 项目 | ISR 缓存 | `@nami/plugin-cache` |
|------|----------|----------------------|
| 入口 | `isrCacheMiddleware` | 插件钩子 |
| 管理器 | `ISRManager` | `NamiCachePlugin` |
| 缓存对象 | ISR HTML | 插件定义的渲染结果/响应缓存 |
| 失效方式 | path/tag | 插件策略 |
| CDN Header | ISR 中间件/Renderer | `CDNCacheManager` |

插件缓存会在 `onBeforeRender` 读取缓存，命中后由 `BaseRenderer` 在数据预取和 React 渲染之前直接返回；`onAfterRender` 只负责安全响应的写入。为避免双缓存和失效语义冲突，ISR 路由会绕过插件缓存。默认也会绕过携带 `Cookie` 或 `Authorization` 的请求，并拒绝缓存非 2xx、降级、流式、`private/no-store` 或带 `Set-Cookie` 的响应。

不要把 `CDNCacheManager` 的预设值当成 ISR 的运行时缓存头。ISR 默认 `stale-while-revalidate` 是 `revalidate * 2`。

---

## 16. 排查指南

### 页面一直不更新

可能原因：

1. 缓存仍处于 Fresh 状态。
2. Stale 后台重验证失败，旧缓存保留。
3. 页面依赖 Cookie、Header 或租户身份，但默认缓存键只有完整 URL。
4. 使用了 `memory` 后端，多进程/多机间缓存不共享。

建议：

1. 观察 `X-Nami-Cache` 和 `X-Nami-Cache-Age`。
2. 检查日志中的“ISR 后台重验证失败”。
3. 对额外请求维度敏感的页面自定义 `generateCacheKey`。
4. 多机部署使用 Redis。

### 首次访问很慢

这是冷 Miss：`isrCacheMiddleware` 需要执行 `renderMiddleware` 产出 HTML 后才能写缓存。可以通过 `isrManager.warmup()` 预热热门页面。

### Stale 请求仍返回旧内容

这是设计行为。Stale 状态会立即返回旧 HTML，并在后台更新缓存。下一次请求才会看到新 HTML。

### HIT/STALE 的状态码或业务响应头与冷 MISS 不一致

当前同步冷渲染和后台重建都会保存安全过滤后的 `statusCode` / headers 并生成
ETag，HIT/STALE 会恢复它们。若仍不一致，优先检查是否读到了升级前缺少这些
字段的旧条目，或目标头属于 `Set-Cookie`、hop-by-hop、压缩/长度、缓存控制等
明确不会重放的类别；可失效该 key 后重新生成。

---

## 17. 常见误区

### 误区一：`ISRRenderer` 负责所有 ISR 缓存命中判断

标准服务端链路不是这样。缓存命中、Stale 判断、后台重验证主要由 `isrCacheMiddleware + ISRManager` 完成。`ISRRenderer` 负责需要真实渲染时产出 HTML。

### 误区二：默认缓存键会归一化 query 或包含所有请求维度

不会。默认 key 是原始 `ctx.url`，包含 pathname 与 query，但 `?a=1&b=2` 和 `?b=2&a=1` 是两个条目，也不包含 Cookie、Header 或租户身份。需要其他语义时必须自定义 `generateCacheKey()`。

### 误区三：`revalidate: 0` 会回退到全局默认值

不会。`0` 是合法的动态或路由值，但表示“不使用持久 ISR CacheStore”：跳过
读取和写入、清理旧 key，只让同进程并发请求复用正在执行的 singleflight。
它不是 TTL 为 0 的永久条目，也不是一条每次都进入 STALE 的持久条目。只有
`undefined` 或内部防御性归一化遇到非法值时才使用上游默认间隔。

### 误区四：配置里可以直接设置 MemoryStore 的 `maxEntries`

`createCacheStore()` 的工厂支持 `cacheOptions`，但当前 `ISRConfig` 和 `createNamiServer()` 装配没有暴露它。默认 memory 是 `1000` 条。

### 误区五：`/_nami/revalidate` 是已实现的内置 API

当前只看到常量 `ISR_REVALIDATE_PATH`，没有看到对应 HTTP handler。需要按需失效时，应在业务服务集成层自行注册接口并调用 `isrManager.invalidate()` 或 `invalidateByTag()`。

### 误区六：Redis 后端会全局去重后台重验证队列

不会。Redis 共享缓存条目，但同步 `inFlightRenders` 和后台
`RevalidationQueue` 都是每个 Node 进程本地对象，多实例仍可能同时重建同一
key。此外，队列的 `Promise.race()` 超时不会中止底层 render/fetch，只是不再
等待它的结果；需要真正取消时必须由业务调用链显式接入 `AbortSignal` 等机制。

---

## 下一步

- 想了解 ISR 路由如何被匹配：阅读 [路由系统原理](./routing.md)
- 想了解渲染失败时如何降级：阅读 [错误处理与降级](./error-and-degradation.md)
- 想了解服务端中间件顺序：阅读 [服务器与中间件](./server-and-middleware.md)
