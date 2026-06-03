# Nami Framework Learning Documentation

> Nami is a full-stack isomorphic rendering framework based on React 18 + Koa + Webpack. It supports five rendering modes: CSR / SSR / SSG / ISR / Streaming SSR, and provides enterprise-grade capabilities such as a Vite-style plugin system, 5-level degradation protection, cluster deployment, and incremental static regeneration.

This documentation set is designed for developer training. Its goal is to help you **not only use Nami, but also understand the principles behind it**. Each document includes code examples, principle diagrams, common pitfalls, and best practices.

---

## Documentation Index

| Document | Contents | Best For |
|------|------|--------|
| [Quick Start](./quick-start.md) | Project creation, configuration, CLI commands, first page | All developers |
| [Architecture Design](./architecture.md) | Monorepo structure, package dependencies, request lifecycle, data flow | Architects, core developers |
| [Five Rendering Modes](./rendering-modes.md) | CSR / SSR / SSG / ISR / Streaming SSR principles and selection | Full-stack developers |
| [Plugin System](./plugin-system.md) | Hook mechanism, writing plugins, official plugins, best practices | Plugin developers |
| [Routing System](./routing.md) | Route configuration, matching algorithm, lazy loading, data prefetching | Frontend developers |
| [ISR and Caching](./isr-and-caching.md) | SWR strategy, three cache backends, on-demand invalidation, cache warming | Backend / Ops |
| [Server and Middleware](./server-and-middleware.md) | Koa middleware pipeline, cluster mode, graceful shutdown | Backend developers / Ops |
| [Build System](./webpack-build.md) | Webpack configuration, Loader, Plugin, code splitting | Build engineers |
| [Error Handling and Degradation](./error-and-degradation.md) | 5-level degradation strategy, Error Boundary, error reporting | Full-stack developers |

---

## Framework Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       nami.config.ts                        │
│          (App config: routes, rendering modes, plugins)      │
└─────────────────────┬───────────────────────────────────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │  nami    │ │  nami    │ │  nami    │
   │  build   │ │  dev     │ │  start   │
   │ (CLI)    │ │ (CLI)    │ │ (CLI)    │
   └────┬─────┘ └────┬─────┘ └────┬─────┘
        │            │            │
        ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌───────────────────────┐
   │ @nami/   │ │ Dev      │ │ Koa Server            │
   │ webpack  │ │ Server   │ │ (Middleware pipeline)  │
   │ Builder  │ │ + HMR    │ │                       │
   └────┬─────┘ └──────────┘ │ shutdown → timing →   │
        │                    │ security → context →   │
        ▼                    │ health → static →      │
   ┌──────────┐              │ user → plugin →        │
   │ dist/    │              │ data → errorIso         │
   │ client/  │              │ ISR cache → render     │
   │ server/  │              └───────────┬───────────┘
   └──────────┘                          ▼
                              ┌────────────────────┐
                              │   @nami/core        │
                              │ RendererFactory     │
                              │ CSR│SSR│SSG│ISR│    │
                              │ StreamingSSR        │
                              └────────┬───────────┘
                                       │
                              ┌────────┴───────────┐
                              │   DegradationMgr   │
                              │ L0→L1→L2→L3→L4→L5  │
                              └────────────────────┘
```

---

## Core Concepts at a Glance

### Rendering Modes

| Mode | Full Name | Where Rendering Happens | Suitable Scenarios |
|------|------|-----------|---------|
| **CSR** | Client-Side Rendering | Browser | Admin dashboards, internal tools |
| **SSR** | Server-Side Rendering | Server on every request | Requires SEO + real-time data |
| **SSG** | Static Site Generation | Build time | Blogs, documentation, marketing pages |
| **ISR** | Incremental Static Regeneration | Build time + background incremental updates | E-commerce product pages, news |
| **Streaming SSR** | Streaming Server-Side Rendering | Streamed on the server for every request | Large pages, Suspense |

### Package Structure

| Package | Responsibility |
|----|------|
| `@nami/shared` | Type definitions, constants, utility functions (zero dependencies) |
| `@nami/core` | Renderers, routing, plugin management, configuration, error handling |
| `@nami/server` | Koa server, middleware pipeline, ISR, cluster |
| `@nami/client` | Client entry, Hydration, routing, data reading |
| `@nami/webpack` | Webpack build configuration, Loader, Plugin |
| `@nami/cli` | Command-line tool (dev / build / start / generate / analyze / info) |
| `create-nami-app` | Project scaffold |
| `plugin-*` | Official plugins (cache / monitor / request / skeleton / error-boundary) |

### Plugin Lifecycle

```
Build Phase              Server Phase              Client Phase
────────                 ────────                  ────────
modifyRoutes      →      onServerStart      →      onClientInit
modifyWebpackConfig      onRequest                 wrapApp
onBuildStart             onBeforeRender            onHydrated
onBuildEnd               onAfterRender             onRouteChange
                         onRenderError

                    Common: onError / onDispose
```

---

## Recommended Learning Paths

### Path 1: Business Developer (1-2 Days)

1. [Quick Start](./quick-start.md) — Create a project, write configuration, start development
2. [Five Rendering Modes](./rendering-modes.md) — Understand differences between modes and choose the right mode for each page
3. [Routing System](./routing.md) — Route configuration, data prefetching, lazy loading
4. [Error Handling and Degradation](./error-and-degradation.md) — Understand the framework's fault-tolerance guarantees

### Path 2: Framework Developer / Plugin Author (3-5 Days)

1. Complete Path 1 first
2. [Architecture Design](./architecture.md) — Understand the overall architecture and data flow
3. [Plugin System](./plugin-system.md) — Master the hook mechanism and write custom plugins
4. [Server and Middleware](./server-and-middleware.md) — Understand the Koa middleware pipeline
5. [Build System](./webpack-build.md) — Understand the build process and outputs

### Path 3: Ops / SRE (1-2 Days)

1. [Quick Start](./quick-start.md) — Understand deployment commands
2. [Server and Middleware](./server-and-middleware.md) — Cluster, graceful shutdown, health checks, K8s/PM2 deployment
3. [ISR and Caching](./isr-and-caching.md) — Cache strategy, Redis configuration, on-demand invalidation

---

## FAQ

### Q: Which rendering mode should my page use?

Ask yourself three questions:
1. **Do you need SEO?** No → CSR
2. **Does the data need to be fresh on every request?** Yes → SSR; no → continue
3. **How often does the data update?** Almost never → SSG; minutes/hours → ISR

See [Five Rendering Modes · Selection Decision Tree](./rendering-modes.md)

### Q: Can ISR and SSR be mixed?

Yes. Nami supports setting the rendering mode **at route granularity**. In the same project, it is perfectly fine to use SSR for the home page, ISR for product detail pages, SSG for the about page, and CSR for admin pages.

### Q: Will a plugin error cause page rendering to fail?

No. Plugin hook execution is wrapped in try/catch. A single plugin failure only writes a warn log and does not interrupt the rendering process. See [Plugin System · Error Isolation](./plugin-system.md)
