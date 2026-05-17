# ISR and caching principles



ISR (Incremental Static Regeneration, Incremental Static Regeneration) allows the page to return cached HTML directly like SSG on most requests, while re-rendering updated content like SSR after the cache becomes stale.



In Nami's standard server link, ISR's HTML cache is responsible for `isrCacheMiddleware + ISRManager + CacheStore`; `ISRRenderer` is mainly responsible for "generating HTML when re-rendering is really needed". This is important: when the cache hits, the request will be short-circuited at the middleware layer and will not enter the renderer.



---



## 1. Source code map



| Theme | Source Code |
|------|------|
| ISR configuration type | `packages/shared/src/types/config.ts` |
| Default ISR configuration and constants | `packages/shared/src/constants/defaults.ts` |
| Cache entries and cache interface | `packages/shared/src/types/cache.ts` |
| ISR Manager | `packages/server/src/isr/isr-manager.ts` |
| SWR status judgment | `packages/server/src/isr/stale-while-revalidate.ts` |
| Background revalidation queue | `packages/server/src/isr/revalidation-queue.ts` |
| Cache backend factory | `packages/server/src/isr/cache-store.ts` |
| Memory cache | `packages/server/src/isr/memory-store.ts` |
| File system cache | `packages/server/src/isr/filesystem-store.ts` |
| Redis cache | `packages/server/src/isr/redis-store.ts` |
| ISR caching middleware | `packages/server/src/middleware/isr-cache-middleware.ts` |
| Render response headers and tag writeback | `packages/server/src/middleware/render-middleware.ts` |
| ISR Renderer | `packages/core/src/renderer/isr-renderer.ts` |
| Server-side assembly | `packages/server/src/app.ts` |
| Plug-in caching system | `packages/plugin-cache/src/cache-plugin.ts` |



---



## 2. ISR configuration



Source code location:



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



Default value:



```typescript
export const DEFAULT_ISR_CONFIG = {
  enabled: false,
  cacheDir: '.nami-cache/isr',
  defaultRevalidate: 60,
  cacheAdapter: 'memory',
};
```



Example:



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



Configuration verification is done in `packages/core/src/config/config-validator.ts`. Current main checks:



| Project | Rules |
|------|------|
| When `isr.enabled === true` | Verify `isr.defaultRevalidate` |
| `defaultRevalidate` | Must be between `1` and `604800` seconds |
| `cacheAdapter: 'redis'` | Redis configuration needs to meet required fields |



`route.revalidate` is configured by the route consumer and currently does not see the exact same range verification logic as `defaultRevalidate`.



---



## 3. Server assembly location



Source code location: `packages/server/src/app.ts`



When the service starts:



```text
if (config.isr.enabled)
  -> createCacheStore({ cacheAdapter, cacheDir, redis })
  -> new ISRManager(config.isr, cacheStore)
  -> app.use(isrCacheMiddleware({ config, isrManager }))
```



`createNamiServer()` also exposes `isrManager` in the return value:



```typescript
export interface NamiServerInstance {
  app: Koa;
  pluginManager: PluginManager;
  isrManager?: ISRManager;
  degradationManager: DegradationManager;
  triggerShutdown: () => void;
}
```



In the middleware sequence, the ISR cache layer is located after `errorIsolation` and before `renderMiddleware`:



```text
shutdownAware
timing
security
requestContext
healthCheck
staticServe
User middlewares
Plug-in middlewares
dataPrefetch
errorIsolation
isrCacheMiddleware is only registered when isr.enabled
renderMiddleware
```



Therefore:



1. When the ISR cache is hit, it will be short-circuited and will not enter the rendering middleware.
2. When the cache misses, `isrCacheMiddleware` calls `await next()` in `renderFn`, allowing the request to continue into `renderMiddleware` to produce HTML.
3. When the ISR cache layer is abnormal, it will be downgraded to direct `await next()` and set to `X-Nami-Cache: BYPASS`.



---



## 4. ISR caching middleware



Source code location: `packages/server/src/middleware/isr-cache-middleware.ts`



The middleware only handles GET requests:



```text
Not GET
  -> next()

GET + x-nami-isr-revalidate: 1 + trusted local source + optional token verification passed
  -> next(), bypass cache

GET + matching ISR route + isr.enabled
  -> ISRManager.getOrRevalidate()

Other GET
  -> next()
```



ISR routing decision:



```typescript
route.renderMode === RenderMode.ISR && config.isr.enabled
```



Default cache key:



```typescript
function defaultGenerateCacheKey(ctx: Koa.Context): string {
  return ctx.path;
}
```



Query, Cookie, and Header are not included by default. If the page content depends on these factors, `generateCacheKey(ctx)` needs to be customized at the middleware layer. Otherwise different queries may share the same ISR HTML.



Calling structure of `getOrRevalidate()`:



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



Hit response header:



| Status | Response Headers |
|------|--------|
| Fresh | `X-Nami-Cache: HIT` |
| Stale | `X-Nami-Cache: STALE` |
| Miss | `X-Nami-Cache: MISS` |
| Cache fault bypass | `X-Nami-Cache: BYPASS` |



Also set on hit:



```http
X-Nami-Render-Mode: isr
X-Nami-Cache-Age: <seconds>
Cache-Control: public, s-maxage=<revalidate>, stale-while-revalidate=<revalidate * 2>
ETag: <etag>    # If the cache entry contains an etag
```



---



## 5. SWR state machine



Source code location: `packages/server/src/isr/stale-while-revalidate.ts`



SWR divides the cache into three states:



```text
creation time
  │
  ├── Fresh: age <= revalidateAfter
  │ Return directly to cache
  │
  ├── Stale: revalidateAfter < age <= revalidateAfter * staleMultiplier
  │ Return to the old cache and re-verify in the background
  │
  └── Expired: age > revalidateAfter * staleMultiplier
        Do not return the old cache, re-render synchronously
```



Default `staleMultiplier = 2`:



```text
revalidate = 60s

0s ---------------- 60s ---------------- 120s ---------------->
      Fresh                 Stale                  Expired
```



`evaluateCacheFreshness()` returns:



```typescript
{
  state: SWRState.Fresh | SWRState.Stale | SWRState.Expired,
  age,
  ttl,
  needsRevalidation,
}
```



NOTE: Storage layer TTL is written using `effectiveRevalidate * 2`. This ensures that the cache within the Stale window still exists, and the old HTML can be returned first and then updated in the background.



---



## 6. `ISRManager.getOrRevalidate()`



Source code location: `packages/server/src/isr/isr-manager.ts`



Core signature:



```typescript
async getOrRevalidate(
  key: string,
  renderFn: () => Promise<ISRRenderPayload | string>,
  revalidateSeconds: number,
  backgroundRevalidateFn?: () => Promise<ISRRenderPayload | string>,
): Promise<ISRCacheResult>
```



Valid revalidation intervals:



```typescript
const effectiveRevalidate = revalidateSeconds || this.config.defaultRevalidate;
```



Therefore `revalidate: 0` does not mean never reauthenticate, but falls back to `defaultRevalidate`.



Process:



```text
Read cacheStore.get(key)
  │
  ├── Hit Fresh
  │ -> return cached.content
  │ -> isStale: false
  │ -> isCacheMiss: false
  │
  ├── Hit Stale
  │ -> revalidationQueue.enqueue(...)
  │ -> Return cached.content immediately
  │ -> isStale: true
  │ -> isCacheMiss: false
  │
  └── Missed or Expired
        -> Reuse in-flight rendering with the same key, or create a new renderAndCache()
        -> await renderFn()
        -> generateETag(html)
        -> cacheStore.set(key, entry, effectiveRevalidate * 2)
        -> Return new HTML
        -> isCacheMiss: true
```



Missed and Expired synchronous rendering paths will merge requests based on the cache key: when the same key is already being rendered, subsequent requests will wait for and reuse the same Promise, and multiple SSR/data requests will not be triggered concurrently. This merger only affects the current Node process; multi-process or multi-machine deployment still requires a shared cache backend and upstream throttling policy.



`CacheEntry` for synchronous cold rendering writes:



```typescript
{
  content: html,
  createdAt: Date.now(),
  revalidateAfter: effectiveRevalidate,
  tags: tags ?? [],
  etag,
}
```



The write cache is asynchronous fire-and-forget and does not block response returns. If the write fails, just log.



---



## 7. Background re-validation queue



Source code location: `packages/server/src/isr/revalidation-queue.ts`



The Stale state does not block user requests, but instead queues background tasks.



Default configuration:



| Project | Default |
|------|--------|
| `maxConcurrency` | `2` |
| `timeout` | `30000` ms |



Queue capabilities:



| Capability | Implementation |
|------|------|
| Deduplication | `pendingKeys` + `activeKeys`, only one task is allowed for the same key |
| Concurrency control | `activeCount < maxConcurrency` takes task execution |
| Timeout protection | `Promise.race([renderFn(), timeout])` |
| Failure isolation | Failures are only logged and do not affect the old cache |
| Close | `close()` Stop accepting new tasks, clear pending, and clear timer |



Cache entry written after success:



```typescript
{
  content: normalized.html,
  createdAt: Date.now(),
  revalidateAfter: job.revalidateSeconds,
  tags: normalized.tags,
}
```



Note: The background revalidation success path currently does not write the `etag` field; synchronous cold rendering paths will generate `etag`.



---



## 8. Internal re-authentication request



Source code location: `packages/server/src/middleware/isr-cache-middleware.ts`



Background revalidation defaults to rerendering via an internal HTTP request. The internal request target is fixed to the local listening address, and `Host` for inbound requests is not used; if the environment variable `NAMI_ISR_REVALIDATE_TOKEN` is configured, the request will also carry a matching token header:



```typescript
fetch(`http://${serverHost}:${serverPort}${ctx.path}${querystring}`, {
  method: 'GET',
  headers: {
    [NAMI_ISR_REVALIDATE_HEADER]: '1',
    'x-nami-isr-revalidate-token': process.env.NAMI_ISR_REVALIDATE_TOKEN,
    'X-Requested-With': 'nami-isr-revalidate',
  },
});
```



Request header constants:



```typescript
NAMI_ISR_REVALIDATE_HEADER = 'x-nami-isr-revalidate'
```



When `isrCacheMiddleware` detects that the header value is `'1'`, it will also verify that the request source is a trusted local address; when `NAMI_ISR_REVALIDATE_TOKEN` is configured, the token will also be verified. Directly call `next()` after passing the verification, without reading the cache, to avoid background re-verification hitting the old cache again and repeatedly enqueuing.



The response header is read after the internal request is completed:



```http
X-Nami-Cache-Tags: tag1,tag2
```



The source code uses lowercase to read `x-nami-cache-tags`, and the HTTP header is not case-sensitive. This response header is set by `render-middleware.ts` when `result.cacheControl.tags` is present.



---



## 9. Responsibilities of ISRRenderer



Source code location: `packages/core/src/renderer/isr-renderer.ts`



In standard server links, ISR cache hits are handled by upstream middleware. When reaching `ISRRenderer.render()`, it usually indicates that the current request requires real rendering, such as a cache miss, complete expiration, or internal revalidation request.



`ISRRenderer` does these things:



1. Call the `beforeRender` plug-in hook.
2. Execute `prefetchData()` and read `getStaticProps`.
3. Write the result to `context.initialData`.
4. Execute React/HTML rendering.
5. Assemble the complete HTML and inject data through `generateDataScript()`.
6. Return `RenderResult` with ISR cache semantics.



The only contexts for `prefetchData()` are:



```typescript
{
  params: context.params,
}
```



Currently, query, headers, and cookies are not passed.



`RenderResult.cacheControl`：



```typescript
{
  revalidate,
  staleWhileRevalidate: revalidate * 2,
  tags: extractCacheTags(context),
}
```



`extractCacheTags()` will merge:



1. `context.route.meta.cacheTags`
2. `context.extra.cacheTags`



`render-middleware.ts` will write these tags to `ctx.state.namiCacheTags` for `isrCacheMiddleware` to write cache entries after cold rendering.



---



## 10. Cache key differences



This is where ISR is most likely to get into trouble.



| location | default cache key |
|------|------------|
| `isrCacheMiddleware` | `ctx.path` |
| `ISRRenderer.buildCacheKey()` | `context.path` + sorted query |



The standard server link actually reads and writes `CacheStore` to `isrCacheMiddleware`, so by default the ISR HTML cache key only contains pathname and does not contain query.



`ISRRenderer.buildCacheKey()` will sort the query and spell it into the key, but in the standard link it is mainly used for logging and rendering semantics; the judgment of hit, Stale, and Expired is completed by the upstream middleware.



If the page content depends on query, for example:



```text
/products?sort=price
/products?sort=new
```



The same ISR HTML is shared by default. Custom `generateCacheKey(ctx)` should be provided for `isrCacheMiddleware` at the server-side integration layer, and the query or other factors that affect the content should be included in the key.



---



## 11. Three cache backends



Factory source code: `packages/server/src/isr/cache-store.ts`



```typescript
createCacheStore({
  cacheAdapter,
  cacheDir,
  redis,
  cacheOptions,
})
```



`createNamiServer()` currently only passes `cacheAdapter`, `cacheDir`, `redis`, and does not expose `cacheOptions` to `ISRConfig` of `nami.config.ts`. So the default `memory` maximum number of entries is `1000`.



### MemoryStore



Source code location: `packages/server/src/isr/memory-store.ts`



| Projects | Actions |
|------|------|
| Storage structure | `Map<string, MemoryCacheItem>` |
| TTL | `expireAt`, `0` means never expires |
| LRU | `get()` deletes and then inserts after hit, and moves to the end of Map |
| Elimination | Delete about 10% from the Map header after exceeding `maxEntries` |
| Tags | `tagIndex: Map<tag, Set<key>>` |
| Statistics | In-process hits/misses |



Suitable for development environments and single-process deployment. Multi-process/multi-machine does not share cache.



### FilesystemStore



Source code location: `packages/server/src/isr/filesystem-store.ts`



| Projects | Actions |
|------|------|
| Directory | `cacheDir/entries`, `cacheDir/tags` |
| file name | `SHA256(key).json` |
| Entry format | `{ entry, expireAt, writtenAt }` |
| Write | First write the temporary file, then `rename` atomic replacement |
| Expiration | When `get()` is found to be expired, the entry file will be deleted asynchronously |
| Tag | Each tag has a SHA256 file and stores the key list |
| Statistics | Currently implemented as in-process counting |



`stats.json` appears in the file header comment, but the logic of persistently writing `stats.json` is not seen in the implementation. Do not rely on this file during operation and maintenance.



Suitable for multi-process sharing on the same machine, but not suitable for multi-machine deployment.



### RedisStore



Source code location: `packages/server/src/isr/redis-store.ts`



Redis key design:



```text
{prefix}entry:{key} -> JSON serialization CacheEntry
{prefix}tag:{tag} -> SET, save the cache key associated with the tag
{prefix}stats:hits
{prefix}stats:misses
```



| Projects | Actions |
|------|------|
| Default prefix | `nami:isr:` |
| TTL writing | Use `SETEX` when ttl is available |
| Tag Index | `SADD` / `SMEMBERS` |
| Invalid by tag | Get SET and delete entries in batches, then delete tag key |
| Clear | `SCAN` + `DEL ${prefix}*`, not `FLUSHDB` |
| Connections | Using `ioredis`, `lazyConnect: true` |



Redis is suitable for multi-machine deployment. It should be noted that the re-verification queue is still local to each Node process. Multiple processes may initiate background re-verification for the same key at the same time. The Redis layer will not deduplicate queue tasks globally.



---



## 12. Tags and On-Demand Invalidation



Cache entry type:



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



Label source:



1. Routing configuration: `route.meta.cacheTags`
2. Write the plug-in or rendering link: `context.extra.cacheTags`
3. `render-middleware.ts` converted to `ctx.state.namiCacheTags`
4. `isrCacheMiddleware` reads `ctx.state.namiCacheTags` when writing cache in cold rendering



Failed by path:



```typescript
await isrManager.invalidate('/products/iphone-15');
```



Invalid by tag:



```typescript
await isrManager.invalidateByTag('product:123');
```



`packages/shared/src/constants/defaults.ts` is defined in:



```typescript
ISR_REVALIDATE_PATH = '/_nami/revalidate'
```



However, the built-in HTTP handler corresponding to this constant is not seen in the current warehouse hot path. That said, it shouldn't be written as "the out-of-the-box Webhook API". If you need CMS Webhook, you can register the Koa middleware yourself in the service integration layer holding `isrManager`.



Example:



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



Specific body parsing requires business projects to access Koa body parser themselves.



---



## 13. Cache warm-up



Source code location: `packages/server/src/isr/isr-manager.ts`



`ISRManager.warmup()` can pre-render a set of paths:



```typescript
await isrManager.warmup(
  ['/', '/products', '/products/popular-item'],
  async (path) => renderPage(path),
);
```



Behavior:



1. Traverse the path sequentially.
2. Call `renderFn(path)`.
3. Generate ETag.
4. Write cache with `defaultRevalidate * 2` as TTL.
5. If a certain path fails, only the log will be recorded and subsequent paths will not be affected.



---



## 14. HTTP cache headers



Use when ISR middleware hits:



```typescript
public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}
```



`RenderResult.headers` returned by `ISRRenderer` also contains similar values:



```http
Cache-Control: public, s-maxage=60, stale-while-revalidate=120
```



But `render-middleware.ts` is reset when `result.cacheControl` is processed:



```http
Cache-Control: s-maxage=60, stale-while-revalidate=120
```



In other words, the `Cache-Control` ultimately seen by the cold rendering link may be logically covered by `cacheControl` of `render-middleware`, and may not necessarily have `public` in form. When troubleshooting the Network panel, the final response header should prevail.



---



## 15. ISR and `@nami/plugin-cache`



Source code location: `packages/plugin-cache/src/cache-plugin.ts`



Nami also has a plugin caching system that provides LRU/TTL policy and CDN Header assistance. It and ISR are two different pipelines:



| Project | ISR Cache | `@nami/plugin-cache` |
|------|----------|----------------------|
| Entry | `isrCacheMiddleware` | Plug-in hook |
| Manager | `ISRManager` | `NamiCachePlugin` |
| Cache object | ISR HTML | Plug-in defined rendering result/response cache |
| Failure mode | path/tag | Plug-in policy |
| CDN Header | ISR Middleware/Renderer | `CDNCacheManager` |



Do not treat the default value of `CDNCacheManager` as the ISR's runtime cache header. ISR default `stale-while-revalidate` is `revalidate * 2`.



---



## 16. Troubleshooting Guide



### The page has not been updated.



Possible reasons:



1. The cache is still in Fresh state.
2. Stale background re-validation fails and the old cache is retained.
3. The page depends on query, but the default cache key is only `ctx.path`.
4. The `memory` backend is used, and the cache is not shared between multiple processes/multiple machines.



Suggestions:



1. Observe `X-Nami-Cache` and `X-Nami-Cache-Age`.
2. Check the log for "ISR background reauthentication failed".
3. Customize `generateCacheKey` for query-sensitive pages.
4. Use Redis for multi-machine deployment.



### First access is very slow



This is a cold miss: `isrCacheMiddleware` needs to execute `renderMiddleware` to produce HTML before writing to the cache. Popular pages can be warmed up via `isrManager.warmup()`.



### Stale requests still return old content



This is design behavior. The Stale state immediately returns the old HTML and updates the cache in the background. You won't see the new HTML until the next request.



### ETag sometimes does not exist



Synchronous cold rendering paths generate ETags; paths that the background revalidation queue successfully writes to the cache do not currently have ETags written to them.



---



## 17. Common misunderstandings



### Misunderstanding 1: `ISRRenderer` is responsible for all ISR cache hit determinations



This is not the case with standard server links. Cache hit, Stale judgment, and background re-validation are mainly completed by `isrCacheMiddleware + ISRManager`. `ISRRenderer` is responsible for producing HTML when real rendering is required.



### Misunderstanding 2: The default cache key contains query



Not included. The default key is `ctx.path`. `ISRRenderer.buildCacheKey()` contains query, but the standard link to read and write the Store key comes from the middleware.



### Misunderstanding 3: `revalidate: 0` means never expires



No. `getOrRevalidate()` uses `revalidateSeconds || defaultRevalidate`, `0` falls back to the global default.



### Misunderstanding 4: MemoryStore’s `maxEntries` can be directly set in the configuration.



The factory for `createCacheStore()` supports `cacheOptions`, but the current `ISRConfig` and `createNamiServer()` assemblies do not expose it. The default memory is `1000`.



### Misunderstanding 5: `/_nami/revalidate` is an implemented built-in API



Currently, we only see the constant `ISR_REVALIDATE_PATH`, but not the corresponding HTTP handler. When you need to invalidate on demand, you should register the interface yourself in the business service integration layer and call `isrManager.invalidate()` or `invalidateByTag()`.



### Misunderstanding 6: The Redis backend will globally deduplicate the background re-validation queue.



No. Redis shares cache entries, but `RevalidationQueue` is a per-Node process local object.



---



## Next step



- To understand how ISR routes are matched: read [Principles of Routing Systems](./routing.en.md)
- To learn how to downgrade when rendering fails: read [Error Handling and Downgrade](./error-and-degradation.en.md)
- Want to know the order of server-side middleware: read [Server and Middleware](./server-and-middleware.en.md)
