# 插件系统原理

Nami 插件系统把框架扩展点集中在构建、服务端渲染、客户端运行时和通用清理四个阶段。插件通过 `setup(api)` 注册钩子或服务端中间件，框架在对应阶段由 `PluginManager` 统一调度。

这一章重点解释“插件如何注册、如何排序、哪些钩子当前真的会被调用、`context.extra` 如何在请求内传递信息”。如果某个 API 在类型中存在但当前主链路没有调用点，文档会明确标出，避免把“已定义能力”误写成“已接入行为”。

---

## 1. 源码地图

| 主题 | 源码 |
|------|------|
| 插件类型与 API 类型 | `packages/shared/src/types/plugin.ts` |
| 生命周期定义 | `packages/shared/src/types/lifecycle.ts` |
| 插件管理器 | `packages/core/src/plugin/plugin-manager.ts` |
| 钩子注册表 | `packages/core/src/plugin/hook-registry.ts` |
| 插件 API 实现 | `packages/core/src/plugin/plugin-api-impl.ts` |
| 字符串插件加载 | `packages/core/src/plugin/plugin-loader.ts` |
| 服务端插件注册与中间件挂载 | `packages/server/src/app.ts` |
| 服务启动和销毁 | `packages/server/src/server.ts` |
| 渲染器触发插件钩子 | `packages/core/src/renderer/base-renderer.ts` |
| 渲染中间件消费 `context.extra` | `packages/server/src/middleware/render-middleware.ts` |
| 构建期插件调用 | `packages/webpack/src/builder.ts` |
| 客户端插件调用 | `packages/client/src/entry-client.tsx` |
| 官方缓存插件示例 | `packages/plugin-cache/src/cache-plugin.ts` |
| LRU / TTL / CDN 缓存策略 | `packages/plugin-cache/src/strategies/*.ts` |

---

## 2. 插件接口

源码位置：`packages/shared/src/types/plugin.ts`

每个插件实现 `NamiPlugin`：

```typescript
export interface NamiPlugin {
  name: string;
  version?: string;
  enforce?: 'pre' | 'post';
  setup: (api: PluginAPI) => void | Promise<void>;
}
```

字段语义：

| 字段 | 要求 | 说明 |
|------|------|------|
| `name` | 必填，非空字符串 | 插件唯一标识；同名插件第二次注册会被跳过 |
| `version` | 可选，字符串 | 用于日志和排查 |
| `enforce` | 可选，只能是 `'pre'` 或 `'post'` | 控制插件和钩子顺序；不设置表示 normal |
| `setup(api)` | 必填函数 | 插件在这里注册钩子、中间件或读取配置 |

`enforce: 'normal'` 不是合法插件配置值。源码内部会用 `'normal'` 表示默认排序权重，但插件对象的 `enforce` 只能是 `'pre'`、`'post'` 或不设置。

### 配置写法

`NamiConfig.plugins` 的类型是：

```typescript
plugins: Array<NamiPlugin | string>;
```

示例：

```typescript
export default defineConfig({
  plugins: [
    myLocalPlugin(),
    '@nami/plugin-monitor',
  ],
});
```

字符串插件由 `PluginLoader.load()` 通过 `require(packageName)` 加载，支持 CommonJS 直接导出和 ES Module `default` 导出。

不同入口的容错行为：

| 入口 | 字符串插件加载失败 |
|------|--------------------|
| `NamiBuilder.prepareBuildContext()` | 抛错，中断构建 |
| `createNamiServer()` | 记录错误并跳过该插件 |
| `createDevServer()` | 记录错误并跳过该插件 |
| `initNamiClient()` | 客户端不解析字符串插件，会 warn 并忽略 |

客户端运行时必须拿到已经解析好的插件对象，不能依赖浏览器端 `require()` 插件包名。

---

## 3. 注册流程

源码位置：`packages/core/src/plugin/plugin-manager.ts`

插件注册从 `registerPlugins()` 开始：

```text
registerPlugins(plugins)
  -> 按 enforce 排序
       pre -> normal -> post
  -> 依次 registerPlugin(plugin)
       -> 校验 name / setup
       -> 检查同名插件
       -> 创建 PluginAPIImpl
       -> await plugin.setup(api)
       -> 写入 plugins Map
```

`plugins` 使用 `Map<string, PluginEntry>` 存储，同名插件不会覆盖旧插件：

```text
如果 this.plugins.has(plugin.name)
  -> logger.warn
  -> return
```

### `PluginAPIImpl`

源码位置：`packages/core/src/plugin/plugin-api-impl.ts`

每个插件都会拿到一个独立的 `PluginAPIImpl` 实例。这个实例保存：

| 字段 | 作用 |
|------|------|
| `hookRegistry` | 全局钩子注册表 |
| `config` | 框架配置 |
| `logger` | 框架 logger |
| `pluginName` | 当前插件名 |
| `enforce` | 当前插件排序标记 |
| `middlewares` | 当前插件通过 `addServerMiddleware` 添加的 Koa 中间件 |

所有公开钩子注册方法最终都会调用：

```typescript
this.hookRegistry.register(hookName, fn, this.pluginName, this.enforce);
```

所以每个 hook handler 都知道来源插件和排序权重。

### `getConfig()` 和 `getLogger()`

`getConfig()` 返回：

```typescript
Object.freeze({ ...this.config })
```

这是浅拷贝 + 顶层冻结，不是深冻结。插件不应直接修改配置；如果要修改路由或 Webpack 配置，应使用 `modifyRoutes` 或 `modifyWebpackConfig`。

`getLogger()` 返回：

```typescript
this.logger.child({ plugin: this.pluginName })
```

用于让插件日志自动带上插件名。

---

## 4. 钩子定义与排序

源码位置：

- `packages/shared/src/types/lifecycle.ts`
- `packages/core/src/plugin/hook-registry.ts`

`HOOK_DEFINITIONS` 是运行时注册校验的来源。当前定义如下：

| 阶段 | Hook | 类型 | 当前主链路是否调用 |
|------|------|------|-------------------|
| build | `modifyWebpackConfig` | Waterfall | 是，`NamiBuilder.applyWebpackConfigEnhancers()` |
| build | `modifyRoutes` | Waterfall | 是，`NamiBuilder.prepareBuildContext()` |
| build | `onBuildStart` | Parallel | 是，`NamiBuilder.build()` 编译前通过 `callHook('buildStart')` 触发 |
| build | `onBuildEnd` | Parallel | 是，`NamiBuilder.build()` 收尾时通过 `callHook('buildEnd')` 触发 |
| server | `onServerStart` | Parallel | 是，`startServer()` listen 成功后调用 |
| server | `onRequest` | Parallel | 类型存在，当前服务端主链路未调用 |
| server | `onBeforeRender` | Parallel | 是，由具体 Renderer 触发 |
| server | `onAfterRender` | Parallel | 是，由具体 Renderer 触发 |
| server | `onRenderError` | Parallel | 是，由具体 Renderer 触发 |
| client | `onClientInit` | Parallel | 是，`initNamiClient()` |
| client | `onHydrated` | Parallel | 是，Hydration 完成后 |
| client | `wrapApp` | Waterfall | 是，客户端包裹根组件 |
| client | `onRouteChange` | Parallel | 是，客户端路由变化时 |
| common | `onError` | Parallel | 是，插件 hook 错误和客户端错误边界会触发 |
| common | `onDispose` | Parallel | 是，`PluginManager.dispose()` |

`HookType.Bail` 和 `runBailHook()` 已实现，但当前 `HOOK_DEFINITIONS` 没有任何 Bail 类型钩子，主链路也没有使用 `runBailHook()`。

### 注册排序

`HookRegistry.register()` 会把每个 handler 放入对应 hook 列表，然后按 `enforce` 排序：

```text
pre -> normal -> post
```

同级保持注册顺序。

排序来源是插件对象的 `plugin.enforce`，不是单个 hook 单独传入的顺序。

---

## 5. 三种调度语义

源码位置：`packages/core/src/plugin/plugin-manager.ts`

### Waterfall

用于需要逐步修改同一个值的场景，比如路由表、Webpack 配置、React 根组件包裹。

```text
initialValue
  -> plugin A handler(value)
  -> plugin B handler(valueFromA)
  -> plugin C handler(valueFromB)
  -> finalValue
```

源码行为：

| 细节 | 行为 |
|------|------|
| 执行方式 | 按顺序 `await` |
| 返回 `undefined` | 保留上一轮值 |
| 返回其他值 | 替换当前值 |
| handler 抛错 | 记录错误，继续下一个 handler |
| 典型 hook | `modifyRoutes`、`modifyWebpackConfig`、`wrapApp` |

### Parallel

用于通知型事件，比如渲染前后、客户端初始化、服务启动。

源码行为：

| 细节 | 行为 |
|------|------|
| 执行方式 | `Promise.allSettled` |
| 单个 handler 抛错 | 记录错误并 rethrow，让 allSettled 统计 rejected |
| 最终结果 | 所有 handler 都有机会执行 |
| 典型 hook | `onBeforeRender`、`onAfterRender`、`onClientInit` |

### Bail

用于“第一个有效结果胜出”的场景。源码已实现：

```typescript
if (result !== null && result !== undefined) {
  return result;
}
```

因此 `false`、`0`、`''` 都算有效结果，会触发短路。但当前没有正式 Bail hook，不应在文档中把它描述成某个现有生命周期已经使用的能力。

---

## 6. 构建阶段插件

源码位置：`packages/webpack/src/builder.ts`

构建阶段由 `NamiBuilder.prepareBuildContext()` 初始化插件：

```text
prepareBuildContext(isDev)
  -> 解析 config.plugins
  -> new PluginManager(config)
  -> registerPlugins(resolvedPlugins)
  -> runWaterfallHook('modifyRoutes', [...config.routes])
  -> this.config.routes = modifiedRoutes
```

之后每份 Webpack 配置都会经过：

```text
raw webpack config
  -> enhanceConfig()
  -> config.webpack.client/server 自定义修改
  -> pluginManager.runWaterfallHook('modifyWebpackConfig', config, { isServer, isDev })
  -> analyze 插件可选追加
```

当前 Builder 主链路实际调用的构建 hook：

| Hook | 调用点 |
|------|--------|
| `modifyRoutes` | `prepareBuildContext()` |
| `modifyWebpackConfig` | `applyWebpackConfigEnhancers()` |
| `onBuildStart` | `build()` 中 client/server 编译前，调用 `pluginManager.callHook('buildStart')` |
| `onBuildEnd` | `build()` 正常收尾或 catch 分支，调用 `pluginManager.callHook('buildEnd')` |

`callHook()` 会把短名 `buildStart` / `buildEnd` 映射到正式 hook 名 `onBuildStart` / `onBuildEnd`，并按 Parallel 语义执行。

---

## 7. 服务端阶段插件

### 插件初始化

源码位置：`packages/server/src/app.ts`

`createNamiServer()` 会在注册 Koa 中间件前初始化插件：

```text
new PluginManager(config, logger)
  -> 解析 config.plugins
  -> PluginLoader.load(string)
  -> pluginManager.registerPlugins(resolvedPlugins)
```

字符串插件加载失败会被 catch，记录错误并跳过。

### 服务端中间件位置

插件通过：

```typescript
api.addServerMiddleware(async (ctx, next) => {
  await next();
});
```

注册 Koa 中间件。生产服务器中的真实位置是：

```text
shutdownAware
  -> timing
  -> security
  -> requestContext
  -> healthCheck
  -> staticServe
  -> dataPrefetchMiddleware
  -> config.server.middlewares
  -> pluginManager.getServerMiddlewares()
  -> errorIsolation
  -> isrCacheMiddleware
  -> renderMiddleware
```

关键结论：

| 事实 | 影响 |
|------|------|
| 插件中间件在 `dataPrefetchMiddleware` 后 | 插件中间件默认拦不到已被数据 API 短路的请求 |
| 插件中间件在用户 `server.middlewares` 后 | 用户中间件先于插件中间件 |
| 插件中间件在 `errorIsolation` 上游 | 插件中间件抛错不会被 `errorIsolationMiddleware` 捕获 |
| 插件中间件顺序跟插件注册顺序一致 | `pre` 插件的中间件先执行，`post` 后执行 |

如果插件中间件要把业务错误转换成 HTTP 响应，需要自己 try/catch 并设置 `ctx.status` / `ctx.body`。

### `onServerStart`

源码位置：`packages/server/src/server.ts`

`onServerStart` 在 `app.listen()` 成功之后调用：

```typescript
await pluginManager.runParallelHook('onServerStart', { port, host });
```

这不是 `createNamiServer()` 创建完成时触发，而是 HTTP server 已经开始监听后触发。

### 渲染钩子

源码位置：

- `packages/core/src/renderer/base-renderer.ts`
- `packages/core/src/renderer/ssr-renderer.ts`
- `packages/server/src/middleware/render-middleware.ts`

渲染钩子由具体 Renderer 触发：

```text
renderer.render(context)
  -> callPluginHook('beforeRender')
  -> 执行该模式的数据预取/渲染
  -> callPluginHook('afterRender')
```

渲染出错时：

```text
catch error
  -> callPluginHook('renderError')
  -> throw RenderError
  -> renderMiddleware 进入降级逻辑
```

`renderMiddleware` 明确不再额外触发 `onBeforeRender` / `onAfterRender` / `onRenderError`，避免同一生命周期重复执行。

SSR 中 `onBeforeRender` 的实际时机早于 `getServerSideProps`，因为 `SSRRenderer.render()` 先 `callPluginHook('beforeRender')`，再进入 `executeSSR()`，而数据预取在 `executeSSR()` 内部。

### `onRequest`

`api.onRequest()` 可以注册，`HOOK_DEFINITIONS` 也有定义，但当前服务端主链路没有调用 `runParallelHook('onRequest', ctx)`。因此不要把它当成当前版本每个请求都会触发的 hook。

---

## 8. 客户端阶段插件

源码位置：`packages/client/src/entry-client.tsx`

客户端初始化流程：

```text
initNamiClient(options)
  -> new PluginManager(config)
  -> 过滤掉字符串插件并 warn
  -> registerPlugins(pluginInstances)
  -> runParallelHook('onClientInit')
  -> readServerData()
  -> 创建 <NamiApp />
  -> runWaterfallHook('wrapApp', appElement)
  -> hydrateApp() 或 renderApp()
  -> Hydration 完成后 runParallelHook('onHydrated')
```

客户端路由变化：

```typescript
pluginManager.runParallelHook('onRouteChange', {
  from,
  to,
  params: {},
});
```

当前传给 `onRouteChange` 的 `params` 固定为空对象 `{}`。如果插件需要路由参数，需要结合后续路由实现确认是否已传入。

客户端错误边界会触发：

```typescript
pluginManager.runParallelHook('onError', error, {
  source: 'client-error-boundary',
});
```

---

## 9. `context.extra`

源码位置：

- `packages/shared/src/types/context.ts`
- `packages/server/src/middleware/render-middleware.ts`
- `packages/plugin-cache/src/cache-plugin.ts`

`RenderContext.extra` 的类型是：

```typescript
extra: Record<string, unknown>;
```

`renderMiddleware.createRenderContext()` 每次请求都会初始化：

```typescript
extra: {}
```

因此它是请求级隔离的，不会跨请求共享。但它不是权限沙箱，也不会阻止插件互相读写同一个 key。插件约定字段应尽量使用命名空间或双下划线前缀，避免冲突。

### `renderMiddleware` 消费的约定字段

`applyPluginExtras()` 当前消费这些字段：

| 字段 | 类型 | 行为 |
|------|------|------|
| `__cache_hit` | `boolean` | 为 `true` 且有缓存内容时，替换 `result.html` |
| `__cache_content` | `string` | 插件缓存命中的 HTML |
| `__custom_headers` | `Record<string, string>` | 合并进 `result.headers` |
| `__retry_attempted` | `boolean` | 写入 `X-Nami-Retry: 1` |

渲染异常分支还会读取：

| 字段 | 行为 |
|------|------|
| `__skeleton_fallback` | 如果是字符串，直接返回骨架 HTML，状态码 200，跳过 `DegradationManager` |

最后，所有 `extra` 会被挂到：

```typescript
ctx.state.namiExtra = extra;
```

### 官方缓存插件示例

`NamiCachePlugin` 在 `onBeforeRender` 中读取缓存，命中时写入：

```typescript
context.extra['__cache_hit'] = true;
context.extra['__cache_key'] = cacheKey;
context.extra['__cache_content'] = cached.content;
context.extra['__cache_etag'] = cached.etag;
context.extra['__cache_created_at'] = cached.createdAt;
```

`renderMiddleware` 看到 `__cache_hit` 和 `__cache_content` 后，会把最终 HTML 替换成插件缓存内容，并写：

```http
X-Nami-Plugin-Cache: HIT
```

`NamiCachePlugin` 在 `onAfterRender` 中写缓存。如果是缓存命中结果，跳过重复写入。

---

## 10. 错误隔离与 `onError`

插件 hook 执行错误不会直接打断核心流程。`PluginManager.handleHookError()` 会：

1. 记录错误日志。
2. 如果当前失败的不是 `onError`，异步触发已注册的 `onError` 处理器。
3. 不等待 `onError` 处理器完成，避免阻塞主流程。
4. `onError` 自身失败时只记录日志，不递归触发。

不同调度模式下错误处理略有差异：

| 模式 | 单个 handler 抛错 |
|------|-------------------|
| Waterfall | 记录错误，继续下一个，当前值保持上一轮 |
| Parallel | 记录错误，当前 handler 标为 rejected，其他 handler 继续 |
| Bail | 记录错误，继续下一个 |

---

## 11. 销毁流程

源码位置：

- `packages/core/src/plugin/plugin-manager.ts`
- `packages/server/src/server.ts`

正常生产服务器在开启 `config.server.gracefulShutdown` 时，会在优雅停机清理阶段调用：

```typescript
await pluginManager.dispose();
```

`dispose()` 流程：

```text
dispose()
  -> 如果已 disposed，warn 后返回
  -> 读取 onDispose handlers
  -> Promise.allSettled 执行所有 onDispose
  -> hookRegistry.clear()
  -> plugins.clear()
  -> disposed = true
```

`dispose()` 直接读取 `onDispose` handlers 执行，绕过普通 hook 的 `ensureNotDisposed` 检查。销毁后，再注册插件或执行普通 hook 会抛错。

如果没有开启优雅停机，是否调用 `dispose()` 取决于启动入口是否另行处理清理逻辑。

---

## 12. 编写插件示例

### 渲染耗时标记插件

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

        logger.info('页面渲染完成', {
          url: context.url,
          duration: Date.now() - start,
          renderMode: result.meta.renderMode,
        });
      });
    },
  };
}
```

### 自定义响应头插件

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

这里没有直接操作 Koa `ctx`，而是写入 `context.extra.__custom_headers`。渲染完成后，`renderMiddleware.applyPluginExtras()` 会把这些字段合并到 `RenderResult.headers`。

### Koa 中间件插件

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

这个中间件位于 `errorIsolation` 上游。插件内部如果抛错，不会被框架渲染错误页捕获。

---

## 13. 官方缓存插件附录

源码位置：

- `packages/plugin-cache/src/cache-plugin.ts`
- `packages/plugin-cache/src/strategies/lru-cache.ts`
- `packages/plugin-cache/src/strategies/ttl-cache.ts`
- `packages/plugin-cache/src/strategies/cdn-cache.ts`

### LRU 和 TTL 的区别

| 策略 | 源码类 | 核心机制 | 主要配置 | 适用场景 |
|------|--------|----------|----------|----------|
| LRU | `NamiLRUCache` | 固定容量，达到上限后淘汰最近最少使用的条目 | `maxSize`、`ttl`、`enableStats` | 热点页面缓存、需要防止内存无限增长 |
| TTL | `NamiTTLCache` | 每个条目按过期时间失效，定时器周期清理 | `defaultTTL`、`cleanupInterval`、`maxEntries`、`enableStats` | 有明确时间窗口的数据、需要精确过期 |

LRU 底层使用 `lru-cache`，`ttl` 单位是秒，内部转换为毫秒。TTL 策略底层是 `Map`，支持定时清理和读取时惰性清理，`dispose()` 会停止清理定时器。

### `NamiCachePlugin` 写入流程

```text
onBeforeRender
  -> keyGenerator(context)
  -> store.get(cacheKey)
  -> 命中：写 context.extra.__cache_*
  -> 未命中：写 __cache_hit=false 和 __cache_key

onAfterRender
  -> 非 2xx 不缓存
  -> 缓存命中不重复写
  -> ttl = result.cacheControl?.revalidate ?? defaultTTL
  -> store.set(cacheKey, entry, ttl)
  -> 写 Cache-Control
```

默认缓存键：

```typescript
`nami:page:${context.url}`
```

### `cdnConfig` 字段

`CDNCacheConfig` 支持：

| 字段 | 类型 | 生成指令 | 说明 |
|------|------|----------|------|
| `scope` | `'public' | 'private'` | `public` / `private` | 默认 `public`；`private` 不会生成 `s-maxage` |
| `maxAge` | `number` | `max-age=N` | 浏览器缓存时间，秒 |
| `sMaxAge` | `number` | `s-maxage=N` | CDN/共享缓存时间，秒，仅 public 有效 |
| `staleWhileRevalidate` | `number` | `stale-while-revalidate=N` | 过期后可返回旧内容并后台重验证的窗口 |
| `staleIfError` | `number` | `stale-if-error=N` | 源站出错时允许使用旧缓存的窗口 |
| `noStore` | `boolean` | `no-store` | 优先级最高，设置后直接返回 `no-store` |
| `noCache` | `boolean` | `no-cache` | 可缓存，但每次使用前必须重验证 |
| `mustRevalidate` | `boolean` | `must-revalidate` | 过期后必须向源站重验证 |
| `immutable` | `boolean` | `immutable` | 适合带内容 hash 的不可变资源 |

如果没有 `cdnConfig`，但 `RenderResult.cacheControl` 存在，缓存插件会用 `generateISRHeader(revalidate, staleWhileRevalidate)` 生成 ISR 风格响应头：

```text
public, max-age=0, s-maxage=<revalidate>, stale-while-revalidate=<window>, stale-if-error=<window>
```

---

## 14. 常见误区

### 误区一：`onRequest` 当前每个请求都会触发

不会。它在类型和注册表中存在，但当前服务端主链路没有调用点。

### 误区二：需要直接调用 `runParallelHook('buildStart')`

不需要。`NamiBuilder.build()` 使用兼容入口 `callHook('buildStart')` 和 `callHook('buildEnd')`，`PluginManager.callHook()` 会映射到正式的 `onBuildStart` / `onBuildEnd`。

### 误区三：Bail hook 已经用于某个生命周期

没有。`HookType.Bail` 和 `runBailHook()` 是预留能力，当前没有正式 Bail hook。

### 误区四：插件中间件被 `errorIsolation` 保护

不是。插件中间件位于 `errorIsolation` 上游，自身错误要自己处理。

### 误区五：`getConfig()` 是深冻结

不是。它只冻结顶层浅拷贝。

### 误区六：客户端会自动加载字符串插件

不会。客户端只注册已解析插件实例，字符串插件会被 warn 并忽略。

### 误区七：`context.extra` 是跨请求共享缓存

不是。它是每次请求新建的对象，适合请求内插件通信；跨请求缓存应使用插件自己的 store 或框架 ISR 缓存。

---

## 下一步

- 服务端中间件位置：阅读 [服务器与中间件](./server-and-middleware.md)
- 渲染器触发插件的时机：阅读 [渲染模式原理](./rendering-modes.md)
- 构建期 `modifyWebpackConfig` 的上下文：阅读 [构建系统](./webpack-build.md)
