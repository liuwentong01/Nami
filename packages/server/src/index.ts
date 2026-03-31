/**
 * @nami/server - 包总入口
 *
 * Nami 框架服务端包，提供基于 Koa 的 SSR 渲染中间层。
 *
 * 核心导出：
 * - createNamiServer: 创建 Koa 应用（含完整中间件管线）
 * - startServer: 启动 HTTP 服务器（含优雅停机、集群模式）
 *
 * 模块架构：
 * ```
 * @nami/server
 * ├── middleware/     — Koa 中间件层（计时、安全、渲染、ISR 缓存等）
 * ├── isr/           — ISR 增量静态再生（缓存存储、重验证队列、SWR 策略）
 * ├── cluster/       — 集群模式（主进程 + 工作进程）
 * └── dev/           — 开发服务器（Webpack dev/hot middleware）
 * ```
 *
 * @example
 * ```typescript
 * // 生产模式
 * import { startServer } from '@nami/server';
 * await startServer(config);
 *
 * // 自定义模式
 * import { createNamiServer } from '@nami/server';
 * const { app } = await createNamiServer(config);
 * app.listen(3000);
 *
 * // 开发模式
 * import { createDevServer } from '@nami/server';
 * const devServer = await createDevServer(devOptions);
 * devServer.listen(3000);
 * ```
 */

// ==================== 主入口 ====================

/** Koa 应用创建器 */
export { createNamiServer } from './app';
export type { NamiServerInstance, CreateServerOptions } from './app';

/** 服务器启动器 */
export { startServer } from './server';
export type { StartServerOptions, StartServerResult } from './server';

// ==================== 中间件层 ====================

export {
  // 请求计时
  timingMiddleware,
  // 安全响应头
  securityMiddleware,
  // 请求上下文
  requestContextMiddleware,
  // 健康检查
  healthCheckMiddleware,
  // 静态资源服务
  staticServeMiddleware,
  // 错误隔离
  errorIsolationMiddleware,
  // 核心渲染
  renderMiddleware,
  // ISR 缓存
  isrCacheMiddleware,
  // 优雅停机
  setupGracefulShutdown,
  createShutdownAwareMiddleware,
} from './middleware';

export type {
  SecurityOptions,
  RequestContextOptions,
  HealthCheckOptions,
  StaticServeOptions,
  ErrorIsolationOptions,
  RenderMiddlewareOptions,
  ISRCacheMiddlewareOptions,
  GracefulShutdownOptions,
} from './middleware';

// ==================== ISR 层 ====================

export {
  // 缓存存储工厂
  createCacheStore,
  // 缓存后端实现
  MemoryStore,
  FilesystemStore,
  RedisStore,
  // 重验证队列
  RevalidationQueue,
  // SWR 策略
  SWRState,
  evaluateCacheFreshness,
  isCacheUsable,
  needsRevalidation,
  // ISR 管理器
  ISRManager,
} from './isr';

export type {
  CreateCacheStoreOptions,
  CacheStore,
  CacheEntry,
  CacheStats,
  CacheOptions,
  MemoryStoreOptions,
  FilesystemStoreOptions,
  RedisStoreOptions,
  RevalidationQueueOptions,
  SWREvaluation,
  SWROptions,
  ISRManagerOptions,
} from './isr';

// ==================== 集群模式 ====================

export {
  startMaster,
  startWorker,
} from './cluster';

export type {
  MasterOptions,
  WorkerOptions,
} from './cluster';

// ==================== 开发服务器 ====================

export {
  createDevServer,
  createHMRMiddleware,
  createWebpackDevMiddleware,
  getDevMiddlewareFileSystem,
} from './dev';

export type {
  DevServerOptions,
  DevServer,
  HMRMiddlewareOptions,
  WebpackDevMiddlewareOptions,
} from './dev';
