# Nami Examples

`examples` 目录现在分为一个综合验收应用和四个单模式入门示例。第一次阅读 Nami、准备面试或验证框架能力时，请从 [`feature-showcase`](./feature-showcase) 开始。

## 示例选择

| 目录                                     | 定位                                           | 适合用途                             | 当前建议               |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------ | ---------------------- |
| [`feature-showcase`](./feature-showcase) | CSR / SSR / Streaming SSR / SSG / ISR 混合应用 | 阅读完整链路、运行实验、回归框架能力 | **推荐，当前验收基线** |
| [`basic-csr`](./basic-csr)               | 单一 CSR 草图                                  | 快速查看最小路由配置                 | 仅作概念参考           |
| [`basic-ssr`](./basic-ssr)               | 单一 SSR 草图                                  | 对照 GSSP 与服务端渲染               | 仅作概念参考           |
| [`basic-ssg`](./basic-ssg)               | 单一 SSG 草图                                  | 对照 GSP / GSPths                    | 仅作概念参考           |
| [`basic-isr`](./basic-isr)               | 单一 ISR 草图                                  | 对照 revalidate / fallback           | 仅作概念参考           |

四个 `basic-*` 示例保留了早期的“小而独立”写法，部分配置和入口形态反映的是框架演进过程，不作为本轮可运行性验收标准。综合示例使用当前源码中的真实类型、入口协议、构建任务和运行时 API，并对尚需兼容的边界做了明确注释。

## 快速开始

在仓库根目录执行：

```bash
pnpm install
pnpm build
pnpm typecheck:showcase
pnpm dev:showcase
```

`dev:showcase` 当前采用“完整构建 + 生产服务”的可靠预览路径，因此没有 HMR；原生 `nami dev` 的配置 Hook/SSG 边界见综合示例 README。打开 `http://127.0.0.1:3100`。生产态验证：

```bash
pnpm build:showcase
pnpm start:showcase
```

## 推荐观察方式

不要只看页面视觉结果。每进入一个示例，同时观察：

1. `src/routes.ts` 中的路由配置与渲染模式。
2. 页面模块导出的 GSSP、GSP 或 GSPths 数据函数。
3. `View Source` 中是否已有业务 HTML 和 `window.__NAMI_DATA__`。
4. Network 中的状态码、`X-Nami-*`、缓存头与流式传输。
5. 浏览器控制台中的 Hydration、路由和插件生命周期事件。
6. 服务端日志中的路由匹配、Renderer、Plugin Hook 与 ISR 重建。

完整的路由地图、验证命令和已知边界见 [`feature-showcase/README.md`](./feature-showcase/README.md)。
