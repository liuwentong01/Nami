# Nami Examples

`examples` 目录现在分为一个综合验收应用和四个单模式入门示例。第一次阅读 Nami、准备面试或验证框架能力时，请从 [`feature-showcase`](./feature-showcase) 开始。

## 示例选择

| 目录                                     | 定位                                           | 适合用途                             | 当前建议               |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------ | ---------------------- |
| [`feature-showcase`](./feature-showcase) | CSR / SSR / Streaming SSR / SSG / ISR 混合应用 | 阅读完整链路、运行实验、回归框架能力 | **推荐，当前验收基线** |
| [`basic-csr`](./basic-csr)               | 单一 CSR 最小示例                              | 快速查看最小路由配置                 | 入门参考               |
| [`basic-ssr`](./basic-ssr)               | 单一 SSR 示例                                  | 对照 GSSP、元素工厂与 Hydration      | 入门参考               |
| [`basic-ssg`](./basic-ssg)               | 单一 SSG 示例                                  | 对照 GSP / GSPths 与静态产物         | 入门参考               |
| [`basic-isr`](./basic-isr)               | 单一 ISR 示例                                  | 对照 revalidate / fallback 与缓存    | 入门参考               |

四个 `basic-*` 示例都使用当前协议：SSR/SSG/ISR 的 `entry-server.tsx` 只导出
`createAppElement(context)`；`app-shell-plugin.tsx` 在 `nami.config.ts` 注册，构建期、服务端运行时与客户端按相同顺序执行 `wrapApp`，避免两端分别手工拼装根树。综合示例在此基础上覆盖混合路由、Streaming、插件、稳定性和 ISR 状态机，是完整验收基线。

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
3. `View Source` 中是否已有业务 HTML，以及 `window.__NAMI_DATA__` 是否为 `{ version, props, degraded, renderMode, routePath }`。
4. Network 中的状态码、`X-Nami-*`、缓存头与流式传输。
5. 浏览器控制台中的 Hydration、路由和插件生命周期事件。
6. 服务端日志中的路由匹配、Renderer、Plugin Hook 与 ISR 重建。

完整的路由地图、验证命令和已知边界见 [`feature-showcase/README.md`](./feature-showcase/README.md)。
