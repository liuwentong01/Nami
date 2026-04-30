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
| `defaultRevalidate` | 必须在 `1` 到 `604800` 秒之间 |
| `cacheAdapter: 'redis'` | Redis 配置需要满足必填字段 |

`route.revalidate` 由路由使用方配置，当前没有看到与 `defaultRevalidate` 完全相同的范围校验逻辑。

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
dataPrefetch
用户 middlewares
插件 middlewares
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

GET + x-nami-isr-revalidate: 1
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
  return ctx.path;
}
```

默认不包含 query、Cookie、Header。页面内容如果依赖这些因素，需要在中间件层自定义 `generateCacheKey(ctx)`。否则不同 query 可能共享同一份 ISR HTML。

`getOrRevalidate()` 的调用结构：

```typescript
const cacheResult = await isrManager.getOrRevalidate(
  cacheKey,
  async () => {
    await next();
    return {
      html: typeof ctx.body === 'string' ? ctx.body : String(ctx.body || ''),
      tags: Array.isArray(ctx.state.namiCacheTags)
        ? ctx.state.namiCacheTags
        : undefined,
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
| Miss | `X-Nami-Cache: MISS` |
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

注意：存储层 TTL 写入时使用 `effectiveRevalidate * 2`。这保证 Stale 窗口内缓存仍存在，可以先返回旧 HTML 再后台更新。

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
const effectiveRevalidate = revalidateSeconds || this.config.defaultRevalidate;
```

因此 `revalidate: 0` 不表示永不重验证，而会回退到 `defaultRevalidate`。

流程：

```text
读取 cacheStore.get(key)
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
        -> await renderFn()
        -> generateETag(html)
        -> cacheStore.set(key, entry, effectiveRevalidate * 2)
        -> 返回新 HTML
        -> isCacheMiss: true
```

同步冷渲染写入的 `CacheEntry`：

```typescript
{
  content: html,
  createdAt: Date.now(),
  revalidateAfter: effectiveRevalidate,
  tags: tags ?? [],
  etag,
}
```

写缓存是异步 fire-and-forget，不阻塞响应返回。如果写入失败，只记录日志。

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
| 去重 | `pendingKeys` + `activeKeys`，同一 key 只允许一个任务 |
| 并发控制 | `activeCount < maxConcurrency` 才取任务执行 |
| 超时保护 | `Promise.race([renderFn(), timeout])` |
| 失败隔离 | 失败只记录日志，不影响旧缓存 |
| 关闭 | `close()` 停止接受新任务、清空 pending、清理 timer |

成功后写入的缓存条目：

```typescript
{
  content: normalized.html,
  createdAt: Date.now(),
  revalidateAfter: job.revalidateSeconds,
  tags: normalized.tags,
}
```

注意：后台重验证成功路径当前没有写入 `etag` 字段；同步冷渲染路径会生成 `etag`。

---

## 8. 内部重验证请求

源码位置：`packages/server/src/middleware/isr-cache-middleware.ts`

后台重验证默认通过内部 HTTP 请求重新渲染：

```typescript
fetch(`${ctx.protocol}://${host}${ctx.path}${querystring}`, {
  method: 'GET',
  headers: {
    [NAMI_ISR_REVALIDATE_HEADER]: '1',
    'X-Requested-With': 'nami-isr-revalidate',
  },
});
```

请求头常量：

```typescript
NAMI_ISR_REVALIDATE_HEADER = 'x-nami-isr-revalidate'
```

`isrCacheMiddleware` 检测到该头值为 `'1'` 时直接 `next()`，不读缓存，避免后台重验证再次命中旧缓存并重复入队。

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
3. 把结果写入 `context.initialData`。
4. 执行 React/HTML 渲染。
5. 组装完整 HTML，并通过 `generateDataScript()` 注入数据。
6. 返回带 ISR 缓存语义的 `RenderResult`。

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
  revalidate,
  staleWhileRevalidate: revalidate * 2,
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
| `isrCacheMiddleware` | `ctx.path` |
| `ISRRenderer.buildCacheKey()` | `context.path` + 排序后的 query |

标准服务端链路真正读写 `CacheStore` 的是 `isrCacheMiddleware`，因此默认情况下 ISR HTML 缓存键只包含 pathname，不包含 query。

`ISRRenderer.buildCacheKey()` 会把 query 排序后拼入 key，但在标准链路里它主要用于日志和渲染语义；命中、Stale、Expired 的判断由上游中间件完成。

如果页面内容依赖 query，例如：

```text
/products?sort=price
/products?sort=new
```

默认会共享同一份 ISR HTML。应在服务端集成层为 `isrCacheMiddleware` 提供自定义 `generateCacheKey(ctx)`，把 query 或其他影响内容的因素纳入 key。

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
}
```

标签来源：

1. 路由配置：`route.meta.cacheTags`
2. 插件或渲染链路写入：`context.extra.cacheTags`
3. `render-middleware.ts` 转换为 `ctx.state.namiCacheTags`
4. `isrCacheMiddleware` 冷渲染写缓存时读取 `ctx.state.namiCacheTags`

按路径失效：

```typescript
await isrManager.invalidate('/products/iphone-15');
```

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

不要把 `CDNCacheManager` 的预设值当成 ISR 的运行时缓存头。ISR 默认 `stale-while-revalidate` 是 `revalidate * 2`。

---

## 16. 排查指南

### 页面一直不更新

可能原因：

1. 缓存仍处于 Fresh 状态。
2. Stale 后台重验证失败，旧缓存保留。
3. 页面依赖 query，但默认缓存键只有 `ctx.path`。
4. 使用了 `memory` 后端，多进程/多机间缓存不共享。

建议：

1. 观察 `X-Nami-Cache` 和 `X-Nami-Cache-Age`。
2. 检查日志中的“ISR 后台重验证失败”。
3. 对 query 敏感页面自定义 `generateCacheKey`。
4. 多机部署使用 Redis。

### 首次访问很慢

这是冷 Miss：`isrCacheMiddleware` 需要执行 `renderMiddleware` 产出 HTML 后才能写缓存。可以通过 `isrManager.warmup()` 预热热门页面。

### Stale 请求仍返回旧内容

这是设计行为。Stale 状态会立即返回旧 HTML，并在后台更新缓存。下一次请求才会看到新 HTML。

### ETag 有时不存在

同步冷渲染路径会生成 ETag；后台重验证队列成功写入缓存的路径当前没有写入 ETag。

---

## 17. 常见误区

### 误区一：`ISRRenderer` 负责所有 ISR 缓存命中判断

标准服务端链路不是这样。缓存命中、Stale 判断、后台重验证主要由 `isrCacheMiddleware + ISRManager` 完成。`ISRRenderer` 负责需要真实渲染时产出 HTML。

### 误区二：默认缓存键包含 query

不包含。默认 key 是 `ctx.path`。`ISRRenderer.buildCacheKey()` 包含 query，但标准链路读写 Store 的 key 来自中间件。

### 误区三：`revalidate: 0` 表示永不过期

不是。`getOrRevalidate()` 使用 `revalidateSeconds || defaultRevalidate`，`0` 会回退到全局默认值。

### 误区四：配置里可以直接设置 MemoryStore 的 `maxEntries`

`createCacheStore()` 的工厂支持 `cacheOptions`，但当前 `ISRConfig` 和 `createNamiServer()` 装配没有暴露它。默认 memory 是 `1000` 条。

### 误区五：`/_nami/revalidate` 是已实现的内置 API

当前只看到常量 `ISR_REVALIDATE_PATH`，没有看到对应 HTTP handler。需要按需失效时，应在业务服务集成层自行注册接口并调用 `isrManager.invalidate()` 或 `invalidateByTag()`。

### 误区六：Redis 后端会全局去重后台重验证队列

不会。Redis 共享缓存条目，但 `RevalidationQueue` 是每个 Node 进程本地对象。

---

## 下一步

- 想了解 ISR 路由如何被匹配：阅读 [路由系统原理](./routing.md)
- 想了解渲染失败时如何降级：阅读 [错误处理与降级](./error-and-degradation.md)
- 想了解服务端中间件顺序：阅读 [服务器与中间件](./server-and-middleware.md)
