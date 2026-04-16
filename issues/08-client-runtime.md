# 客户端运行时（8 题）

---

## 题目 55：NamiHead 组件的作用是什么？它在 CSR 和 SSR 中的实现有何不同？⭐⭐⭐

**答案：**

### 作用

NamiHead 是一个声明式管理 `<head>` 标签的组件，类似 `react-helmet`。用于在页面组件中设置 title、meta、link、script 等标签。

```tsx
function ProductPage({ product }) {
  return (
    <>
      <NamiHead>
        <title>{product.name} - 商城</title>
        <meta name="description" content={product.description} />
        <meta property="og:image" content={product.imageUrl} />
        <link rel="canonical" href={`/products/${product.id}`} />
      </NamiHead>
      <div>{/* 页面内容 */}</div>
    </>
  );
}
```

### CSR 模式实现

通过 `useEffect` 直接操作 DOM：

```typescript
useEffect(() => {
  // 1. 设置 document.title
  if (title) document.title = title;

  // 2. 创建/更新 meta、link、script 标签
  tags.forEach(tag => {
    const dedupeKey = getMetaDedupeKey(tag);
    const existing = document.querySelector(`[data-nami-head="${dedupeKey}"]`);

    if (existing) {
      updateElement(existing, tag);  // 已存在 → 更新属性
    } else {
      const element = createElement(tag);
      element.setAttribute('data-nami-head', dedupeKey);
      document.head.appendChild(element);
    }
  });

  // 3. 组件卸载时清理
  return () => {
    tags.forEach(tag => {
      const dedupeKey = getMetaDedupeKey(tag);
      const element = document.querySelector(`[data-nami-head="${dedupeKey}"]`);
      if (element) element.remove();
    });
  };
}, [title, tags]);
```

### SSR 模式实现

通过 `HeadManagerContext` 收集标签，在服务端渲染完成后生成 HTML 字符串：

```typescript
// 1. 服务端创建 Head Manager
const headManager = createSSRHeadManager();

// 2. 将 manager 通过 Context 传递
<HeadManagerContext.Provider value={headManager}>
  <App />
</HeadManagerContext.Provider>

// 3. NamiHead 组件在渲染时注册标签（不操作 DOM）
function NamiHead({ children }) {
  const manager = useContext(HeadManagerContext);
  if (manager) {
    manager.addTags(parsedTags); // SSR 模式：注册到收集器
    return null;
  }
  // CSR 模式：useEffect...
}

// 4. 渲染完成后生成 HTML
const headHTML = renderHeadToString(headManager.getCollectedTags());
// → '<title>商品 - 商城</title><meta name="description" content="...">'
```

### 去重策略

同名标签不会重复，后声明的覆盖先声明的：

```
Meta: 按 name 或 property 去重
Link: 按 rel+href 组合去重
Script: 按 src 去重（内联按内容前 50 字符）
Title: 最后设置的生效
```

### 为什么不直接用 react-helmet？

1. 深度集成 SSR 渲染管线（HeadManagerContext）
2. 精简实现，减少 Bundle 体积
3. 自动 XSS 防护（属性值 HTML 转义）
4. 与 Nami 的插件系统协同

**源码参考：**
- `packages/client/src/head/nami-head.tsx`

---

## 题目 56：客户端初始化经历了哪些阶段？Hydration 完成后做了什么？⭐⭐⭐

**答案：**

### 9 阶段初始化流程

```typescript
// packages/client/src/entry-client.tsx
async function initNamiClient() {
  // 阶段 1: 性能标记
  markNamiEvent('client-init-start');

  // 阶段 2: 初始化插件系统
  const pluginManager = new PluginManager(config);
  const pluginInstances = plugins.filter((p) => typeof p !== 'string');
  await pluginManager.registerPlugins(pluginInstances);

  // 阶段 3: 执行 onClientInit 钩子
  await pluginManager.runParallelHook('onClientInit');

  // 阶段 4: 读取服务端注入的数据
  const serverData = readServerData();
  const renderMode = serverData.renderMode || config.defaultRenderMode;

  // 阶段 5: 构建应用元素
  let appElement = <NamiApp
    initialData={serverData.props}
    componentResolver={componentResolver}
    onRouteChange={({ from, to }) => pluginManager.runParallelHook('onRouteChange', { from, to, params: {} })}
  />;

  // 阶段 6: 执行 wrapApp 钩子（Waterfall）
  appElement = await pluginManager.runWaterfallHook('wrapApp', appElement);

  // 阶段 7: 挂载到 DOM
  const container = document.getElementById('nami-root');
  if (renderMode !== 'csr' && container.childNodes.length > 0) {
    hydrateApp(container, appElement, {
      onRecoverableError,
      onHydrated: () => {
        cleanupServerData();
        pluginManager.runParallelHook('onHydrated');
      },
    });
  } else {
    renderApp(container, appElement);
    pluginManager.runParallelHook('onHydrated');
  }

  // 阶段 8: 启动性能监控
  if (config.monitor?.enabled && config.monitor.webVitals !== false) {
    collectWebVitals(() => {}, {
      sampleRate: config.monitor.sampleRate,
      reportUrl: config.monitor.reportUrl,
    });
  }

  // 阶段 9: 注册 Service Worker
  if (serviceWorkerUrl) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(serviceWorkerUrl);
    }, { once: true });
  }

  markNamiEvent('client-init-end');
}
```

### 客户端到底会加载哪些插件？

会加载，但要分清"**哪些插件实例会被注册**"和"**哪些客户端钩子会真正生效**"这两层。

当前 `initNamiClient()` 的真实行为是：
- 接收外部传入的 `plugins`
- **只注册已经解析完成的插件对象**
- 如果数组里还是字符串插件名，客户端会发出 warning，并**忽略这些字符串插件**

也就是说，客户端不会在浏览器里再执行一遍 `PluginLoader` 去解析 `"@nami/plugin-xxx"` 这种字符串；  
它只吃构建期或启动代码里已经准备好的插件实例。

这些插件实例里，真正和客户端运行时相关的，主要是会注册以下钩子：
- `onClientInit`：客户端启动前初始化浏览器侧能力
- `wrapApp`：给根应用包一层 Provider / Boundary / Suspense
- `onHydrated`：Hydration 完成后做收尾或监控
- `onRouteChange`：路由切换时埋点、统计
- `onError`：客户端错误上报

结合当前仓库，可以看到一些真实例子：
- `@nami/plugin-request`：在 `onClientInit` 里初始化客户端请求适配器
- `@nami/plugin-monitor`：在 `onHydrated` 里开始采集 Web Vitals
- `@nami/plugin-skeleton`：通过 `wrapApp` 给应用包 `Suspense`
- `@nami/plugin-error-boundary`：通过 `wrapApp` 注入全局错误边界

所以更准确的说法是：
- **会加载插件**
- 但加载的是**已经解析好的客户端可用插件实例**
- 真正起作用的是这些插件注册的**客户端钩子**

### requestIdleCallback 的用途

```typescript
hydrateApp(container, appElement, {
  onHydrated: () => {
    cleanupServerData();
    pluginManager.runParallelHook('onHydrated');
  },
});
```

**为什么不立即执行 onHydrated？**

当前代码里，`requestIdleCallback` 不在 `entry-client.tsx` 里直接调用，而是封装在 `hydrateApp()` 内部。  
原因还是一样：`hydrateRoot()` 虽然是同步调用，但实际的 Hydration 过程是异步推进的。如果立刻执行 `onHydrated`，React 可能还没真正完成事件绑定和树对接。

所以 `hydrateApp()` 的做法是：
- 优先用 `requestIdleCallback`
- 不支持时退化成 `setTimeout(..., 0)`

这意味着：
- **SSR/SSG/ISR**：`onHydrated` 会在浏览器空闲时触发
- **纯 CSR**：不会等 `requestIdleCallback`，而是在 `renderApp()` 之后直接触发 `onHydrated`，主要是为了保持插件接口一致

### 数据清理

```typescript
function cleanupServerData() {
  try {
    delete window.__NAMI_DATA__;
  } catch {
    window.__NAMI_DATA__ = undefined;
  }

  // 移除注入数据的 script 标签
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    if (script.textContent?.includes('__NAMI_DATA__')) {
      script.remove();
      break;
    }
  }
}
```

**源码参考：**
- `packages/client/src/hydration/hydrate.ts`
- `packages/client/src/entry-client.tsx`
- `packages/client/src/data/data-hydrator.ts` — cleanupServerData()

---

## 题目 57：useNamiData Hook 是如何工作的？为什么需要内部缓存？⭐⭐⭐

**答案：**

### 使用方式

```typescript
function ProductPage() {
  // 读取 getServerSideProps 返回的全部数据
  const data = useNamiData();

  // 或按 key 读取特定字段
  const product = useNamiData('product');
  const relatedProducts = useNamiData('relatedProducts');

  return <div>{product.name}</div>;
}
```

### 实现原理

```typescript
// packages/client/src/data/use-nami-data.ts
function useNamiData<T = any>(key?: string): T {
  const allData = useMemo(() => {
    return DataHydrator.getData(); // 从内部缓存读取
  }, []);

  if (key) return allData[key];
  return allData;
}
```

### DataHydrator 单例

```typescript
// packages/client/src/data/hydrate-data.ts
class DataHydrator {
  private static dataRead = false;
  private static cachedData: Record<string, any> = {};

  static getData() {
    if (!this.dataRead) {
      // 首次读取：从 window.__NAMI_DATA__ 提取并缓存
      if (typeof window !== 'undefined' && window.__NAMI_DATA__) {
        this.cachedData = { ...window.__NAMI_DATA__ };
      }
      this.dataRead = true;
    }
    return this.cachedData;
  }
}
```

### 为什么需要内部缓存？

**时序问题：**

```
时间线:
1. Hydration 开始 → useNamiData() 读取 window.__NAMI_DATA__ ✓
2. Hydration 完成 → cleanupServerData() 删除 window.__NAMI_DATA__
3. 某个延迟组件挂载 → useNamiData() 读取 window.__NAMI_DATA__ ✗ (已删除!)
```

如果不缓存，步骤 3 中的组件无法读取数据。内部缓存确保：
- 第一次读取时从 `window.__NAMI_DATA__` 复制到内部变量
- 后续所有读取都从内部缓存返回
- `cleanupServerData()` 删除全局变量不影响已缓存的数据

**为什么要清理 window.__NAMI_DATA__？**

内存优化：`__NAMI_DATA__` 可能包含大量数据（如商品列表）。Hydration 完成后这份数据已经在 React 组件的 state 中了，`window.__NAMI_DATA__` 变成了冗余副本。清理释放内存。

**源码参考：**
- `packages/client/src/data/use-nami-data.ts`
- `packages/client/src/data/hydrate-data.ts`

---

## 题目 58：NamiRouter 如何实现路由切换时的页面埋点和数据预取？⭐⭐⭐

**答案：**

### 路由切换监听

NamiRouter 内部包含一个 `RouteChangeListener` 组件：

```typescript
// packages/client/src/router/nami-router.tsx
function RouteChangeListener({ onRouteChange }) {
  const location = useLocation();
  const prevLocation = useRef(location);

  useEffect(() => {
    if (prevLocation.current.pathname !== location.pathname) {
      onRouteChange({
        from: prevLocation.current.pathname,
        to: location.pathname,
      });
      prevLocation.current = location;
    }
  }, [location]);

  return null;
}
```

### 插件系统的连接

```typescript
// entry-client.tsx
<NamiApp
  onRouteChange={(change) => {
    // 触发插件系统的 onRouteChange 钩子
    pluginManager.runParallelHook('onRouteChange', change);
  }}
/>
```

**插件可以监听路由切换做各种事情：**

```typescript
// 页面浏览埋点
api.onRouteChange(async ({ from, to }) => {
  analytics.trackPageView(to);
});

// 路由级性能采集
api.onRouteChange(async ({ from, to }) => {
  performance.mark(`route-change-${to}`);
});
```

### 客户端导航的数据预取

路由切换时通过 `/__nami_data__/` API 获取新页面数据：

```typescript
// 伪代码
async function navigateToPage(path) {
  // 1. 开始导航（显示 loading）
  setLoading(true);

  // 2. 预取数据
  const response = await fetch(`/__nami_data__${path}`);
  const { props } = await response.json();

  // 3. 更新页面
  setData(props);
  setLoading(false);

  // 4. 触发 onRouteChange 钩子
}
```

这确保了 SPA 导航和首次 SSR 加载使用同一套数据预取逻辑（`getServerSideProps`），保持一致性。

**源码参考：**
- `packages/client/src/router/nami-router.tsx` — RouteChangeListener
- `packages/server/src/middleware/data-prefetch.ts` — 数据预取 API

---

## 题目 59：NamiApp 的组件树是怎样的？各层组件的职责是什么？⭐⭐⭐

**答案：**

### 组件树结构

```
NamiApp
├── ClientErrorBoundary          // ① 错误隔离
│   └── NamiDataProvider         // ② 数据上下文
│       ├── NamiHead             // ③ 默认 head 标签
│       └── NamiRouter           // ④ 路由系统
│           └── Suspense         // ⑤ 懒加载 fallback
│               └── LazyPage     // ⑥ 路由页面组件
```

### 各层职责

**① ClientErrorBoundary**
- 最外层错误边界，捕获子树中未被处理的 React 错误
- 显示错误 fallback UI（可自定义）
- 触发 `onError` 插件钩子上报错误

**② NamiDataProvider**
- React Context Provider，向子组件提供服务端注入的数据
- 让 `useNamiData` Hook 能读取 SSR/ISR 预取的数据
- 数据在整个组件树生命周期中保持稳定

**③ NamiHead（默认）**
- 从配置中读取默认的 title 和 description
- 页面级 NamiHead 可以覆盖这些默认值
- 确保所有页面至少有基础的 head 标签

**④ NamiRouter**
- 基于 `react-router-dom` v6
- 将 NamiRoute 配置转换为 Route 组件树
- 包含 RouteChangeListener 监听路由变化
- 管理 lazy 组件缓存

**⑤ Suspense**
- 每个路由被 Suspense 包裹
- 路由 chunk 下载期间显示 loadingFallback
- 与 React.lazy() 配合实现代码分割

**⑥ LazyPage**
- React.lazy() 包裹的路由组件
- 按需加载（用户访问时才下载 chunk）
- 首次加载后缓存（不会重复下载）

### 为什么 ErrorBoundary 在最外层？

错误边界只能捕获**子组件**的错误。放在最外层确保 DataProvider、Router、任何页面组件的错误都能被捕获，提供统一的错误兜底 UI。

**源码参考：**
- `packages/client/src/app.tsx` — NamiApp 组件

---

## 题目 60：React.lazy 组件为什么需要缓存？不缓存会有什么问题？⭐⭐⭐

**答案：**

### 问题

```typescript
// ❌ 不缓存的写法
function renderRoute(route) {
  const LazyComponent = React.lazy(() => import(`./pages/${route.component}`));
  return <Route path={route.path} element={<LazyComponent />} />;
}
```

每次组件 re-render 时，`React.lazy()` 创建一个**新的** lazy 包装器。React 会认为这是一个不同的组件类型，导致：
1. 旧组件卸载（`componentWillUnmount` / cleanup effects）
2. 新组件重新挂载（重新执行所有 effects）
3. 组件内部状态丢失（表单输入、滚动位置等）
4. 可能触发不必要的网络请求（重新下载 chunk）

### 解决方案：缓存 lazy 包装器

```typescript
// ✅ 缓存的写法
const lazyComponentCache = new Map<string, React.LazyExoticComponent>();

function getLazyComponent(key: string) {
  if (!lazyComponentCache.has(key)) {
    lazyComponentCache.set(key, React.lazy(routeComponentLoaders[key]));
  }
  return lazyComponentCache.get(key);
}
```

每个路由组件只创建一次 lazy 包装器。后续 re-render 时返回同一个引用，React 知道这是同一个组件，不会卸载/重挂载。

### Map 而非对象

使用 `Map` 而非普通对象，因为 Map 的键不受原型链影响，且 `.has()` / `.get()` 性能更好。

**源码参考：**
- `packages/client/src/router/nami-router.tsx` — lazyComponentCache

---

## 题目 61：Web Vitals 在 Nami 中是如何采集的？采集了哪些指标？⭐⭐

**答案：**

### 采集的核心指标

| 指标 | 全称 | 含义 | 阈值 |
|------|------|------|------|
| **LCP** | Largest Contentful Paint | 最大内容元素的渲染时间 | < 2.5s |
| **FID** | First Input Delay | 首次输入到响应的延迟 | < 100ms |
| **CLS** | Cumulative Layout Shift | 累计布局偏移 | < 0.1 |
| **FCP** | First Contentful Paint | 首次内容渲染时间 | < 1.8s |
| **TTFB** | Time to First Byte | 首字节时间 | < 800ms |

### 采集方式

```typescript
// 客户端初始化后（阶段 8）
import { getLCP, getFID, getCLS, getFCP, getTTFB } from 'web-vitals';

function collectWebVitals() {
  getLCP(metric => reportMetric(metric));
  getFID(metric => reportMetric(metric));
  getCLS(metric => reportMetric(metric));
  getFCP(metric => reportMetric(metric));
  getTTFB(metric => reportMetric(metric));
}

function reportMetric(metric) {
  // 通过插件系统上报
  pluginManager.callHook('onWebVital', {
    name: metric.name,     // 'LCP', 'FID', etc.
    value: metric.value,   // 数值
    rating: metric.rating, // 'good', 'needs-improvement', 'poor'
    id: metric.id,
  });
}
```

### 与监控插件的集成

`@nami/plugin-monitor` 监听 `onWebVital` 钩子，将指标批量上报到监控平台：

```typescript
api.onWebVital(async (metric) => {
  collector.add(metric);
});

// 定时 flush
setInterval(() => {
  const metrics = collector.drain();
  if (metrics.length > 0) {
    navigator.sendBeacon(reportUrl, JSON.stringify(metrics));
  }
}, 5000);
```

### Nami 自定义性能标记

除了 Web Vitals，Nami 还采集框架自身的性能数据：

```typescript
markNamiEvent('client-init-start');
// ... 初始化过程 ...
markNamiEvent('client-init-end');

// 可以测量:
measureBetween('client-init-start', 'client-init-end');
// → "Nami client init: 45ms"
```

**源码参考：**
- `packages/client/src/performance/web-vitals.ts`
- `packages/plugin-monitor/src/collectors/performance-collector.ts`

---

## 题目 62：generateDataScript() 中的 XSS 防护是怎么实现的？为什么普通的 JSON.stringify 不够安全？⭐⭐⭐⭐

**答案：**

### 问题

```html
<!-- 如果用户数据中包含恶意内容 -->
<script>
  window.__NAMI_DATA__ = {"title":"</script><script>alert('xss')</script>"}
</script>
```

HTML 解析器会在第一个 `</script>` 处关闭 script 标签，后面的 `<script>alert('xss')</script>` 会被当作新的脚本执行。

`JSON.stringify()` 不会转义 `</script>`，因为它是合法的 JSON 字符串内容。

### generateDataScript 的安全处理

这里不能用 `&lt;` / `&gt;` 这种 **HTML 实体（HTML entity）**，而要用 `\u003C` / `\u003E` 这种 **Unicode 转义序列（Unicode escape sequence）**。

原因是两者所处的上下文不同：
- `&lt;` / `&gt;`：适合 **HTML 文本节点或属性值** 场景，例如 `<title>`、`<meta content="...">`
- `\u003C` / `\u003E`：适合 **`<script>` 标签里的 JavaScript/JSON 源码** 场景

`generateDataScript()` 注入的是：

```html
<script>window.__NAMI_DATA__=...</script>
```

这里 `<script>` 里的内容会被当作 **JavaScript 源码** 解析，而不是普通 HTML 文本。  
如果你把 `<` 变成 `&lt;`，浏览器不会把它还原成 `<` 再交给 JS，而是会把 `&lt;` 当作 4 个普通字符写进字符串里，导致最终数据变了：

```javascript
// 你想得到的数据
"<script>"

// 如果用 HTML 实体，最终会变成
"&lt;script&gt;"
```

而 `\u003C` 是 JavaScript / JSON 标准里定义好的 Unicode 转义写法，不是 Nami 自己发明的。  
JS 解析器在执行脚本时会把：

```javascript
"\u003C"
```

还原成真正的 `<` 字符，所以既能避开 HTML 解析阶段对 `</script>` 的识别，又不会改变最终数据值。

```typescript
const UNSAFE_CHARS = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function safeStringify(data: unknown): string {
  return JSON.stringify(data).replace(/[<>/\u2028\u2029]/g, (char) => UNSAFE_CHARS[char] || char);
}

function generateDataScript(data: Record<string, unknown>): string {
  const serialized = safeStringify(data);
  return `<script>window.__NAMI_DATA__=${serialized}</script>`;
}
```

### 转义后的效果

```html
<script>
  window.__NAMI_DATA__ = {"title":"\u003C\u002Fscript\u003E\u003Cscript\u003Ealert('xss')\u003C\u002Fscript\u003E"}
</script>
```

HTML 解析器不会将 `\u003c/script\u003e` 识别为闭合标签。但 JavaScript 解析器会正确将 `\u003c` 识别为 `<`，所以 `JSON.parse()` 后数据完全正确。

### 为什么还要转义 U+2028 和 U+2029？

U+2028（Line Separator）和 U+2029（Paragraph Separator）在 JSON 中是合法的字符串内容，但在 JavaScript 中被视为换行符。如果不转义，嵌入到 `<script>` 标签中会导致 JavaScript 语法错误：

```javascript
// 未转义 → JS 语法错误
window.__NAMI_DATA__ = {"content":"line1
line2"} // SyntaxError: Unexpected token

// 转义后 → 正确
window.__NAMI_DATA__ = {"content":"line1\u2028line2"} // OK
```

**源码参考：**
- `packages/shared/src/utils/serialize.ts` — `safeStringify()` / `generateDataScript()`
- `packages/core/src/data/serializer.ts`
- `packages/client/src/head/nami-head.tsx` — `escapeHtml()`（HTML 属性值转义，对比脚本上下文）
