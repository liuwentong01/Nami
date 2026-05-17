# Plugin System Internals

The Nami plugin system centralizes framework extension points across four phases: build, server-side rendering, client runtime, and common cleanup. Plugins register hooks or server middleware through `setup(api)`, and the framework dispatches them in the corresponding phase through `PluginManager`.

This chapter focuses on "how plugins are registered, how they are sorted, which hooks are actually called today, and how `context.extra` passes information within a request". If an API exists in the types but has no call site in the current main path, the documentation explicitly calls that out to avoid describing a "defined capability" as "wired behavior".

---

## 1. Source Map

| Topic | Source |
|------|------|
| Plugin types and API types | `packages/shared/src/types/plugin.ts` |
| Lifecycle definitions | `packages/shared/src/types/lifecycle.ts` |
| Plugin manager | `packages/core/src/plugin/plugin-manager.ts` |
| Hook registry | `packages/core/src/plugin/hook-registry.ts` |
| Plugin API implementation | `packages/core/src/plugin/plugin-api-impl.ts` |
| String plugin loading | `packages/core/src/plugin/plugin-loader.ts` |
| Server plugin registration and middleware mounting | `packages/server/src/app.ts` |
| Server startup and disposal | `packages/server/src/server.ts` |
| Renderer-triggered plugin hooks | `packages/core/src/renderer/base-renderer.ts` |
| Render middleware consuming `context.extra` | `packages/server/src/middleware/render-middleware.ts` |
| Build-time plugin calls | `packages/webpack/src/builder.ts` |
| Client plugin calls | `packages/client/src/entry-client.tsx` |
| Official cache plugin example | `packages/plugin-cache/src/cache-plugin.ts` |
| LRU / TTL / CDN cache strategies | `packages/plugin-cache/src/strategies/*.ts` |

---

## 2. Plugin Interface

Source location: `packages/shared/src/types/plugin.ts`

Each plugin implements `NamiPlugin`:

```typescript
export interface NamiPlugin {
  name: string;
  version?: string;
  enforce?: 'pre' | 'post';
  setup: (api: PluginAPI) => void | Promise<void>;
}
```

Field semantics:

| Field | Requirement | Description |
|------|------|------|
| `name` | Required, non-empty string | Unique plugin identifier. A second plugin with the same name is skipped. |
| `version` | Optional, string | Used for logging and troubleshooting. |
| `enforce` | Optional, only `'pre'` or `'post'` | Controls plugin and hook order. Unset means normal. |
| `setup(api)` | Required function | The plugin registers hooks, middleware, or reads config here. |

`enforce: 'normal'` is not a valid plugin configuration value. The source internally uses `'normal'` as the default sorting weight, but the plugin object's `enforce` can only be `'pre'`, `'post'`, or unset.

### Configuration Syntax

The type of `NamiConfig.plugins` is:

```typescript
plugins: Array<NamiPlugin | string>;
```

Example:

```typescript
export default defineConfig({
  plugins: [
    myLocalPlugin(),
    '@nami/plugin-monitor',
  ],
});
```

String plugins are loaded by `PluginLoader.load()` through `require(packageName)`. Both direct CommonJS exports and ES Module `default` exports are supported.

Fault tolerance differs by entry:

| Entry | String plugin load failure |
|------|--------------------|
| `NamiBuilder.prepareBuildContext()` | Throws and interrupts the build |
| `createNamiServer()` | Logs the error and skips the plugin |
| `createDevServer()` | Logs the error and skips the plugin |
| `initNamiClient()` | The client does not resolve string plugins. It warns and ignores them. |

The client runtime must receive already-resolved plugin objects. It cannot rely on browser-side `require()` for plugin package names.

---

## 3. Registration Flow

Source location: `packages/core/src/plugin/plugin-manager.ts`

Plugin registration starts from `registerPlugins()`:

```text
registerPlugins(plugins)
  -> sort by enforce
       pre -> normal -> post
  -> registerPlugin(plugin) in order
       -> validate name / setup
       -> check duplicate plugin name
       -> create PluginAPIImpl
       -> await plugin.setup(api)
       -> write into plugins Map
```

`plugins` are stored in `Map<string, PluginEntry>`. A plugin with the same name does not overwrite the previous one:

```text
if this.plugins.has(plugin.name)
  -> logger.warn
  -> return
```

### `PluginAPIImpl`

Source location: `packages/core/src/plugin/plugin-api-impl.ts`

Each plugin receives an independent `PluginAPIImpl` instance. This instance stores:

| Field | Purpose |
|------|------|
| `hookRegistry` | Global hook registry |
| `config` | Framework config |
| `logger` | Framework logger |
| `pluginName` | Current plugin name |
| `enforce` | Current plugin sort marker |
| `middlewares` | Koa middleware added by the current plugin through `addServerMiddleware` |

All public hook registration methods eventually call:

```typescript
this.hookRegistry.register(hookName, fn, this.pluginName, this.enforce);
```

So every hook handler knows its source plugin and sorting weight.

### `getConfig()` and `getLogger()`

`getConfig()` returns:

```typescript
Object.freeze({ ...this.config })
```

This is a shallow copy plus top-level freeze, not a deep freeze. Plugins should not modify config directly. To modify routes or Webpack config, use `modifyRoutes` or `modifyWebpackConfig`.

`getLogger()` returns:

```typescript
this.logger.child({ plugin: this.pluginName })
```

This lets plugin logs automatically include the plugin name.

---

## 4. Hook Definitions and Ordering

Source locations:

- `packages/shared/src/types/lifecycle.ts`
- `packages/core/src/plugin/hook-registry.ts`

`HOOK_DEFINITIONS` is the source for runtime registration validation. The current definitions are:

| Phase | Hook | Type | Called by the current main path |
|------|------|------|-------------------|
| build | `modifyWebpackConfig` | Waterfall | Yes, `NamiBuilder.applyWebpackConfigEnhancers()` |
| build | `modifyRoutes` | Waterfall | Yes, `NamiBuilder.prepareBuildContext()` |
| build | `onBuildStart` | Parallel | Yes, triggered before compilation in `NamiBuilder.build()` through `callHook('buildStart')` |
| build | `onBuildEnd` | Parallel | Yes, triggered during cleanup in `NamiBuilder.build()` through `callHook('buildEnd')` |
| server | `onServerStart` | Parallel | Yes, called after `startServer()` listens successfully |
| server | `onRequest` | Parallel | Type exists, but the current server main path does not call it |
| server | `onBeforeRender` | Parallel | Yes, triggered by the concrete Renderer |
| server | `onAfterRender` | Parallel | Yes, triggered by the concrete Renderer |
| server | `onRenderError` | Parallel | Yes, triggered by the concrete Renderer |
| client | `onClientInit` | Parallel | Yes, `initNamiClient()` |
| client | `onHydrated` | Parallel | Yes, after Hydration completes |
| client | `wrapApp` | Waterfall | Yes, wraps the root component on the client |
| client | `onRouteChange` | Parallel | Yes, on client route changes |
| common | `onError` | Parallel | Yes, triggered by plugin hook errors and the client error boundary |
| common | `onDispose` | Parallel | Yes, `PluginManager.dispose()` |

`HookType.Bail` and `runBailHook()` are implemented, but there are currently no Bail-type hooks in `HOOK_DEFINITIONS`, and the main path does not use `runBailHook()`.

### Registration Order

`HookRegistry.register()` puts each handler into the corresponding hook list, then sorts by `enforce`:

```text
pre -> normal -> post
```

Handlers at the same level preserve registration order.

The ordering source is `plugin.enforce` on the plugin object, not a per-hook ordering value.

---

## 5. Three Dispatch Semantics

Source location: `packages/core/src/plugin/plugin-manager.ts`

### Waterfall

Used when the same value needs to be modified step by step, such as the route table, Webpack config, or React root component wrapping.

```text
initialValue
  -> plugin A handler(value)
  -> plugin B handler(valueFromA)
  -> plugin C handler(valueFromB)
  -> finalValue
```

Source behavior:

| Detail | Behavior |
|------|------|
| Execution | `await` in order |
| Returns `undefined` | Keeps the previous value |
| Returns any other value | Replaces the current value |
| Handler throws | Logs the error and continues to the next handler |
| Typical hooks | `modifyRoutes`, `modifyWebpackConfig`, `wrapApp` |

### Parallel

Used for notification-style events, such as before/after rendering, client initialization, and server startup.

Source behavior:

| Detail | Behavior |
|------|------|
| Execution | `Promise.allSettled` |
| Single handler throws | Logs the error and rethrows, so allSettled records it as rejected |
| Final result | All handlers get a chance to run |
| Typical hooks | `onBeforeRender`, `onAfterRender`, `onClientInit` |

### Bail

Used for "the first valid result wins" scenarios. The source has implemented:

```typescript
if (result !== null && result !== undefined) {
  return result;
}
```

So `false`, `0`, and `''` are all valid results and will short-circuit. But there is currently no official Bail hook, so documentation should not describe it as a capability already used by an existing lifecycle.

---

## 6. Build-Phase Plugins

Source location: `packages/webpack/src/builder.ts`

The build phase initializes plugins in `NamiBuilder.prepareBuildContext()`:

```text
prepareBuildContext(isDev)
  -> resolve config.plugins
  -> new PluginManager(config)
  -> registerPlugins(resolvedPlugins)
  -> runWaterfallHook('modifyRoutes', [...config.routes])
  -> this.config.routes = modifiedRoutes
```

Then every Webpack config goes through:

```text
raw webpack config
  -> enhanceConfig()
  -> config.webpack.client/server custom modification
  -> pluginManager.runWaterfallHook('modifyWebpackConfig', config, { isServer, isDev })
  -> optionally append analyze plugin
```

Build hooks actually called by the current Builder main path:

| Hook | Call site |
|------|--------|
| `modifyRoutes` | `prepareBuildContext()` |
| `modifyWebpackConfig` | `applyWebpackConfigEnhancers()` |
| `onBuildStart` | Before client/server compilation in `build()`, calls `pluginManager.callHook('buildStart')` |
| `onBuildEnd` | During normal cleanup or the catch branch in `build()`, calls `pluginManager.callHook('buildEnd')` |

`callHook()` maps the short names `buildStart` / `buildEnd` to the official hook names `onBuildStart` / `onBuildEnd`, then executes them with Parallel semantics.

---

## 7. Server-Phase Plugins

### Plugin Initialization

Source location: `packages/server/src/app.ts`

`createNamiServer()` initializes plugins before registering Koa middleware:

```text
new PluginManager(config, logger)
  -> resolve config.plugins
  -> PluginLoader.load(string)
  -> pluginManager.registerPlugins(resolvedPlugins)
```

String plugin load failures are caught, logged, and skipped.

### Server Middleware Position

Plugins register Koa middleware through:

```typescript
api.addServerMiddleware(async (ctx, next) => {
  await next();
});
```

The actual position in the production server is:

```text
shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck
  -> staticServe
  -> config.server.middlewares
  -> pluginManager.getServerMiddlewares()
  -> dataPrefetchMiddleware
  -> errorIsolation
  -> isrCacheMiddleware
  -> renderMiddleware
```

Key conclusions:

| Fact | Impact |
|------|------|
| Plugin middleware is before `dataPrefetchMiddleware` | Plugin middleware can process or intercept `/_nami/data/*` data API requests first. This is suitable for auth, tenant identification, and request context injection. |
| Plugin middleware is after user `server.middlewares` | User middleware runs before plugin middleware. |
| Plugin middleware is upstream of `errorIsolation` | Errors thrown by plugin middleware are not captured by `errorIsolationMiddleware`. |
| Plugin middleware order follows plugin registration order | `pre` plugin middleware runs first, `post` plugin middleware runs later. |

If plugin middleware needs to convert business errors into HTTP responses, it must use its own try/catch and set `ctx.status` / `ctx.body`.

### `onServerStart`

Source location: `packages/server/src/server.ts`

`onServerStart` is called after `app.listen()` succeeds:

```typescript
await pluginManager.runParallelHook('onServerStart', { port, host });
```

It is not triggered when `createNamiServer()` finishes creation. It is triggered after the HTTP server has started listening.

### Render Hooks

Source locations:

- `packages/core/src/renderer/base-renderer.ts`
- `packages/core/src/renderer/ssr-renderer.ts`
- `packages/server/src/middleware/render-middleware.ts`

Render hooks are triggered by the concrete Renderer:

```text
renderer.render(context)
  -> callPluginHook('beforeRender')
  -> run data prefetch/rendering for that mode
  -> callPluginHook('afterRender')
```

When rendering fails:

```text
catch error
  -> callPluginHook('renderError')
  -> throw RenderError
  -> renderMiddleware enters degradation logic
```

`renderMiddleware` explicitly does not additionally trigger `onBeforeRender` / `onAfterRender` / `onRenderError`, avoiding duplicate execution of the same lifecycle.

In SSR, the actual timing of `onBeforeRender` is earlier than `getServerSideProps`, because `SSRRenderer.render()` calls `callPluginHook('beforeRender')` first and then enters `executeSSR()`, while data prefetch happens inside `executeSSR()`.

### `onRequest`

`api.onRequest()` can register handlers, and `HOOK_DEFINITIONS` also defines it, but the current server main path does not call `runParallelHook('onRequest', ctx)`. Therefore, do not treat it as a hook that fires on every request in the current version.

---

## 8. Client-Phase Plugins

Source location: `packages/client/src/entry-client.tsx`

Client initialization flow:

```text
initNamiClient(options)
  -> new PluginManager(config)
  -> filter out string plugins and warn
  -> registerPlugins(pluginInstances)
  -> runParallelHook('onClientInit')
  -> readServerData()
  -> create <NamiApp />
  -> runWaterfallHook('wrapApp', appElement)
  -> hydrateApp() or renderApp()
  -> runParallelHook('onHydrated') after Hydration completes
```

Client route changes:

```typescript
pluginManager.runParallelHook('onRouteChange', {
  from,
  to,
  params: {},
});
```

The `params` passed to `onRouteChange` are currently fixed to an empty object `{}`. If a plugin needs route params, confirm whether they are passed by a later router implementation.

The client error boundary triggers:

```typescript
pluginManager.runParallelHook('onError', error, {
  source: 'client-error-boundary',
});
```

---

## 9. `context.extra`

Source locations:

- `packages/shared/src/types/context.ts`
- `packages/server/src/middleware/render-middleware.ts`
- `packages/plugin-cache/src/cache-plugin.ts`

The type of `RenderContext.extra` is:

```typescript
extra: Record<string, unknown>;
```

`renderMiddleware.createRenderContext()` initializes it on every request:

```typescript
extra: {}
```

So it is request-scoped and is not shared across requests. But it is not a permission sandbox, and it does not prevent plugins from reading and writing the same key. Convention fields used by plugins should prefer namespaces or double-underscore prefixes to avoid conflicts.

### Convention Fields Consumed by `renderMiddleware`

`applyPluginExtras()` currently consumes these fields:

| Field | Type | Behavior |
|------|------|------|
| `__cache_hit` | `boolean` | If `true` and cached content exists, replaces `result.html` |
| `__cache_content` | `string` | HTML from a plugin cache hit |
| `__custom_headers` | `Record<string, string>` | Merged into `result.headers` |
| `__retry_attempted` | `boolean` | Writes `X-Nami-Retry: 1` |

The render exception branch also reads:

| Field | Behavior |
|------|------|
| `__skeleton_fallback` | If it is a string, directly returns skeleton HTML with status code 200 and skips `DegradationManager` |

Finally, all `extra` is attached to:

```typescript
ctx.state.namiExtra = extra;
```

### Official Cache Plugin Example

`NamiCachePlugin` reads the cache in `onBeforeRender`. On hit, it writes:

```typescript
context.extra['__cache_hit'] = true;
context.extra['__cache_key'] = cacheKey;
context.extra['__cache_content'] = cached.content;
context.extra['__cache_etag'] = cached.etag;
context.extra['__cache_created_at'] = cached.createdAt;
```

After `renderMiddleware` sees `__cache_hit` and `__cache_content`, it replaces the final HTML with the plugin-cached content and writes:

```http
X-Nami-Plugin-Cache: HIT
```

`NamiCachePlugin` writes cache in `onAfterRender`. If the result is a cache hit, it skips duplicate writes.

---

## 10. Error Isolation and `onError`

Plugin hook execution errors do not directly interrupt the core flow. `PluginManager.handleHookError()` does:

1. Logs the error.
2. If the currently failed hook is not `onError`, asynchronously triggers registered `onError` handlers.
3. Does not wait for `onError` handlers to complete, avoiding blocking the main flow.
4. If `onError` itself fails, only logs the error and does not trigger recursively.

Error handling differs slightly across dispatch modes:

| Mode | Single handler throws |
|------|-------------------|
| Waterfall | Logs the error, continues to the next handler, and keeps the current value from the previous round |
| Parallel | Logs the error, marks the current handler as rejected, and lets other handlers continue |
| Bail | Logs the error and continues to the next handler |

---

## 11. Disposal Flow

Source locations:

- `packages/core/src/plugin/plugin-manager.ts`
- `packages/server/src/server.ts`

When a normal production server enables `config.server.gracefulShutdown`, it calls this during graceful shutdown cleanup:

```typescript
await pluginManager.dispose();
```

`dispose()` flow:

```text
dispose()
  -> if already disposed, warn and return
  -> read onDispose handlers
  -> execute all onDispose handlers with Promise.allSettled
  -> hookRegistry.clear()
  -> plugins.clear()
  -> disposed = true
```

`dispose()` directly reads and executes `onDispose` handlers, bypassing the normal hook's `ensureNotDisposed` check. After disposal, registering plugins or executing normal hooks throws.

If graceful shutdown is not enabled, whether `dispose()` is called depends on whether the startup entry handles cleanup separately.

---

## 12. Plugin Authoring Examples

### Render Timing Marker Plugin

```typescript
import type { NamiPlugin, RenderContext, RenderResult } from '@nami/shared';

export function timingPlugin(): NamiPlugin {
  return {
    name: 'demo:timing',
    enforce: 'pre',
    setup(api) {
      const logger = api.getLogger();

      api.onBeforeRender((context: RenderContext) => {
        context.extra['demo:timing:start'] = Date.now();
      });

      api.onAfterRender((context: RenderContext, result: RenderResult) => {
        const start = context.extra['demo:timing:start'];
        if (typeof start !== 'number') return;

        logger.info('Page render completed', {
          url: context.url,
          duration: Date.now() - start,
          renderMode: result.meta.renderMode,
        });
      });
    },
  };
}
```

### Custom Response Header Plugin

```typescript
import type { NamiPlugin } from '@nami/shared';

export function customHeaderPlugin(): NamiPlugin {
  return {
    name: 'demo:headers',
    setup(api) {
      api.onBeforeRender((context) => {
        context.extra.__custom_headers = {
          'X-Demo-Plugin': 'enabled',
        };
      });
    },
  };
}
```

This does not directly manipulate Koa `ctx`. Instead, it writes to `context.extra.__custom_headers`. After rendering completes, `renderMiddleware.applyPluginExtras()` merges these fields into `RenderResult.headers`.

### Koa Middleware Plugin

```typescript
import type { NamiPlugin } from '@nami/shared';

export function apiMockPlugin(): NamiPlugin {
  return {
    name: 'demo:api-mock',
    setup(api) {
      api.addServerMiddleware(async (ctx, next) => {
        if (ctx.path === '/api/mock') {
          ctx.status = 200;
          ctx.body = { ok: true };
          return;
        }

        await next();
      });
    },
  };
}
```

This middleware is upstream of `errorIsolation`. If the plugin throws internally, it will not be captured by the framework render error page.

---

## 13. Official Cache Plugin Appendix

Source locations:

- `packages/plugin-cache/src/cache-plugin.ts`
- `packages/plugin-cache/src/strategies/lru-cache.ts`
- `packages/plugin-cache/src/strategies/ttl-cache.ts`
- `packages/plugin-cache/src/strategies/cdn-cache.ts`

### Difference Between LRU and TTL

| Strategy | Source class | Core mechanism | Main config | Suitable scenarios |
|------|--------|----------|----------|----------|
| LRU | `NamiLRUCache` | Fixed capacity. Evicts least recently used entries after reaching the limit. | `maxSize`, `ttl`, `enableStats` | Hot page cache, preventing unbounded memory growth |
| TTL | `NamiTTLCache` | Each entry expires by expiration time, with periodic timer cleanup. | `defaultTTL`, `cleanupInterval`, `maxEntries`, `enableStats` | Data with a clear time window, precise expiration required |

LRU uses `lru-cache` underneath. `ttl` is in seconds and is internally converted to milliseconds. The TTL strategy uses `Map`, supports periodic cleanup and lazy cleanup on read, and `dispose()` stops the cleanup timer.

### `NamiCachePlugin` Write Flow

```text
onBeforeRender
  -> keyGenerator(context)
  -> store.get(cacheKey)
  -> hit: write context.extra.__cache_*
  -> miss: write __cache_hit=false and __cache_key

onAfterRender
  -> do not cache non-2xx
  -> do not write again on cache hit
  -> ttl = result.cacheControl?.revalidate ?? defaultTTL
  -> store.set(cacheKey, entry, ttl)
  -> write Cache-Control
```

Default cache key:

```typescript
`nami:page:${context.url}`
```

### `cdnConfig` Fields

`CDNCacheConfig` supports:

| Field | Type | Generated directive | Description |
|------|------|----------|------|
| `scope` | `'public' | 'private'` | `public` / `private` | Defaults to `public`. `private` does not generate `s-maxage`. |
| `maxAge` | `number` | `max-age=N` | Browser cache time, in seconds |
| `sMaxAge` | `number` | `s-maxage=N` | CDN/shared cache time, in seconds, only valid for public |
| `staleWhileRevalidate` | `number` | `stale-while-revalidate=N` | Window in which stale content may be returned while revalidating in the background |
| `staleIfError` | `number` | `stale-if-error=N` | Window in which stale cache may be used when the origin errors |
| `noStore` | `boolean` | `no-store` | Highest priority. Returns `no-store` directly when set. |
| `noCache` | `boolean` | `no-cache` | Cacheable, but must revalidate before each use. |
| `mustRevalidate` | `boolean` | `must-revalidate` | Must revalidate with the origin after expiration. |
| `immutable` | `boolean` | `immutable` | Suitable for immutable assets with content hashes. |

If there is no `cdnConfig` but `RenderResult.cacheControl` exists, the cache plugin uses `generateISRHeader(revalidate, staleWhileRevalidate)` to generate ISR-style response headers:

```text
public, max-age=0, s-maxage=<revalidate>, stale-while-revalidate=<window>, stale-if-error=<window>
```

---

## 14. Common Misconceptions

### Misconception 1: `onRequest` currently fires for every request

No. It exists in the types and registry, but the current server main path has no call site for it.

### Misconception 2: You need to directly call `runParallelHook('buildStart')`

No. `NamiBuilder.build()` uses the compatibility entries `callHook('buildStart')` and `callHook('buildEnd')`, and `PluginManager.callHook()` maps them to the official `onBuildStart` / `onBuildEnd`.

### Misconception 3: Bail hooks are already used by some lifecycle

No. `HookType.Bail` and `runBailHook()` are reserved capabilities, and there is currently no official Bail hook.

### Misconception 4: Plugin middleware is protected by `errorIsolation`

No. Plugin middleware is upstream of `errorIsolation`, so it must handle its own errors.

### Misconception 5: `getConfig()` is a deep freeze

No. It only freezes the top-level shallow copy.

### Misconception 6: The client automatically loads string plugins

No. The client only registers resolved plugin instances. String plugins are warned and ignored.

### Misconception 7: `context.extra` is a cross-request shared cache

No. It is a new object created for each request and is suitable for in-request plugin communication. Cross-request caching should use a plugin's own store or the framework ISR cache.

---

## Next Steps

- Server middleware position: read [Server and Middleware](./server-and-middleware.en.md)
- Renderer plugin hook timing: read [Rendering Modes Internals](./rendering-modes.en.md)
- Build-time `modifyWebpackConfig` context: read [Build System](./webpack-build.en.md)
