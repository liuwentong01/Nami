# ISR 与缓存（8 题）

---

## 题目 33：ISR 的 stale-while-revalidate 语义是什么？请解释三种缓存状态。⭐⭐⭐

**答案：**

Stale-While-Revalidate（SWR）是 ISR 缓存策略的核心，将缓存条目划分为三种状态：

```
假设 revalidate = 60 秒，staleMultiplier = 2

时间轴:
0s          60s                     120s
├── Fresh ──┼──── Stale ────────────┼──── Expired ──→
   直接返回     返回旧缓存+后台更新      必须同步重新渲染
```

### Fresh（新鲜）：0 ~ revalidate 秒

```
请求进入 → 缓存命中 → 直接返回缓存内容
```
- 零渲染成本，响应速度最快
- 不触发任何更新操作

### Stale（过期但可用）：revalidate ~ revalidate×2 秒

```
请求进入 → 缓存命中 → 立即返回旧缓存（用户零等待）
                      ↓
                      后台异步触发重验证（RevalidationQueue）
                      → 重新渲染 → 更新缓存
```
- 用户体验：和 Fresh 完全一样快
- 数据新鲜度：下一个请求将获得更新后的内容
- **关键优势**：用户不需要等待数据刷新

### Expired（过期不可用）：> revalidate×2 秒

```
请求进入 → 缓存过期 → 必须同步重新渲染 → 返回新内容
```
- 等同于一次普通 SSR 请求
- 新内容写入缓存，开始新的 Fresh 周期

**源码实现：**

```typescript
// packages/server/src/isr/stale-while-revalidate.ts
function evaluateCacheFreshness(entry, revalidateAfter, staleMultiplier = 2) {
  const age = (Date.now() - entry.createdAt) / 1000;
  const maxStaleAge = revalidateAfter * staleMultiplier;

  if (age <= revalidateAfter) return { state: 'fresh', needsRevalidation: false };
  if (age <= maxStaleAge)     return { state: 'stale', needsRevalidation: true };
  return { state: 'expired', needsRevalidation: true };
}
```

**为什么 TTL = revalidate × 2？**

缓存存储的 TTL 设为 `revalidate × 2`，覆盖 Fresh + Stale 两个窗口。超过这个时间缓存自动清除（Expired 状态），强制同步渲染。

**源码参考：**
- `packages/server/src/isr/stale-while-revalidate.ts` — evaluateCacheFreshness()
- `packages/server/src/isr/isr-manager.ts` — getOrRevalidate()

---

## 题目 34：ISR 的重验证队列（RevalidationQueue）是如何设计的？如何防止重复重验证？⭐⭐⭐⭐

**答案：**

### 核心设计

RevalidationQueue 管理后台重验证任务，有三个关键约束：

1. **去重（Deduplication）**：同一个 key 不会同时出现两个重验证任务
2. **并发控制**：最多同时执行 `maxConcurrency`（默认 2）个重验证
3. **超时保护**：单个任务不能无限执行

### 数据结构

```typescript
class RevalidationQueue {
  private queue: RevalidationJob[];        // 等待执行的任务队列（FIFO）
  private pendingKeys: Set<string>;        // 已排队但未执行的 key
  private activeKeys: Set<string>;         // 正在执行的 key
  private activeCount: number;             // 当前并发数
  private activeTimers: Map<string, NodeJS.Timeout>; // 超时定时器
}
```

### 去重机制

```typescript
enqueue(key, renderFn, options) {
  // 如果 key 已在队列中或正在执行，直接跳过
  if (this.pendingKeys.has(key) || this.activeKeys.has(key)) {
    logger.debug(`重验证已在进行中，跳过: ${key}`);
    return;
  }

  this.queue.push({ key, renderFn, options });
  this.pendingKeys.add(key);
  this.processQueue(); // 尝试处理队列
}
```

### 并发控制

```typescript
processQueue() {
  while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
    const job = this.queue.shift();      // FIFO 出队
    this.pendingKeys.delete(job.key);     // 从等待移到执行
    this.activeKeys.add(job.key);
    this.activeCount++;
    this.executeJob(job);                 // 异步执行，不 await
  }
}
```

### 超时保护

```typescript
executeJob(job) {
  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Revalidation timeout')),
      this.timeout
    );
    this.activeTimers.set(job.key, timer); // 记录定时器用于清理
  });

  Promise.race([job.renderFn(), timeoutPromise])
    .then(html => {
      // 成功：更新缓存
      this.cacheStore.set(job.key, html);
    })
    .catch(error => {
      // 失败：保留旧缓存不动
      logger.error('重验证失败', { key: job.key, error });
    })
    .finally(() => {
      this.activeKeys.delete(job.key);
      this.activeCount--;
      clearTimeout(this.activeTimers.get(job.key));
      this.activeTimers.delete(job.key);
      this.processQueue(); // 处理下一个任务
    });
}
```

### 关闭时清理

```typescript
async close() {
  // 清除所有超时定时器
  for (const timer of this.activeTimers.values()) {
    clearTimeout(timer);
  }
  this.activeTimers.clear();
  this.queue.length = 0;
  this.pendingKeys.clear();
}
```

**为什么失败后保留旧缓存？**

ISR 的理念是"有内容总比没内容好"。重验证失败时，旧缓存（虽然过期）仍然是有效的页面内容，比 503 错误体验好得多。

**源码参考：**
- `packages/server/src/isr/revalidation-queue.ts`

---

## 题目 35：Nami 支持哪三种缓存后端？各自的适用场景和实现特点是什么？⭐⭐⭐⭐

**答案：**

### 1. Memory Store（内存缓存）

```typescript
class MemoryStore implements CacheStore {
  private cache: Map<string, CacheEntry>;
  private tagIndex: Map<string, Set<string>>; // tag → keys 反向索引
}
```

**LRU 驱逐策略：**
```typescript
evict() {
  if (this.cache.size > this.maxEntries) {
    // 删除最早的 10% 条目
    const deleteCount = Math.ceil(this.maxEntries * 0.1);
    const keys = [...this.cache.keys()].slice(0, deleteCount);
    keys.forEach(k => this.cache.delete(k));
  }
}
```

| 优势 | 劣势 |
|------|------|
| 读写最快（纳秒级） | 进程重启后丢失 |
| 无外部依赖 | 单进程内有效 |
| 实现简单 | 内存受限 |

**适用场景：** 开发环境、单进程部署、内存足够的小型应用

### 2. Filesystem Store（文件系统缓存）

```typescript
class FilesystemStore implements CacheStore {
  // 目录结构
  // cacheDir/entries/  — JSON 缓存文件（文件名 = SHA-256(key)）
  // cacheDir/tags/     — tag 索引文件
  // cacheDir/stats.json — 统计信息
}
```

**原子写入（防止竞态条件）：**
```typescript
async set(key, entry) {
  const tempPath = path.join(dir, `.tmp-${Date.now()}-${Math.random()}`);
  await fs.writeFile(tempPath, JSON.stringify(entry));  // 写临时文件
  await fs.rename(tempPath, finalPath);                  // 原子重命名
}
```

**Key 到文件名的转换（防止路径穿越）：**
```typescript
keyToFilename(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}
```

| 优势 | 劣势 |
|------|------|
| 多进程共享（PM2 cluster） | I/O 速度受磁盘限制 |
| 进程重启后保留 | 不支持多机共享 |
| 无外部依赖 | 需要磁盘空间管理 |

**适用场景：** 单机多进程部署（PM2 cluster mode）

### 3. Redis Store（分布式缓存）

```typescript
class RedisStore implements CacheStore {
  // Key 设计
  // {prefix}entry:{key}     → JSON 字符串（缓存条目）
  // {prefix}tag:{tagName}   → Redis SET（该 tag 关联的所有 key）
  // {prefix}stats:hits      → 计数器
  // {prefix}stats:misses    → 计数器
}
```

**Pipeline 优化（批量操作）：**
```typescript
async set(key, entry) {
  const pipeline = this.client.pipeline();
  pipeline.setex(`${prefix}entry:${key}`, ttl, JSON.stringify(entry));
  for (const tag of entry.tags) {
    pipeline.sadd(`${prefix}tag:${tag}`, key);
  }
  await pipeline.exec(); // 一次网络往返完成所有操作
}
```

**安全清理（SCAN 而非 KEYS）：**
```typescript
async clear() {
  let cursor = '0';
  do {
    const [newCursor, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    if (keys.length) await this.client.del(...keys);
    cursor = newCursor;
  } while (cursor !== '0');
}
```

| 优势 | 劣势 |
|------|------|
| 多机共享 | 额外的 Redis 运维 |
| 高性能（毫秒级） | 网络延迟 |
| 原生 TTL 支持 | 需要 ioredis 依赖 |

**适用场景：** 多机分布式部署、K8s 多 Pod

**工厂创建：**
```typescript
function createCacheStore(config): CacheStore {
  switch (config.isr.cacheAdapter) {
    case 'memory':     return new MemoryStore(config);
    case 'filesystem': return new FilesystemStore(config);
    case 'redis':      return new RedisStore(config);
  }
}
```

**源码参考：**
- `packages/server/src/isr/memory-store.ts`
- `packages/server/src/isr/filesystem-store.ts`
- `packages/server/src/isr/redis-store.ts`
- `packages/server/src/isr/cache-store.ts` — 工厂

---

## 题目 36：ISR 缓存的 tag-based invalidation 是什么？它解决了什么问题？⭐⭐⭐⭐

**答案：**

### 问题：如何按业务维度失效缓存？

假设一个电商商品被修改了，需要失效所有包含这个商品的页面：

```
/products/123           — 商品详情页
/categories/electronics — 分类列表页（包含商品 123）
/search?q=phone        — 搜索结果页（包含商品 123）
```

如果只能按 URL 逐个失效，需要知道所有受影响的页面，非常困难。

### 解决方案：Cache Tags（缓存标签）

在缓存时给每个条目打上业务标签：

```typescript
// 商品详情页缓存
key: '/products/123'
tags: ['product:123', 'category:electronics']

// 分类页缓存
key: '/categories/electronics'
tags: ['category:electronics', 'product:123', 'product:456']

// 搜索结果页缓存
key: '/search?q=phone'
tags: ['product:123', 'product:789']
```

当商品 123 更新时，只需要：

```typescript
await isrManager.invalidateByTag('product:123');
// 自动失效所有带有 'product:123' 标签的缓存条目
// → /products/123, /categories/electronics, /search?q=phone 全部失效
```

### 实现原理

**反向索引：** 维护 tag → keys 的映射

```
Memory Store:  Map<string, Set<string>>
Filesystem Store: cacheDir/tags/product-123.json → ["key1", "key2"]
Redis Store:   SADD prefix:tag:product:123 key1 key2 key3
```

```typescript
// ISRManager.invalidateByTag()
async invalidateByTag(tag: string): Promise<number> {
  const keys = await this.store.getKeysByTag(tag);
  for (const key of keys) {
    await this.store.delete(key);
  }
  return keys.length; // 返回失效条目数
}
```

### Tags 的来源

```typescript
// 在 getStaticProps 中设置
export async function getStaticProps(context) {
  const product = await api.getProduct(context.params.id);
  return {
    props: { product },
    revalidate: 300,
    tags: [`product:${product.id}`, `category:${product.category}`],
  };
}
```

ISRRenderer 从路由的 `meta.cacheTags` 或 `context.extra.cacheTags` 中提取 tags，存入缓存条目。

**源码参考：**
- `packages/server/src/isr/isr-manager.ts` — invalidateByTag()
- `packages/server/src/isr/memory-store.ts` — tagIndex
- `packages/server/src/isr/redis-store.ts` — SADD/SMEMBERS

---

## 题目 37：ISR 缓存中间件如何防止递归缓存？⭐⭐⭐⭐

**答案：**

### 问题场景

ISR 缓存未命中时，需要后台重验证。Nami 的 `revalidateByInternalRequest()` 通过发送一个内部 HTTP 请求到自身来触发重新渲染：

```
原始请求 GET /products/123
  → ISR 中间件：缓存 Stale → 返回旧缓存 + 触发后台重验证
    → 后台：内部请求 GET /products/123
      → ISR 中间件：又触发缓存检查...
        → 又触发后台重验证...
          → 无限循环！
```

### 解决方案：请求头标记

```typescript
// 后台重验证时，添加特殊请求头
async function revalidateByInternalRequest(url: string) {
  const response = await fetch(url, {
    headers: {
      'X-Nami-ISR-Revalidate': '1',  // 标记这是重验证请求
    },
  });
  return response.text();
}
```

```typescript
// ISR 缓存中间件检查这个头
function isrCacheMiddleware(ctx, next) {
  // 如果是重验证请求，跳过缓存层直接渲染
  if (ctx.headers['x-nami-isr-revalidate'] === '1') {
    ctx.set('X-Nami-Cache', 'BYPASS');
    await next(); // 直接进入渲染中间件
    return;
  }

  // 正常的缓存逻辑...
}
```

### 完整流程

```
用户请求 GET /products/123
  → ISR 中间件：缓存 Stale
  → 返回旧缓存给用户（X-Nami-Cache: STALE）
  → 后台发起内部请求 GET /products/123 + X-Nami-ISR-Revalidate: 1
    → ISR 中间件：检测到 Revalidate 头 → BYPASS 缓存
    → 直接进入渲染中间件 → getStaticProps() → renderToString()
    → 返回新 HTML
  → 新 HTML 写入缓存
  → 下一个用户请求获得新内容
```

**源码参考：**
- `packages/server/src/middleware/isr-cache-middleware.ts` — bypass 检查（154-157 行）
- `packages/server/src/middleware/isr-cache-middleware.ts` — revalidateByInternalRequest()（278-302 行）

---

## 题目 38：ISR 缓存的 key 是如何生成的？为什么需要对查询参数排序？⭐⭐⭐

**答案：**

### 缓存 Key 生成

```typescript
function generateCacheKey(context: RenderContext): string {
  let key = context.path;

  // 将查询参数排序后拼接
  const queryEntries = Object.entries(context.query).sort(([a], [b]) => a.localeCompare(b));
  if (queryEntries.length > 0) {
    const queryString = queryEntries.map(([k, v]) => `${k}=${v}`).join('&');
    key += `?${queryString}`;
  }

  return key;
}
```

### 为什么排序？

相同的查询参数，不同的顺序应该命中同一个缓存：

```
GET /search?category=phone&brand=apple
GET /search?brand=apple&category=phone

两者语义相同，排序后都生成:
key = "/search?brand=apple&category=phone"
```

如果不排序，两个 URL 会生成不同的 cache key，导致：
1. **缓存浪费**：同一页面存了两份
2. **更新不一致**：失效一个 key 不会影响另一个
3. **缓存命中率降低**：应该命中的请求变成了缓存 miss

### 额外的 Key 优化

ISR 缓存 key 还会忽略某些不影响页面内容的参数（如 `utm_source`、`fbclid`），避免营销追踪参数导致缓存碎片化。

**源码参考：**
- `packages/core/src/renderer/isr-renderer.ts` — 缓存 key 生成逻辑

---

## 题目 39：Filesystem Store 为什么使用"临时文件 + rename"的写入策略？⭐⭐⭐⭐

**答案：**

### 问题：并发写入的竞态条件

在 PM2 cluster 模式下，多个 Worker 进程可能同时写入同一个缓存文件：

```
Worker 1: 写入 cache-abc.json（50% 完成）
Worker 2: 写入 cache-abc.json（开始覆盖 Worker 1 的内容）
Worker 1: 完成写入（但前半部分已被 Worker 2 覆盖）
→ 文件内容损坏，JSON.parse 失败
```

### 解决方案：原子写入

```typescript
async set(key: string, entry: CacheEntry) {
  const finalPath = path.join(this.entriesDir, this.keyToFilename(key) + '.json');

  // 1. 生成唯一临时文件名
  const tempPath = path.join(this.entriesDir, `.tmp-${Date.now()}-${Math.random()}`);

  // 2. 将数据写入临时文件
  await fs.writeFile(tempPath, JSON.stringify(entry));

  // 3. 原子重命名（操作系统保证原子性）
  await fs.rename(tempPath, finalPath);
}
```

### 为什么 rename 是原子的？

在 POSIX 文件系统（Linux/macOS）中，`rename()` 系统调用是原子操作。它在文件系统层面直接更新 inode 指向，不存在"半完成"的中间状态。要么完全成功（文件指向新内容），要么完全失败（文件仍指向旧内容）。

### 临时文件命名

```typescript
`.tmp-${Date.now()}-${Math.random()}`
```

使用时间戳 + 随机数确保多个进程同时写入时，临时文件名不冲突。

### Key 到文件名的 SHA-256 哈希

```typescript
keyToFilename(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}
```

用哈希而非直接用 URL 作为文件名，因为：
1. URL 可能包含 `/`、`?`、`&` 等文件系统不允许的字符
2. URL 可能超过文件系统的最大文件名长度限制
3. 防止路径穿越攻击（`../../etc/passwd`）

**源码参考：**
- `packages/server/src/isr/filesystem-store.ts` — set(), keyToFilename()

---

## 题目 40：如何实现 ISR 缓存预热？为什么需要缓存预热？⭐⭐⭐

**答案：**

### 什么是缓存预热？

在服务器启动时，主动渲染并缓存热门页面，而不是等第一个用户请求触发。

### 为什么需要预热？

冷启动时所有 ISR 页面的缓存都是空的。如果同时有大量请求涌入：
1. 每个请求都是 cache miss，需要同步渲染
2. 所有请求都在等待渲染完成，TTFB 很长
3. 服务器 CPU 压力骤增（可能导致级联超时）

预热确保热门页面在第一个请求到达前就已经有缓存。

### 实现

```typescript
// ISRManager.warmup()
async warmup(routes: WarmupRoute[]): Promise<WarmupResult> {
  let successCount = 0;
  let failCount = 0;

  for (const route of routes) {
    try {
      const html = await route.renderFn(); // 执行渲染
      await this.cacheStore.set(route.key, {
        html,
        createdAt: Date.now(),
        tags: route.tags || [],
      });
      successCount++;
    } catch (error) {
      logger.warn('预热失败', { path: route.path, error });
      failCount++;
      // 单页面预热失败不影响其他页面
    }
  }

  logger.info(`缓存预热完成: ${successCount} 成功, ${failCount} 失败`);
  return { successCount, failCount, duration };
}
```

### 配置

```typescript
// nami.config.ts
isr: {
  warmup: [
    '/',               // 首页
    '/products/hot',   // 热门商品页
    '/categories',     // 分类页
  ],
}
```

### 预热时机

在 `onServerStart` 钩子中执行，服务器已经绑定端口但还没有接收请求（或者在 K8s readinessProbe 通过之前）。

**源码参考：**
- `packages/server/src/isr/isr-manager.ts` — warmup()
