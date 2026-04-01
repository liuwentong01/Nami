/**
 * @nami/server - 中间件层导出入口
 *
 * 统一导出所有 Koa 中间件，提供完整的 HTTP 请求处理管线。
 *
 * 中间件注册顺序（由外到内）：
 * 1. timing           - 请求计时（记录响应耗时）
 * 2. security         - 安全响应头（XSS、CSRF、CSP 防护）
 * 3. requestContext    - 请求上下文（requestId、logger）
 * 4. healthCheck      - 健康检查（短路 /_health）
 * 5. staticServe      - 静态资源（JS/CSS/图片）
 * 6. [plugin]         - 插件注册的自定义中间件
 * 7. errorIsolation   - 错误隔离（防止渲染错误崩溃进程）
 * 8. isrCache         - ISR 缓存层（stale-while-revalidate）
 * 9. render           - 核心渲染（SSR/CSR/SSG/ISR）
 */

// ===== 请求计时 =====
export { timingMiddleware } from './timing';

// ===== 安全响应头 =====
export { securityMiddleware } from './security';
export type { SecurityOptions } from './security';

// ===== 请求上下文 =====
export { requestContextMiddleware } from './request-context';
export type { RequestContextOptions } from './request-context';

// ===== 健康检查 =====
export { healthCheckMiddleware } from './health-check';
export type { HealthCheckOptions } from './health-check';

// ===== 静态资源服务 =====
export { staticServeMiddleware } from './static-serve';
export type { StaticServeOptions } from './static-serve';

// ===== 路由数据预取 =====
export { dataPrefetchMiddleware } from './data-prefetch-middleware';
export type { DataPrefetchMiddlewareOptions } from './data-prefetch-middleware';

// ===== 错误隔离 =====
export { errorIsolationMiddleware } from './error-isolation';
export type { ErrorIsolationOptions } from './error-isolation';

// ===== 核心渲染 =====
export { renderMiddleware } from './render-middleware';
export type { RenderMiddlewareOptions } from './render-middleware';

// ===== ISR 缓存 =====
export { isrCacheMiddleware } from './isr-cache-middleware';
export type { ISRCacheMiddlewareOptions } from './isr-cache-middleware';

// ===== 优雅停机 =====
export {
  setupGracefulShutdown,
  createShutdownAwareMiddleware,
} from './graceful-shutdown';
export type { GracefulShutdownOptions } from './graceful-shutdown';
