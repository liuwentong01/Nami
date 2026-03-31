/**
 * @nami/plugin-error-boundary - 错误边界插件
 *
 * Nami 框架官方错误边界插件，提供：
 * - 全局 React 错误边界（wrapApp）
 * - 路由级错误边界组件
 * - 可配置的重试策略
 * - 渐进式降级策略（SSR → CSR → 骨架屏 → 静态页 → 503）
 *
 * @example
 * ```typescript
 * import { NamiErrorBoundaryPlugin } from '@nami/plugin-error-boundary';
 *
 * export default {
 *   plugins: [
 *     new NamiErrorBoundaryPlugin({
 *       retry: { maxRetries: 2 },
 *       onError: (error) => monitor.captureException(error),
 *     }),
 *   ],
 * };
 * ```
 *
 * @packageDocumentation
 */

// 导出插件主体
export { NamiErrorBoundaryPlugin } from './error-boundary-plugin';
export type { ErrorBoundaryPluginOptions } from './error-boundary-plugin';

// 导出组件
export { ErrorFallback } from './components/error-fallback';
export type { ErrorFallbackProps } from './components/error-fallback';

export { RouteErrorBoundary } from './components/route-error-boundary';
export type { RouteErrorBoundaryProps } from './components/route-error-boundary';

// 导出策略
export { RetryStrategy } from './strategies/retry-strategy';
export type { RetryStrategyOptions, RetryResult } from './strategies/retry-strategy';

export { DegradeStrategy } from './strategies/degrade-strategy';
export type { DegradeStrategyOptions, DegradeResult } from './strategies/degrade-strategy';
