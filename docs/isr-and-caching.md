# ISR 与缓存

增量静态再生（ISR）是 Nami 的核心高级特性，结合 SSG 的性能优势和 SSR 的数据新鲜度。本文档深入讲解 ISR 的完整实现原理。

---

## 1. ISR 配置

```typescript
// nami.config.ts
export default defineConfig({
  isr: {
    enabled: true,
    defaultRevalidate: 60,          // 默认 60 秒重验证
    cacheAdapter: 'redis',          // 'memory' | 'filesystem' | 'redis'
    cacheDir: '.nami-cache/isr',    // filesystem 模式的缓存目录
    redis: {                        // redis 模式的连接配置
      host: '127.0.0.1',
      port: 6379,
      password: 'xxx',
      db: 0,
      keyPrefix: 'nami:isr:',      // Redis key 前缀，避免与其他应用冲突
    },
  },
  routes: [
    {
      path: '/products/:slug',
      component: './pages/product',
      renderMode: 'isr',
      revalidate: 120,              // 路由级覆盖：120 秒（优先于 defaultRevalidate）
      getStaticProps: 'getStaticProps',
      meta: { cacheTags: ['product'] },
    },
  ],
});
```

> **开发建议**：开发环境使用 `memory`（零配置），单机多进程用 `filesystem`，生产多机部署用 `redis`。三种后端对上层完全透明，切换只需改 `cacheAdapter` 一行。

## 2. SWR（Stale-While-Revalidate）策略

ISR 的核心是 SWR 策略，将缓存分为三种状态：

```
时间轴:
  创建          revalidate       revalidate × staleMultiplier     TTL
   │              (60s)              (120s)                       │
   ├──── Fresh ────┼──── Stale ──────────┼──── Expired ──────────┤
   │  直接返回缓存  │  返回旧内容+后台重验证 │  同步渲染(阻塞请求)    │
```

### 状态判断逻辑

```typescript
// packages/server/src/isr/stale-while-revalidate.ts
function evaluateCacheFreshness(createdAt, revalidateAfter, options?) {
  const age = (Date.now() - createdAt) / 1000;  // 缓存年龄（秒）
  const staleThreshold = revalidateAfter;        // Fresh → Stale 的边界
  const expiredThreshold = revalidateAfter * (options?.staleMultiplier ?? 2);  // Stale → Expired 的边界

  if (age <= staleThreshold) return { state: SWRState.Fresh, age, ttl };
  if (age <= expiredThreshold) return { state: SWRState.Stale, age, ttl };
  return { state: SWRState.Expired, age, ttl };
}
```

> **为什么要有 Stale 窗口而不直接过期？**
> 这是 SWR 策略的核心价值：用户始终能立即获得响应（即使是稍旧的内容），而不需要等待重新渲染。对于电商商品页来说，一个 60 秒前的价格比"加载中"好得多。后台重验证在用户无感知的情况下更新缓存，下一个请求就能拿到最新内容。

### 缓存 TTL 设计

缓存存储的 TTL 设置为 `revalidateSeconds × 2`（即 `staleMultiplier` 倍），确保 Stale 窗口内缓存仍然存在可供返回：

```
revalidate = 60s, staleMultiplier = 2
存储层 TTL = 120s (60 × 2)

0s────────60s──────────120s
   Fresh      Stale       ← 缓存在 120s 时被存储后端自动删除
                          ← 120s 后的请求走 Expired → 同步渲染（阻塞用户）
```

**要点**：存储层 TTL 必须 ≥ `revalidate × staleMultiplier`，否则缓存会在 Stale 窗口内就被后端自动删除，用户在 Stale 期间反而拿不到旧内容，失去了 SWR 的意义。

## 3. ISRManager 核心流程

```typescript
// packages/server/src/isr/isr-manager.ts
async getOrRevalidate(
  key: string,
  renderFn: () => Promise<string>,
  revalidateSeconds: number,
  backgroundRevalidateFn?: () => Promise<string>,  // 可选：后台重验证使用的渲染函数
): Promise<ISRCacheResult> {
  // 1. 尝试读取缓存
  const cached = await this.cacheStore.get(key);

  if (cached) {
    const evaluation = evaluateCacheFreshness(cached.createdAt, cached.revalidateAfter);

    switch (evaluation.state) {
      case SWRState.Fresh:
        // 直接返回缓存内容，响应时间 < 1ms
        return { html: cached.content, isStale: false, isCacheMiss: false };

      case SWRState.Stale:
        // 返回旧内容给用户（无延迟），同时后台触发重验证
        // 如果提供了 backgroundRevalidateFn 则使用它（如通过内部 HTTP 请求重验证）
        // 否则直接使用 renderFn
        this.revalidationQueue.enqueue(
          key, backgroundRevalidateFn ?? renderFn, revalidateSeconds, cached.tags,
        );
        return { html: cached.content, isStale: true, isCacheMiss: false };

      case SWRState.Expired:
        break; // 缓存完全过期，走下方同步渲染
    }
  }

  // 2. 缓存未命中或完全过期 — 同步渲染（此时用户需要等待）
  const html = await renderFn();
  const etag = generateETag(html);

  // 3. 异步写入缓存（不阻塞响应返回）
  // TTL = revalidateSeconds × 2，确保 Stale 窗口内缓存仍然存在
  void this.cacheStore.set(key, entry, revalidateSeconds * 2);

  return { html, isStale: false, isCacheMiss: true, etag };
}
```

> **backgroundRevalidateFn 的作用**：ISR 缓存中间件会提供一个通过内部 HTTP 请求重新渲染的函数（`revalidateByInternalRequest`），这样后台重验证走完整的中间件管线，包括路由匹配和数据预取。如果不提供此参数，则直接使用传入的 `renderFn`。

## 4. 后台重验证队列

`RevalidationQueue` 管理异步重渲染任务，防止高并发下服务被压垮。

### 核心特性

```
入队请求
    │
    ▼
去重检查 ─── key 已在队列中? ──▶ 跳过（避免重复渲染）
    │ 不在
    ▼
加入 pendingQueue
    │
    ▼
processQueue()
    │
    ├── activeCount < maxConcurrency? ──▶ 否: 等待
    │     是
    ▼
executeJob(job)
    │
    ├── Promise.race([ renderFn(), timeout ])
    │     │
    │     ├── 成功 → cacheStore.set(key, html, TTL = revalidate × 2)
    │     │
    │     └── 失败 → 保留旧缓存，记录日志
    │
    └── finally: activeCount--, processQueue() // 取下一个任务
```

### 配置

```typescript
{
  maxConcurrency: 2,     // 最多同时执行 2 个重验证任务
  timeout: 30000,        // 单个任务最大 30 秒
}
```

### 防止递归缓存命中

后台重验证使用 `revalidateByInternalRequest` 向自身发送 HTTP 请求时，会携带特殊请求头 `X-Nami-ISR-Revalidate: 1`。ISR 缓存中间件检测到此头后会 bypass 缓存层，直接走渲染流程，避免"重验证命中旧缓存"的递归问题。

```
正常请求:     GET /products/123 → ISR 缓存层 → [命中] → 返回旧内容
                                              → [触发后台重验证]

重验证请求:   GET /products/123              → ISR 缓存层
              X-Nami-ISR-Revalidate: 1         → [检测到 header，bypass]
                                               → renderMiddleware → 新 HTML
                                               → 写入缓存

下次正常请求: GET /products/123 → ISR 缓存层 → [命中新缓存] → 返回新内容
```

## 5. 三种缓存后端

### MemoryStore（进程内存）

```typescript
isr: { cacheAdapter: 'memory' }
```

- **实现**：`Map` + LRU 淘汰（`get` 时移到尾部）
- **TTL**：`set` 时计算过期时间，`get` 时检查
- **标签**：`tagIndex: Map<tag, Set<key>>` 反查
- **优点**：零延迟、无外部依赖
- **缺点**：进程重启丢失、多进程不共享
- **适用**：开发环境、单进程部署

### FilesystemStore（文件系统）

```typescript
isr: { cacheAdapter: 'filesystem', cacheDir: '.nami-cache/isr' }
```

- **实现**：`entries/` 存缓存条目、`tags/` 存标签索引（JSON）
- **文件名**：`SHA256(key).json`
- **原子写入**：先写 `.tmp` 文件再 `rename`，防止读到半写入的内容
- **标签**：每个 tag 对应 `tags/<tag>.json` 文件，存 key 列表
- **优点**：多进程共享（同一台机器）、重启不丢失
- **缺点**：IO 开销、不支持多机
- **适用**：单机多进程部署

### RedisStore（Redis）

```typescript
isr: {
  cacheAdapter: 'redis',
  redis: { host: '127.0.0.1', port: 6379, keyPrefix: 'nami:isr:' }
}
```

- **实现**：ioredis 客户端
- **存储**：`SETEX key TTL value`（JSON 序列化）
- **标签**：每个 tag 对应一个 Redis `SET`，存关联的 key
- **批量失效**：pipeline 批量删除 SET 中的 key
- **优点**：多机共享、原生 TTL、高性能
- **缺点**：外部依赖
- **适用**：分布式多机生产环境

## 6. 按需失效

### 按路径失效

```typescript
await isrManager.invalidate('/products/iphone-15');
```

直接从缓存后端删除指定 key。

### 按标签批量失效

```typescript
// 产品更新后，失效所有关联页面
await isrManager.invalidateByTag('product:123');
```

流程：
1. 从标签索引中查找所有关联的缓存 key
2. 批量删除这些 key
3. 清除标签索引

### Webhook 触发失效

可以在 CMS Webhook 中调用失效 API：

```typescript
// 自定义中间件处理 Webhook
api.addServerMiddleware(async (ctx, next) => {
  if (ctx.path === '/api/revalidate' && ctx.method === 'POST') {
    const { path, tag } = ctx.request.body;
    if (path) await isrManager.invalidate(path);
    if (tag) await isrManager.invalidateByTag(tag);
    ctx.body = { revalidated: true };
    return;
  }
  await next();
});
```

## 7. 缓存预热

在服务启动后预先渲染热门页面，确保首批请求命中缓存：

```typescript
await isrManager.warmup(
  ['/', '/products', '/products/popular-item'],
  async (path) => {
    // 渲染指定路径的页面
    return await renderPage(path);
  },
);
```

`warmup` 顺序执行，逐页渲染并写入缓存。失败的页面会被跳过，不影响其他页面。

## 8. ISR 中间件与渲染中间件的协作

```
GET /products/iphone-15
    │
    ▼
isrCacheMiddleware
    │
    ├── 匹配路由 → renderMode === 'isr'?
    │     否 → await next() → 进入 renderMiddleware
    │     是 ↓
    │
    ├── 检查 X-Nami-ISR-Revalidate 头
    │     有 → bypass，await next()（防止重验证递归）
    │
    ├── isrManager.getOrRevalidate(cacheKey, renderFn, revalidate, bgRenderFn)
    │     │
    │     │  renderFn = async () => {
    │     │    await next();  // 触发 renderMiddleware
    │     │    return ctx.body;
    │     │  }
    │     │
    │     │  bgRenderFn = async () => {
    │     │    return revalidateByInternalRequest(ctx);  // 内部 HTTP 请求
    │     │  }
    │     │
    │     ├── [命中 Fresh/Stale] → 直接写 ctx.body, 设置响应头
    │     └── [未命中] → 执行 renderFn (触发真实渲染) → 缓存结果 → 返回
    │
    └── 设置 ISR 相关响应头:
        X-Nami-Cache: HIT/MISS/STALE
        X-Nami-Cache-Age: <seconds>
        ETag: <hash>
```

## 9. 监控与调试

### 缓存统计

```typescript
const stats = await isrManager.getStats();
// {
//   totalEntries: 89,    // 当前缓存条目数
//   hits: 1234,          // 缓存命中次数
//   misses: 56,          // 缓存未命中次数
//   hitRate: 0.9566,     // 命中率（0-1）
//   sizeBytes: 524288,   // 缓存占用字节数（如可获取）
//   lastUpdated: 1712001234567,  // 最后更新时间戳
//   queueStatus: {
//     pending: 2,        // 等待中的重验证任务
//     active: 1,         // 执行中的重验证任务
//     maxConcurrency: 2  // 最大并发数
//   }
// }
```

> **监控建议**：关注 `hitRate`（低于 0.5 说明缓存策略需要调整）和 `queueStatus.pending`（持续增长说明重验证速度跟不上请求量，考虑增加 `maxConcurrency`）。

### 响应头观察

```bash
curl -I https://example.com/products/iphone-15

# 缓存命中（新鲜）
X-Nami-Cache: HIT
X-Nami-Cache-Age: 30
Cache-Control: public, s-maxage=60, stale-while-revalidate=60

# 缓存命中（陈旧，已触发后台重验证）
X-Nami-Cache: STALE
X-Nami-Cache-Age: 75

# 缓存未命中（首次渲染）
X-Nami-Cache: MISS
```

## 10. 常见问题与注意事项

### ISR 页面更新延迟

**现象**：CMS 后台更新了内容，但页面还是旧的。

**原因**：ISR 缓存尚未过期，需要等到 `revalidate` 时间后才会触发后台重验证。

**解决**：使用按需失效（`invalidate` 或 `invalidateByTag`），在 CMS Webhook 中主动触发缓存清除，而不是等待自然过期。

### 多进程 / 多机缓存不一致

**现象**：不同的请求看到不同版本的内容。

**原因**：使用了 `memory` 缓存适配器，每个进程/机器有独立的缓存副本。

**解决**：多进程部署使用 `filesystem`（同一台机器共享文件系统），多机部署使用 `redis`。

### 重验证队列堆积

**现象**：`queueStatus.pending` 持续增长。

**原因**：`maxConcurrency` 不够或渲染速度跟不上请求量。

**解决**：增加 `maxConcurrency`（注意服务端 CPU/内存承受能力），或延长 `revalidate` 间隔减少重验证频率。

### getStaticProps 与 getServerSideProps 的区别

| 特性 | getStaticProps (ISR/SSG) | getServerSideProps (SSR) |
|------|--------------------------|--------------------------|
| 执行时机 | 构建时 + 重验证时 | 每次请求 |
| 结果缓存 | 缓存后复用 | 不缓存 |
| 可访问信息 | `params`, `path` | `params`, `query`, `headers`, `cookies` |
| 适用渲染模式 | SSG, ISR | SSR |

> **注意**：`getStaticProps` 执行时无法访问请求头和 Cookie，因为它可能在构建时执行，此时没有 HTTP 请求上下文。如果你的数据依赖用户身份（Cookie / Token），应使用 SSR + `getServerSideProps`。

---

## 下一步

- 想了解完整的服务器中间件管线？→ [服务器与中间件](./server-and-middleware.md)
- 想了解渲染失败时的降级策略？→ [错误处理与降级](./error-and-degradation.md)
