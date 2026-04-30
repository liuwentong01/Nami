# 架构设计（8 题）

---

## 题目 11：Nami 为什么采用 Monorepo 结构？各包之间的依赖关系是怎样的？⭐⭐⭐

**答案：**

**Monorepo 的优势：**
1. **统一版本管理**：所有包的版本在同一仓库中协调，避免依赖版本不一致
2. **原子提交**：一个 PR 可以同时修改多个包，保证变更的原子性
3. **代码复用**：共享构建配置、类型定义、工具函数
4. **开发体验**：pnpm workspace 的软链接让包之间的引用实时生效

**包依赖关系图：**

```
                    @nami/shared  ← 所有包都依赖（零依赖基础层）
                    ┌─────┴─────┐
               @nami/core    @nami/client
                 ↑    ↑          ↑
    ┌────────────┤    │          │
    │            │    │          │
@nami/server  @nami/webpack  @nami/cli
    ↑                            ↑
    └────────────────────────────┘
                  │
            @nami/cli (编排层)
```

**各包职责：**
| 包 | 职责 | 依赖 |
|----|------|------|
| `@nami/shared` | 类型定义、常量、工具函数 | 零依赖 |
| `@nami/core` | 渲染器、插件管理、路由匹配、降级 | shared |
| `@nami/server` | Koa 服务器、中间件管线、ISR、集群 | shared, core |
| `@nami/client` | Hydration、客户端路由、数据注水 | shared |
| `@nami/webpack` | Webpack 配置工厂、Loader、Plugin | shared, core |
| `@nami/cli` | 命令行工具（dev/build/start） | shared, core, server, webpack |

**关键设计约束：**
- `shared` 不依赖任何包 → 纯类型和工具，所有包的"共同语言"
- `core` 不依赖 `server` → 通过接口解耦，避免循环依赖
- `client` 不依赖 `server` → 纯浏览器端代码，不能引入 Node.js API

**源码参考：**
- 根目录 `pnpm-workspace.yaml` — workspace 配置
- 各包 `package.json` — 依赖声明

---

## 题目 12：为什么 @nami/core 不能直接依赖 @nami/server？如何解决这个问题？⭐⭐⭐⭐

**答案：**

**先澄清一个容易误解的点：**

不是 `@nami/core` 想依赖 `@nami/server`，而是 `core` 中的渲染器在执行 `SSR / SSG / ISR` 时，确实需要一些运行时能力，例如：

- 加载页面模块
- 获取 `getServerSideProps / getStaticProps / getStaticPaths`
- 在 ISR 场景下查询缓存、触发重验证

但是 `core` 只需要这些能力的"最小协议"，不应该依赖它们的具体实现类，更不应该反向依赖整个 `@nami/server` 包。

**问题 1：如果直接依赖具体实现，会形成循环依赖**

`@nami/server` 依赖 `@nami/core`（使用渲染器、插件管理器等核心能力）。如果 `@nami/core` 再去 import `@nami/server` 里的具体实现，就会形成循环依赖：

```
@nami/core → @nami/server → @nami/core → ...（无限循环）
```

**问题 2：包分层会变乱**

如果把这些能力全部理解成 `server` 专属实现，那么：

- `core` 的渲染器就必须知道 `server` 里的具体类
- 以后测试、构建工具、CLI 如果也要复用这些能力，也会被迫依赖 `server`
- `core` 作为"渲染引擎层"会失去独立性

例如当前仓库里，`ModuleLoader` 的具体实现实际上放在 `core`，因为它不仅服务于运行时渲染，也被构建链路复用。说明关键不是"类一定放在哪个包"，而是**渲染器依赖的是抽象能力，而不是具体位置**。

**解决方案：依赖倒置 + 依赖注入**

在 `@nami/core` 中定义最小化接口，因为 `core` 才是这些能力的**使用方**。接口应该由使用方定义自己需要的最小契约，再由上层或其他模块提供实现：

```typescript
// packages/core/src/renderer/types.ts — core 定义接口

interface ISRManagerLike {
  getOrRevalidate(
    key: string,
    renderFn: () => Promise<string>,
    revalidateSeconds: number,
  ): Promise<ISRCacheResult>;
}

interface ModuleLoaderLike {
  getExportedFunction<T>(path: string, name: string): Promise<T | null>;
  loadModule(path: string): Promise<Record<string, unknown>>;
}

interface PluginManagerLike {
  callHook(hookName: string, ...args: unknown[]): Promise<void>;
}
```

为什么接口要定义在 `core`，而不是定义在 `server`？

- 因为 `core` 是消费者，应该由消费者声明"我最低需要什么能力"
- 如果接口定义在 `server`，那 `core` 为了引用接口类型，仍然要依赖 `@nami/server`，循环依赖问题并没有消失
- 接口放在 `core`，可以保证契约最小化，不把 `server` 的实现细节泄漏到渲染器层

```typescript
// packages/server/src/isr/isr-manager.ts — server 实现接口
class ISRManager implements ISRManagerLike {
  async getOrRevalidate(...) { /* 完整实现 */ }
}
```

```typescript
// 运行时依赖注入
const renderer = RendererFactory.create({
  mode: 'isr',
  isrManager: new ISRManager(config),      // server 的实现注入 core
  moduleLoader: new ModuleLoader(config),   // 提供“模块加载”能力
  pluginManager: new PluginManager(),       // 提供“插件钩子”能力
});
```

**为什么不干脆都在 `server` 中实现？**

可以实现，但代价是 `core` 不再是稳定的核心渲染层，很多通用能力也会被错误地下沉到 `server`。更合理的边界是：

- `core` 负责渲染流程编排：什么时候预取数据、什么时候执行渲染、什么时候触发插件
- `server` 负责提供运行时基础设施：HTTP 中间件、ISR 缓存、服务启动等

因此，`core` 需要的是"能力抽象"，不是 `server` 这个包本身。

**这样设计的好处：**
1. `core` 只依赖抽象接口，不依赖具体实现，包依赖方向更稳定
2. 接口由使用方定义，契约天然更小、更聚焦
3. 上层可以注入真实实现、Mock 实现、测试替身，便于测试
4. 底层实现可以替换，例如 ISR 缓存从内存切到 Redis，`core` 不需要修改
5. 一些能力可以被多个场景复用，不会被错误地绑死在 `server` 包里

**当前仓库里的实际情况：**

- `ISRManager` 的具体实现主要在 `@nami/server`
- `ModuleLoader` 的具体实现当前在 `@nami/core`，因为构建链路和运行时都会复用它

所以这道题真正想表达的不是"所有实现都必须在 server"，而是：**渲染器应依赖抽象能力，而不是依赖某个具体包的实现细节**。

**源码参考：**
- `packages/core/src/renderer/types.ts` — ISRManagerLike, ModuleLoaderLike, PluginManagerLike
- `packages/server/src/isr/isr-manager.ts` — ISRManager 实现
- `packages/core/src/module/module-loader.ts` — ModuleLoader 当前实现

---

## 题目 13：BaseRenderer 使用了哪些设计模式？各模式的作用是什么？⭐⭐⭐⭐

**答案：**

BaseRenderer 综合运用了 4 种设计模式：

### 1. 模板方法模式（Template Method Pattern）

基类定义算法骨架，子类实现具体步骤：

```typescript
abstract class BaseRenderer {
  // 抽象方法 — 子类必须实现
  abstract render(context: RenderContext): Promise<RenderResult>;
  abstract prefetchData(context: RenderContext): Promise<any>;
  abstract getMode(): RenderMode;

  // 通用方法 — 所有子类共享
  protected resolveAssets(): AssetPaths { /* 共享资源解析 */ }
  protected callPluginHook(): Promise<void> { /* 共享插件调用 */ }
  protected withTimeout<T>(promise, ms): Promise<T> { /* 共享超时包装 */ }
  protected createDefaultResult(): RenderResult { /* 共享结果构造 */ }
}
```

### 2. 工厂模式（Factory Pattern）

RendererFactory 根据 RenderMode 创建具体渲染器，上层代码不需要知道具体类型：

```typescript
const renderer = RendererFactory.create({ mode: 'ssr', ... });
renderer.render(context); // 多态调用
```

### 3. 责任链模式（Chain of Responsibility）— 降级链

每个渲染器通过 `createFallbackRenderer()` 定义下一级降级目标：

```
StreamingSSRRenderer.createFallbackRenderer() → SSRRenderer
SSRRenderer.createFallbackRenderer()          → CSRRenderer
SSGRenderer.createFallbackRenderer()          → CSRRenderer
ISRRenderer.createFallbackRenderer()          → CSRRenderer
CSRRenderer.createFallbackRenderer()          → null（终点）
```

`assetManifest` 沿链传递，确保降级后的 JS/CSS 引用正确。

### 4. 策略模式（Strategy Pattern）

不同渲染模式是不同的"策略"，通过基类接口统一调用。上层的 renderMiddleware 不关心具体是哪种渲染器：

```typescript
// render-middleware.ts 中的多态调用
const renderer = RendererFactory.create({ mode: route.renderMode, ... });
const result = await renderer.render(context);
// 不需要 if/else 判断具体渲染模式
```

**源码参考：**
- `packages/core/src/renderer/base-renderer.ts`
- `packages/core/src/renderer/index.ts` — RendererFactory

---

## 题目 14：Nami 的错误分类和可恢复性判断是如何设计的？⭐⭐⭐⭐

**答案：**

Nami 的错误处理系统实现了三阶段处理流程：

### 阶段 1：错误标准化

将任意类型的错误统一转换为 `NamiError`：

```typescript
// 已经是 NamiError → 直接返回
// 标准 Error → 包装为 NamiError（保留 message 和 stack）
// 其他类型 → 转为字符串后包装
```

### 阶段 2：严重级别分类

根据错误码分配严重级别：

| 错误码范围 | 严重级别 | 示例 |
|-----------|---------|------|
| 9000+ | Fatal | 配置错误、服务器启动失败 |
| 3000-3999 | Warning | 缓存读写失败 |
| TIMEOUT 类 | Warning | SSR 超时、数据预取超时 |
| 其他 | Error | 渲染失败、数据预取失败 |

### 阶段 3：可恢复性判断

```typescript
// 可恢复的错误 → 执行降级链
RENDER_SSR_FAILED      // 可以降级到 CSR
RENDER_SSR_TIMEOUT     // 可以降级到 CSR
DATA_FETCH_FAILED      // 可以用空数据渲染
DATA_FETCH_TIMEOUT     // 可以用空数据渲染
CACHE_READ_FAILED      // 可以跳过缓存
PLUGIN_HOOK_FAILED     // 跳过该插件继续

// 不可恢复的错误 → 直接返回错误响应
CONFIG_ERROR           // 配置错误，无法运行
SERVER_START_FAILED    // 服务器启动失败
所有 Fatal 级别错误
```

**为什么用错误码范围而不是逐个判断？**

可扩展性：新增的错误码只要在正确的范围内，就自动继承该范围的严重级别和可恢复性判断，不需要修改判断逻辑。

**源码参考：**
- `packages/core/src/error/error-handler.ts` — ErrorHandler
- `packages/shared/src/types/error.ts` — ErrorCode 枚举

---

## 题目 15：为什么选择 Koa 而不是 Express 作为服务端框架？⭐⭐⭐

**答案：**

**核心原因：Koa 的洋葱模型天然适合 Nami 的中间件管线设计。**

**关键区别：`await next()` 的语义**

```typescript
// Koa — await next() 返回 Promise，等待所有下游中间件执行完毕
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();                            // 等待下游（ISR + 渲染）完成
  const duration = Date.now() - start;
  ctx.set('X-Response-Time', `${duration}ms`);  // 精确测量整个请求耗时
});

// Express — next() 不返回 Promise，无法知道下游何时完成
app.use((req, res, next) => {
  const start = Date.now();
  next();                                  // 下游在"未来某刻"完成
  // 这里无法测量耗时，因为 next() 是同步的
});
```

**Nami 中依赖此特性的关键中间件：**

1. **timing 中间件**：`await next()` 后测量 `X-Response-Time`，覆盖所有下游耗时
2. **security 中间件**：`await next()` 后读取 `ctx.state.namiCacheControl` 写入 `Cache-Control` 头
3. **ISR 缓存中间件**：`await next()` 触发渲染中间件，渲染完成后读取 `ctx.body` 写入缓存
4. **errorIsolation 中间件**：`try { await next() } catch` 捕获渲染错误

**其他优势：**
- Koa 的 `ctx` 对象比 Express 的 `req/res` 更简洁
- 原生 async/await 支持（Express 5 才支持）
- 更小的核心（无内置中间件，按需添加）

**源码参考：**
- `packages/server/src/app.ts` — createNamiServer()
- `packages/server/src/middleware/timing.ts` — timing 中间件

---

## 题目 16：Nami 如何实现同构（Isomorphic）？解释三个关键的同构边界管理机制。⭐⭐⭐⭐

**答案：**

同构是指同一套代码在服务端和客户端都能运行。Nami 通过三个关键机制管理同构边界：

### 1. 数据注水（Data Hydration）

服务端获取的数据需要传递给客户端用于 Hydration：

```
服务端 getServerSideProps() 获取数据
    → JSON.stringify() 序列化
    → 注入到 <script>window.__NAMI_DATA__={...}</script>
    → 发送给浏览器

客户端加载后
    → readServerData() 从 window 读取
    → hydrateRoot() 用相同数据复现组件树
```

安全措施：`generateDataScript()` 对 `</script>` 等危险字符做转义，防止 XSS。

### 2. 服务端代码剥离（data-fetch-loader）

`getServerSideProps` 中可能包含数据库查询、API 密钥等服务端逻辑，不能泄露到客户端 Bundle：

```typescript
// 服务端构建 — 保留原始实现
export async function getServerSideProps(ctx) {
  const data = await db.query('SELECT * FROM products'); // 数据库查询
  return { props: { data } };
}

// 客户端构建 — data-fetch-loader 替换为空实现
export async function getServerSideProps() {
  return { props: {} }; // 安全：不包含任何服务端逻辑
}
```

### 3. 客户端 Bundle 瘦身（core-client-shim）

`@nami/core` 包含渲染器、配置加载等大量服务端代码，客户端不需要这些。通过生成 `@nami/core-client-shim` 只导出客户端需要的模块：

```typescript
// .nami/generated-core-client-shim.ts
export { PluginManager } from '@nami/core';
export { NamiDataProvider } from '@nami/core';
export { matchPath } from '@nami/core';
// 不导出：SSRRenderer, ISRManager, ConfigLoader 等
```

Webpack 别名 `@nami/core-client-shim` 映射到此文件，客户端 `import from '@nami/core'` 实际只引入精简版。

**源码参考：**
- `packages/webpack/src/loaders/data-fetch-loader.ts`
- `packages/webpack/src/configs/client.config.ts` — 生成 core-client-shim
- `packages/core/src/renderer/ssr-renderer.ts` — generateDataScript()

---

## 题目 17：withTimeout 是如何实现的？为什么在多个地方都使用了它？⭐⭐⭐

**答案：**

`withTimeout` 是 BaseRenderer 中定义的通用超时包装器，用 `Promise.race` 实现：

```typescript
protected async withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RenderError(errorMessage, ErrorCode.RENDER_SSR_TIMEOUT));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (error) {
    clearTimeout(timer!);
    throw error;
  }
}
```

**关键细节：**
1. `Promise.race` — 第一个 resolve/reject 的 Promise 决定结果
2. `clearTimeout` 在 try/catch 中都执行 — 防止定时器泄漏
3. 返回泛型 `T` — 类型安全地包装任意异步操作

**使用场景：**
- **SSR 数据预取**：`withTimeout(getServerSideProps(), ssrTimeout)` — 防止慢 API 阻塞响应
- **SSR React 渲染**：`withTimeout(renderToString(), ssrTimeout)` — 防止死循环组件
- **Streaming SSR Shell 超时**：确保 `onShellReady` 在合理时间内触发
- **ISR 重验证队列**：`Promise.race([renderFn(), setTimeout(timeout)])` — 防止后台任务堆积

**为什么在多个地方使用？**

任何依赖外部资源的异步操作都可能无限等待。SSR 服务器中，一个永不 resolve 的 Promise 会导致该请求永远占用一个连接，最终耗尽服务器连接池。超时机制确保每个请求都有确定的最大执行时间。

**源码参考：**
- `packages/core/src/renderer/base-renderer.ts` — withTimeout()
- `packages/core/src/renderer/ssr-renderer.ts` — 数据预取和渲染超时

---

## 题目 18：Nami 的 RenderResult 和 RenderContext 分别携带了什么信息？设计意图是什么？⭐⭐⭐

**答案：**

### RenderContext（渲染上下文 — 输入）

描述"要渲染什么"和"在什么环境下渲染"：

```typescript
interface RenderContext {
  url: string;              // 完整 URL
  path: string;             // 路径部分
  query: Record<string, string>; // 查询参数
  params: Record<string, string>; // 路由参数（:id 等）
  headers: Record<string, string>; // 请求头
  cookies: Record<string, string>; // Cookie
  route: NamiRoute;         // 匹配到的路由配置
  renderMode: RenderMode;   // 渲染模式
  requestId: string;        // 请求追踪 ID
  extra: Record<string, unknown>; // 插件间通信通道
  timing: RenderTiming;     // 性能计时
}
```

`extra` 的设计意图是插件间数据传递的"黑板"：
- `__cache_hit`: cache 插件写入 → render-middleware 读取
- `__skeleton_fallback`: skeleton 插件写入 → render-middleware 降级时读取
- `__custom_headers`: 任意插件写入 → render-middleware 设置到 HTTP 响应头

### RenderResult（渲染结果 — 输出）

描述"渲染出了什么"和"渲染的元数据"：

```typescript
interface RenderResult {
  html: string;             // 最终 HTML
  statusCode: number;       // HTTP 状态码
  meta: {
    renderMode: RenderMode; // 实际使用的渲染模式
    duration: number;       // 渲染耗时（毫秒）
    degraded: boolean;      // 是否发生了降级
    degradeReason?: string; // 降级原因
    degradeLevel?: number;  // 降级级别
  };
  cacheControl?: string;    // Cache-Control 头建议值
  headers?: Record<string, string>; // 自定义响应头
}
```

**设计意图：**
- `meta.degraded` 让监控系统知道该次渲染走了降级路径
- `cacheControl` 让渲染器根据模式建议缓存策略，而不是硬编码在中间件中
- 渲染器只负责"建议"，中间件决定最终响应——职责分离

**源码参考：**
- `packages/shared/src/types/context.ts` — RenderContext, RenderResult
- `packages/server/src/middleware/render-middleware.ts` — createRenderContext()
