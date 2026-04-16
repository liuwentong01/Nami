# 插件系统（8 题）

---

## 题目 19：Nami 插件系统支持哪三种钩子执行模式？各自的使用场景是什么？⭐⭐⭐

**答案：**

### 1. Waterfall（瀑布流）

前一个插件的输出作为下一个插件的输入，最终返回经过所有插件修改后的值：

```
initialValue → Plugin A → resultA → Plugin B → resultB → finalResult
```

```typescript
// PluginManager 实现
async runWaterfallHook<T>(hookName, initialValue, ...args): Promise<T> {
  let currentValue = initialValue;
  for (const handler of handlers) {
    try {
      const result = await handler.fn(currentValue, ...args);
      if (result !== undefined) currentValue = result; // undefined 时保持上一个值
    } catch (error) {
      this.handleHookError(hookName, handler.pluginName, error);
      // 继续下一个插件，不中断链条
    }
  }
  return currentValue;
}
```

**使用场景：** 修改配置类的钩子
- `modifyWebpackConfig` — 多个插件依次修改同一份 Webpack 配置
- `modifyRoutes` — 多个插件依次添加/修改路由
- `wrapApp` — 多个插件依次包裹根组件（Theme → Intl → ErrorBoundary）

### 2. Parallel（并行）

所有插件的处理器并发执行，使用 `Promise.allSettled` 确保互不影响：

```
             ┌→ Plugin A ──┐
args ────────├→ Plugin B ──├→ Promise.allSettled → 统计失败数
             └→ Plugin C ──┘
```

**使用场景：** 通知类的钩子
- `onBeforeRender` — 多个插件同时做预处理
- `onAfterRender` — 多个插件同时做后处理（监控上报、日志）
- `onServerStart` — 多个插件同时初始化外部连接

### 3. Bail（短路）

顺序执行，第一个返回非空值的插件决定最终结果，后续插件不执行：

```
args → Plugin A (返回 null) → Plugin B (返回 result) → 停止，返回 result
```

**使用场景：** 竞争式的钩子（目前预留扩展）
- 自定义解析策略：第一个能处理的插件胜出

**源码参考：**
- `packages/core/src/plugin/plugin-manager.ts` — runWaterfallHook, runParallelHook, runBailHook

---

## 题目 20：插件的 enforce 字段有什么作用？如何利用它控制插件执行顺序？⭐⭐⭐

**答案：**

`enforce` 控制插件在同一个钩子中的执行顺序：

```
enforce: 'pre'  →  无 enforce（normal）  →  enforce: 'post'
```

**三种执行位置：**

| enforce 值 | 执行位置 | 典型插件 |
|-----------|---------|---------|
| `'pre'` | 最先执行 | 缓存插件（先检查缓存）、timing 插件（先记录开始时间） |
| 无（normal） | 中间执行 | 业务插件 |
| `'post'` | 最后执行 | 监控插件（最后采集完整指标）、日志插件 |

**实际示例：**

```typescript
// 缓存插件 — 需要在渲染前检查缓存
class CachePlugin implements NamiPlugin {
  enforce = 'pre' as const;
  setup(api) {
    api.onBeforeRender(async (context) => {
      const cached = await cache.get(context.url);
      if (cached) {
        context.extra.__cache_hit = true;
        context.extra.__cache_content = cached;
      }
    });
  }
}

// 监控插件 — 需要在所有其他插件之后采集指标
class MonitorPlugin implements NamiPlugin {
  enforce = 'post' as const;
  setup(api) {
    api.onAfterRender(async (context, result) => {
      // 此时 context.extra 中已有其他插件写入的数据
      reportMetrics({
        url: context.url,
        cacheHit: context.extra.__cache_hit,
        duration: result.meta.duration,
      });
    });
  }
}
```

**排序实现：** HookRegistry 在每次注册新处理器后，按 enforce 级别重新排序 handlers 数组，确保执行顺序始终正确。

**源码参考：**
- `packages/core/src/plugin/hook-registry.ts` — 注册后排序逻辑
- `packages/core/src/plugin/plugin-manager.ts` — registerPlugin() 中的排序

---

## 题目 21：插件钩子执行失败会怎样？Nami 是如何做错误隔离的？⭐⭐⭐⭐

**答案：**

**核心原则：单个插件失败不应该导致整个渲染流程中断。**

### Waterfall 模式的错误隔离

```typescript
async runWaterfallHook<T>(hookName, initialValue, ...args): Promise<T> {
  let currentValue = initialValue;
  for (const handler of handlers) {
    try {
      const result = await handler.fn(currentValue, ...args);
      if (result !== undefined) currentValue = result;
    } catch (error) {
      this.handleHookError(hookName, handler.pluginName, error);
      // 跳过失败的插件，用上一个值继续传递给下一个插件
    }
  }
  return currentValue;
}
```

**关键行为：** 失败的插件返回 `undefined`，Waterfall 保持上一个有效值继续。

### Parallel 模式的错误隔离

```typescript
async runParallelHook(hookName, ...args): Promise<void> {
  const results = await Promise.allSettled(
    handlers.map(h => h.fn(...args))
  );
  // Promise.allSettled 保证所有处理器都有执行机会
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    logger.warn(`${hookName}: ${failed.length} 个插件失败`);
  }
}
```

**关键行为：** `Promise.allSettled`（而非 `Promise.all`）确保一个失败不会取消其他正在执行的插件。

### 防止递归错误

```typescript
handleHookError(hookName, pluginName, error) {
  logger.error(`插件 ${pluginName} 在 ${hookName} 钩子中失败`, error);

  // 防止递归：onError 钩子自身的错误不再触发 onError
  if (hookName !== 'onError') {
    // 异步触发 onError 钩子，不等待结果
    void this.runParallelHook('onError', error, { hookName, pluginName });
  }
}
```

**为什么 `void`？** 异步触发 `onError` 钩子，但不等待结果（fire-and-forget），避免错误处理逻辑阻塞主渲染流程。

**源码参考：**
- `packages/core/src/plugin/plugin-manager.ts` — handleHookError(), runWaterfallHook(), runParallelHook()

---

## 题目 22：context.extra 在插件间通信中扮演什么角色？有哪些约定的键名？⭐⭐⭐

**答案：**

`RenderContext.extra` 是一个 `Record<string, unknown>` 对象，作为插件间以及插件与中间件之间的**数据传递通道**（类似"黑板模式"）。

**数据流向：**

```
Plugin A                    Plugin B                   render-middleware
(onBeforeRender)           (onAfterRender)             (applyPluginExtras)
    │                          │                            │
    ├── extra.__cache_hit      │                            ├── 读取 __cache_hit
    ├── extra.__cache_content  │                            ├── 读取 __custom_headers
    │                          ├── extra.__custom_headers   ├── 读取 __skeleton_fallback
    │                          │                            └── 映射到 HTTP 响应
```

**约定的 extra 键名：**

| 键名 | 写入方 | 读取方 | 说明 |
|------|--------|--------|------|
| `__cache_hit` | cache 插件 | render-middleware | 缓存命中标记（boolean） |
| `__cache_content` | cache 插件 | render-middleware | 缓存内容（HTML 字符串） |
| `__skeleton_fallback` | skeleton 插件 | render-middleware | 骨架屏 HTML |
| `__custom_headers` | 任意插件 | render-middleware | 自定义响应头 |
| `__retry_attempted` | error-boundary 插件 | render-middleware | 是否已重试 |
| `__timing_start` | timing 插件 | timing 插件自身 | 渲染开始时间 |

**命名规范：** 使用 `__` 前缀防止与用户自定义字段冲突。

**为什么不用全局变量或 EventEmitter？**
1. 请求级隔离：extra 是每个 RenderContext 独有的，不会跨请求污染
2. 生命周期清晰：随 RenderContext 创建和销毁
3. 类型安全：可以在插件中做类型断言

**源码参考：**
- `packages/shared/src/types/render.ts` — RenderContext.extra
- `packages/server/src/middleware/render-middleware.ts` — applyPluginExtras()

---

## 题目 23：如何编写一个 Nami 插件？描述完整的开发流程。⭐⭐⭐

**答案：**

### 步骤 1：实现 NamiPlugin 接口

```typescript
import type { NamiPlugin, RenderContext, RenderResult } from '@nami/shared';

export class MyAnalyticsPlugin implements NamiPlugin {
  name = 'my-analytics-plugin'; // 唯一标识，kebab-case
  version = '1.0.0';
  enforce = 'post' as const;   // 在其他插件之后执行

  private reportUrl: string;

  constructor(options: { reportUrl: string }) {
    this.reportUrl = options.reportUrl;
  }

  setup(api) {
    const logger = api.getLogger(); // 带插件名前缀的日志
    const config = api.getConfig(); // 冻结的配置对象（只读）

    // 服务端阶段钩子
    api.onBeforeRender(async (context: RenderContext) => {
      context.extra.__analytics_start = Date.now();
    });

    api.onAfterRender(async (context: RenderContext, result: RenderResult) => {
      const duration = Date.now() - (context.extra.__analytics_start as number);
      logger.info('渲染完成', { url: context.url, duration });
    });

    api.onRenderError(async (context, error) => {
      logger.error('渲染失败', { url: context.url, error: error.message });
    });

    // 客户端阶段钩子
    api.wrapApp((app) => (
      <AnalyticsProvider reportUrl={this.reportUrl}>
        {app}
      </AnalyticsProvider>
    ));

    // 资源清理
    api.onDispose(async () => {
      logger.info('插件资源已清理');
    });
  }
}
```

**补充说明：`setup(api)` 里的 `api` 是什么？**

这里的 `api` 不是全局变量，而是框架在注册当前插件时传入的 `PluginAPI` 实例。流程是：

1. `PluginManager.registerPlugin(plugin)` 被调用
2. 框架为当前插件创建一个专属的 `PluginAPIImpl`
3. 执行 `plugin.setup(api)`，把这个实例作为参数传给插件
4. 插件通过 `api.onBeforeRender()`、`api.onAfterRender()`、`api.wrapApp()` 等方法注册钩子

之所以不是全局单例，而是"每个插件一个独立 api 实例"，是为了：

- 准确记录钩子和中间件是由哪个插件注册的
- 提供带插件名前缀的日志实例
- 在插件卸载或框架关闭时精确清理当前插件的资源

### 步骤 2：注册插件

```typescript
// nami.config.ts
export default defineConfig({
  plugins: [
    new MyAnalyticsPlugin({ reportUrl: 'https://analytics.example.com' }),
  ],
});
```

### 步骤 3：注意事项

1. **Waterfall 钩子必须返回值**：`modifyRoutes`、`modifyWebpackConfig`、`wrapApp` 必须 return
2. **内部 try/catch**：插件逻辑应自行捕获异常，不要让异常逃逸
3. **onDispose 清理资源**：数据库连接、定时器等必须在 onDispose 中关闭
4. **getConfig() 是只读的**：不能直接修改配置，用 `modifyWebpackConfig` 等钩子修改

**源码参考：**
- `packages/shared/src/types/plugin.ts` — NamiPlugin 接口
- `packages/core/src/plugin/plugin-api.ts` — PluginAPI 可用方法

---

## 题目 24：PluginManager 是如何管理插件生命周期的？插件是按什么顺序注册和销毁的？⭐⭐⭐⭐

**答案：**

### 注册阶段

```
1. 收集所有插件（来自 config.plugins）
2. 按 enforce 排序：pre → normal → post
3. 依次调用每个插件的 setup(api)
4. setup 中，插件通过 api 注册各种钩子处理器
5. 处理器注册到 HookRegistry，按 enforce 排序存储
```

**防重复注册：**
```typescript
registerPlugin(plugin) {
  if (this.plugins.has(plugin.name)) {
    throw new NamiError(`插件 ${plugin.name} 已注册`);
  }
  // ...
}
```

每个插件获得独立的 `PluginAPIImpl` 实例，确保插件间互不干扰。

### 运行阶段

钩子按注册顺序（受 enforce 影响）执行。三种模式的行为见题目 19。

### 销毁阶段（dispose）

```typescript
async dispose() {
  // 1. 运行所有插件的 onDispose 钩子（带错误隔离）
  await this.runParallelHook('onDispose');

  // 2. 清空 HookRegistry（释放所有处理器引用）
  this.hookRegistry.clear();

  // 3. 清空插件列表
  this.plugins.clear();

  // 4. 重置状态
  this.disposed = true;
}
```

**销毁触发场景：**
- 优雅停机（SIGTERM）
- 开发模式热更新（重新加载插件）

**为什么 onDispose 也用 `Promise.allSettled`？**
确保所有插件都有清理机会。如果用 `Promise.all`，一个插件的清理失败会导致后续插件无法清理，可能泄漏资源。

**源码参考：**
- `packages/core/src/plugin/plugin-manager.ts` — registerPlugin(), dispose()
- `packages/core/src/plugin/hook-registry.ts` — clear()

---

## 题目 25：wrapApp 钩子的实现原理是什么？多个插件如何嵌套包裹根组件？⭐⭐⭐

**答案：**

`wrapApp` 使用 Waterfall 模式，将 React 元素依次传递给每个插件包裹：

```
初始 <App />
  → Plugin A: <ThemeProvider>{app}</ThemeProvider>
  → Plugin B: <IntlProvider>{app}</IntlProvider>
  → Plugin C: <ErrorBoundary>{app}</ErrorBoundary>

最终结果:
<ErrorBoundary>
  <IntlProvider>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </IntlProvider>
</ErrorBoundary>
```

**注意执行顺序和嵌套顺序：** 最先执行的插件在最内层，最后执行的在最外层。这意味着 `enforce: 'post'` 的 ErrorBoundary 插件包裹在最外层，能够捕获内层所有 Provider 的错误。

**客户端入口中的使用：**

```typescript
// packages/client/src/entry-client.tsx
let appElement = <NamiApp data={serverData} />;

// Waterfall: 依次包裹
appElement = await pluginManager.runWaterfallHook('wrapApp', appElement);

// 最终挂载
hydrateRoot(container, appElement);
```

**服务端的对应处理：**

SSR 渲染时，SSRRenderer 也会执行 wrapApp 钩子，确保服务端和客户端的组件树结构一致（否则 Hydration 会 mismatch）。

**源码参考：**
- `packages/core/src/plugin/plugin-manager.ts` — runWaterfallHook('wrapApp', ...)
- `packages/client/src/app.tsx` — NamiApp 根组件

---

## 题目 26：HookRegistry 的内部数据结构是什么？它如何保证处理器的执行顺序？⭐⭐⭐⭐

**答案：**

### 数据结构

```typescript
class HookRegistry {
  // 主存储：钩子名 → 处理器列表
  private hooks: Map<string, HookHandler[]>;

  // HookHandler 结构
  interface HookHandler {
    fn: Function;                      // 处理器函数
    pluginName: string;                // 来源插件名（追踪用）
    enforce: 'pre' | 'normal' | 'post'; // 执行优先级
  }
}
```

### 执行顺序保证

每次注册新处理器后，对该钩子的处理器列表做稳定排序：

```typescript
register(hookName, handler) {
  // 1. 验证钩子名合法性（必须在 HOOK_DEFINITIONS 中）
  if (!HOOK_DEFINITIONS.has(hookName)) {
    throw new NamiError(`未知钩子: ${hookName}`);
  }

  // 2. 验证处理器是函数
  if (typeof handler.fn !== 'function') {
    throw new NamiError(`处理器必须是函数`);
  }

  // 3. 添加到列表
  this.hooks.get(hookName).push(handler);

  // 4. 按 enforce 重新排序（稳定排序）
  handlers.sort((a, b) => {
    const order = { pre: 0, normal: 1, post: 2 };
    return order[a.enforce] - order[b.enforce];
  });
}
```

**为什么用稳定排序？**

同一个 enforce 级别内，保持注册顺序。例如两个 `enforce: 'pre'` 的插件，先注册的先执行。稳定排序保证这个特性。

### 防御性复制

```typescript
getHandlers(hookName): HookHandler[] {
  return [...this.hooks.get(hookName)]; // 返回副本，防止外部修改
}
```

### 按插件清理

```typescript
removeByPlugin(pluginName: string) {
  for (const [hookName, handlers] of this.hooks) {
    this.hooks.set(hookName, handlers.filter(h => h.pluginName !== pluginName));
  }
}
```

用于开发模式热更新时卸载旧版插件的处理器。

**源码参考：**
- `packages/core/src/plugin/hook-registry.ts`
