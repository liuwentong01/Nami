/**
 * @nami/plugin-monitor - 监控插件
 *
 * Nami 框架官方监控插件，提供全方位的运行时监控能力：
 * - 服务端渲染性能指标采集
 * - 错误收集与分类
 * - 渲染状态指标（模式分布、降级率、缓存命中率）
 * - 客户端 Web Vitals 采集
 * - 批量数据上报
 *
 * @example
 * ```typescript
 * import { NamiMonitorPlugin } from '@nami/plugin-monitor';
 *
 * export default {
 *   plugins: [
 *     new NamiMonitorPlugin({
 *       endpoint: 'https://monitor.example.com/api/report',
 *     }),
 *   ],
 * };
 * ```
 *
 * @packageDocumentation
 */

// 导出插件主体
export { NamiMonitorPlugin } from './monitor-plugin';
export type { MonitorPluginOptions } from './monitor-plugin';

// 导出收集器
export { PerformanceCollector } from './collectors/performance';
export type { PerformanceMetrics, PerformanceThresholds } from './collectors/performance';

export { ErrorCollector, ErrorType } from './collectors/error';
export type { ErrorRecord, ErrorSummary, ErrorCollectorOptions } from './collectors/error';

export { RenderMetricsCollector } from './collectors/render-metrics';
export type { RenderMetric, RenderMetricsSummary } from './collectors/render-metrics';

// 导出上报器
export { BeaconReporter } from './reporters/beacon-reporter';
export type { BeaconReporterOptions } from './reporters/beacon-reporter';

export { ConsoleReporter } from './reporters/console-reporter';
export type { ConsoleReporterOptions } from './reporters/console-reporter';
