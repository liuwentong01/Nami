/**
 * @nami/client - 性能层导出入口
 *
 * 导出性能监控相关的所有公共 API：
 *
 * - collectWebVitals:  Web Vitals 核心指标采集（LCP、FID、CLS、FCP、TTFB、INP）
 * - markNamiEvent:     性能时间标记
 * - measureBetween:    标记间耗时测量
 * - getTimeline:       获取完整性能时间线
 * - clearNamiMarks:    清除所有 Nami 性能标记
 */

// Web Vitals
export { collectWebVitals } from './web-vitals';
export type {
  WebVitalName,
  WebVitalMetric,
  WebVitalCallback,
  WebVitalsOptions,
} from './web-vitals';

// 性能标记
export {
  markNamiEvent,
  measureBetween,
  getTimeline,
  clearNamiMarks,
} from './performance-mark';
export type {
  NamiPerformanceMark,
  NamiPerformanceMeasure,
} from './performance-mark';
