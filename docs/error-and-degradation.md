# 错误处理与降级

Nami 框架通过多层错误防护确保即使在最恶劣的情况下也能返回有意义的页面内容。本文档详细讲解从渲染器级别到全局级别的错误处理机制，以及 5 级降级策略的完整实现。

---

## 1. 错误防护层级

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Koa app.on('error')        — 全局兜底              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Layer 2: errorIsolation 中间件    — 500 HTML 响应       │ │
│ │ ┌─────────────────────────────────────────────────────┐ │ │
│ │ │ Layer 3: renderMiddleware       — 骨架屏 + 降级管理  │ │ │
│ │ │ ┌─────────────────────────────────────────────────┐ │ │ │
│ │ │ │ Layer 4: Renderer try/catch   — 降级链           │ │ │ │
│ │ │ │ ┌─────────────────────────────────────────────┐ │ │ │ │
│ │ │ │ │ Layer 5: Plugin hooks       — 错误隔离      │ │ │ │ │
│ │ │ │ └─────────────────────────────────────────────┘ │ │ │ │
│ │ │ └─────────────────────────────────────────────────┘ │ │ │
│ │ └─────────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Layer 5: 插件钩子错误隔离

`BaseRenderer.callPluginHook()` 用 try/catch 包裹，插件异常只打 warn 日志，不阻断渲染：

```typescript
protected async callPluginHook(hookName, ...args) {
  if (!this.pluginManager) return;
  try {
    await this.pluginManager.callHook(hookName, ...args);
  } catch (error) {
    this.logger.warn(`插件钩子 [${hookName}] 执行失败，已忽略`);
  }
}
```

### Layer 4: 渲染器降级链

每个渲染器通过 `createFallbackRenderer()` 指向下一级：

```
StreamingSSRRenderer  →  SSRRenderer  →  CSRRenderer  →  null
SSGRenderer           →  CSRRenderer  →  null
ISRRenderer           →  CSRRenderer  →  null
CSRRenderer           →  null（终点）
```

渲染器失败时，上层可以调用 `createFallbackRenderer()` 获取降级渲染器继续尝试。`assetManifest` 沿链传递，确保降级后生成的 HTML 仍然包含正确的 JS/CSS 引用。

### Layer 3: renderMiddleware 的降级管理

```typescript
// render-middleware.ts 简化逻辑
try {
  result = await renderer.render(context);
} catch (renderError) {
  // 优先使用插件提供的骨架屏
  if (context.extra.__skeleton_fallback) {
    result = { html: context.extra.__skeleton_fallback, statusCode: 200 };
  } else {
    // 走 DegradationManager 多级降级
    const degradation = await degradationManager.executeWithDegradation(
      renderFn, context, config.fallback
    );
    result = degradation.result;
  }
}
```

### Layer 2: errorIsolation 中间件

```typescript
try {
  await next(); // 包裹 ISR + render
} catch (error) {
  ctx.status = 500;
  ctx.body = errorHTML; // 可自定义模板
  ctx.set('X-Nami-Error', 'true');
}
```

### Layer 1: Koa 全局错误

```typescript
app.on('error', (err, ctx) => {
  logger.error('Koa 未捕获错误', { error: err.message });
});
```

## 2. 五级降级策略（DegradationManager）

```
Level 0: 正常渲染 ✓ → 直接返回
     │ 失败
     ▼
Level 1: 重试 (maxRetries 次)
     │ 仍然失败
     ▼
Level 2: CSR 降级
     │ 配置关闭或失败
     ▼
Level 3: 骨架屏
     │ 未配置或失败
     ▼
Level 4: 静态 HTML
     │ 未配置或失败
     ▼
Level 5: 503 服务不可用
```

### Level 0 — 正常渲染

```typescript
try {
  const result = await renderFn(context);
  return { result, level: DegradationLevel.None, errors: [] };
} catch (error) {
  errors.push(error);
  // 进入降级流程
}
```

### Level 1 — 重试

```typescript
if (config.maxRetries > 0) {
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await renderFn(context);
      result.meta.degraded = true;
      result.meta.degradeReason = `重试第 ${attempt} 次成功`;
      return { result, level: DegradationLevel.Retry, errors };
    } catch (error) {
      errors.push(error);
    }
  }
}
```

适用于临时故障（如数据库连接瞬断、API 超时）。

### Level 2 — CSR 降级

```typescript
if (config.ssrToCSR) {
  const { cssLinks, jsScripts } = this.resolveAssets(); // 从 asset-manifest 解析
  const html = `
    <!DOCTYPE html>
    <html>
    <head>${cssLinks}</head>
    <body>
      <div id="nami-root"></div>
      ${jsScripts}
    </body>
    </html>
  `;
  return { result: { html, statusCode: 200 }, level: DegradationLevel.CSRFallback };
}
```

**关键**：CSR fallback 必须包含正确的 JS/CSS 引用（通过 `resolveAssets()`），否则页面将完全空白。这也是为什么 `DegradationManager` 构造函数接受 `publicPath` 和 `assetManifest` 参数。

响应头 `X-Nami-Degraded: csr-fallback` 标识此响应经过了降级处理。

### Level 3 — 骨架屏

```typescript
// context.route.skeleton 是骨架屏组件的文件路径（string 类型）
if (context.route.skeleton) {
  // 加载骨架屏组件并渲染为 HTML
  const SkeletonComponent = await loadSkeletonComponent(context.route.skeleton);
  const html = renderToString(<SkeletonComponent />);
  return { result: { html, statusCode: 200 }, level: DegradationLevel.Skeleton };
}
```

骨架屏为用户提供视觉反馈（"加载中"的占位界面），体验优于纯空白页面。`@nami/plugin-skeleton` 插件可以在 `onRenderError` 时自动根据路由类型生成骨架屏 HTML，写入 `context.extra.__skeleton_fallback`，由 `renderMiddleware` 消费。

> **配置方式**：在路由配置中指定骨架屏组件文件路径：
> ```typescript
> { path: '/products/:id', component: './pages/product', skeleton: './components/ProductSkeleton' }
> ```

### Level 4 — 静态 HTML

```typescript
if (config.staticHTML) {
  return { result: { html: config.staticHTML, statusCode: 200 } };
}
```

使用 `fallback.staticHTML` 配置的兜底 HTML。通常是上一次成功渲染的快照或人工编写的降级页面。

### Level 5 — 503 服务不可用

```typescript
const html = `
  <div style="text-align:center;">
    <h1>503</h1>
    <p>服务暂时不可用，请稍后重试</p>
  </div>
`;
return { result: { html, statusCode: 503 }, level: DegradationLevel.ServiceUnavailable };
```

所有降级手段均失败后的终极兜底。

## 3. 降级配置

```typescript
// nami.config.ts
export default defineConfig({
  fallback: {
    ssrToCSR: true,           // 是否允许 SSR → CSR 降级
    maxRetries: 1,            // 失败后重试次数（0 = 不重试）
    timeout: 5000,            // 降级超时
    staticHTML: `             // 兜底静态 HTML
      <!DOCTYPE html>
      <html>
      <body>
        <h1>页面暂时不可用</h1>
        <p>我们正在修复，请稍后访问</p>
      </body>
      </html>
    `,
  },
});
```

## 4. 错误分类系统

`ErrorHandler`（`@nami/core`）对错误进行规范化和分类：

### 错误码体系

| 错误码范围 | 分类 | 示例 |
|-----------|------|------|
| `1xxx` | 配置错误 | 配置校验失败、文件不存在 |
| `2xxx` | 渲染错误 | SSR 失败、SSR 超时、CSR 失败 |
| `3xxx` | 数据错误 | 数据预取失败、数据预取超时 |
| `4xxx` | 缓存错误 | 缓存读取失败、缓存写入失败 |
| `5xxx` | 插件错误 | 插件加载失败、插件初始化失败 |

### 可恢复性判断

```typescript
const RECOVERABLE_CODES = new Set([
  'RENDER_SSR_FAILED',
  'RENDER_SSR_TIMEOUT',
  'DATA_FETCH_FAILED',
  'DATA_FETCH_TIMEOUT',
  'CACHE_READ_FAILED',
  'CACHE_WRITE_FAILED',
  'PLUGIN_HOOK_FAILED',
]);

function isRecoverable(error: NamiError): boolean {
  return RECOVERABLE_CODES.has(error.code);
}
```

可恢复错误会进入降级流程；不可恢复错误（如配置错误）直接抛出。

## 5. React Error Boundary

### 服务端 Error Boundary

```typescript
// packages/core/src/error/error-boundary.tsx
class ErrorBoundary extends React.Component {
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    ErrorHandler.handle(error, { componentStack: errorInfo.componentStack });
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, this.reset);
      }
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
```

### 客户端 Error Boundary

`ClientErrorBoundary`（`@nami/client`）增加了：
- `resetKeys` 机制：当依赖的 key 变化时自动重置错误状态
- 开发模式下展示 `ErrorOverlay`：全屏错误浮层，显示堆栈信息

### lazyRoute Error Boundary

懒加载路由内置轻量 `LazyErrorBoundary`：

```typescript
const About = lazyRoute(() => import('./pages/about'), {
  loading: <Spinner />,
  errorFallback: <div>页面加载失败，请刷新重试</div>,
});
```

当动态 import 失败（如网络断开、chunk 加载超时）时显示 `errorFallback`。

## 6. 错误上报

### ErrorReporter

```typescript
// packages/core/src/error/error-reporter.ts
ErrorReporter.report(error, context);
```

- **采样**：`config.monitor.sampleRate` 控制上报比例
- **服务端**：`setImmediate` + `fetch(reportUrl)`（不阻塞请求）
- **客户端**：优先 `navigator.sendBeacon`（页面关闭前可靠发送），降级到 `fetch` + `keepalive`

### Hydration Mismatch 检测

```typescript
// packages/client/src/hydration/hydration-mismatch.ts
detectMismatch(container); // DOM 比对检测
reportMismatch(mismatchInfo); // 上报
```

类型包括：
- `TextContent` — 文本内容不一致
- `Attribute` — 属性不一致
- `MissingNode` — 客户端缺少节点
- `ExtraNode` — 客户端多出节点

## 7. 插件级错误处理

### @nami/plugin-error-boundary

```typescript
new NamiErrorBoundaryPlugin({
  maxRetries: 2,
  fallbackPages: { 404: CustomNotFound, 500: CustomError },
})
```

- `wrapApp`：用 `RouteErrorBoundary` 包裹应用，路由粒度捕获错误
- `onRenderError`：执行 `RetryStrategy.shouldRetry` + `DegradeStrategy.degrade`
- 降级结果写入 `context.extra`，由 `renderMiddleware` 消费

### @nami/plugin-skeleton

```typescript
new NamiSkeletonPlugin({ layouts: ['list', 'detail'] })
```

- `onRenderError`：根据路由类型自动生成骨架屏 HTML
- 写入 `context.extra.__skeleton_fallback`
- `renderMiddleware` 优先使用此骨架屏作为降级内容

## 8. 错误处理最佳实践

### 在 getServerSideProps 中处理错误

```typescript
export async function getServerSideProps(ctx) {
  try {
    const data = await fetchAPI('/products');
    return { props: { data } };
  } catch (error) {
    // 方式一：返回降级数据
    return { props: { data: [], error: '数据加载失败' } };

    // 方式二：返回 404
    // return { notFound: true };

    // 方式三：重定向
    // return { redirect: { destination: '/maintenance', permanent: false } };
  }
}
```

### 在组件中使用 Error Boundary

```tsx
import { NamiErrorBoundary } from '@nami/core';

function ProductPage() {
  return (
    <NamiErrorBoundary
      fallback={(error, reset) => (
        <div>
          <h2>出错了: {error.message}</h2>
          <button onClick={reset}>重试</button>
        </div>
      )}
    >
      <ProductDetail />
    </NamiErrorBoundary>
  );
}
```

### 全局错误监听（插件）

```typescript
api.onError(async (error, context) => {
  // 上报到外部监控系统
  await sentry.captureException(error, { extra: context });
});
```

### 配置降级策略

```typescript
// 保守策略（高可用优先，适合面向用户的 C 端页面）
fallback: {
  ssrToCSR: true,        // SSR 失败降级到 CSR，至少保证页面可用
  maxRetries: 2,         // 重试 2 次，应对瞬时故障
  staticHTML: prebuiltHTML,  // 最终兜底 HTML
}

// 激进策略（数据一致性优先，适合金融/交易类页面）
fallback: {
  ssrToCSR: false,       // 不降级到 CSR，因为 CSR 无法展示服务端数据
  maxRetries: 0,         // 不重试，快速失败
  // 宁可 503 也不返回过期/空数据，避免用户做出错误决策
}
```

> **如何选择？** 问自己一个问题：「如果数据加载失败，展示一个空壳页面和展示错误页面，哪个对用户伤害更大？」对于电商浏览页，空壳（CSR 降级）好过错误页；对于支付页面，错误提示好过展示可能错误的金额。

## 9. 降级全景图

将以上所有机制串联起来：

```
用户请求 GET /products/123
    │
    ▼
errorIsolation 中间件 ── try {
    │
    ▼
isrCacheMiddleware ── 缓存命中? → 直接返回（不进入渲染器）
    │ 未命中
    ▼
renderMiddleware
    │
    ├── RendererFactory.create(mode: 'isr')
    │
    ├── ISRRenderer.render(context)
    │     │
    │     ├── [插件钩子失败] → Layer 5: 忽略，继续渲染
    │     ├── [getStaticProps 失败] → Layer 4: 降级到 CSRRenderer
    │     └── [renderToString 失败] → Layer 4: 降级到 CSRRenderer
    │
    ├── [渲染器完全失败]
    │     │
    │     ├── [有 __skeleton_fallback?] → 返回骨架屏
    │     └── [进入 DegradationManager]
    │           ├── Level 1: 重试
    │           ├── Level 2: CSR 降级
    │           ├── Level 3: 骨架屏
    │           ├── Level 4: 静态 HTML
    │           └── Level 5: 503
    │
} catch (error) ── Layer 2: errorIsolation 兜底 → 500 HTML
```

---

## 下一步

- 想回顾整体架构？→ [架构设计](./architecture.md)
- 想了解更多插件能力？→ [插件系统](./plugin-system.md)
- 回到文档首页？→ [README](./README.md)
