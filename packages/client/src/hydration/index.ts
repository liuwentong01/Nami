/**
 * @nami/client - Hydration 层导出入口
 *
 * 导出 Hydration 相关的所有公共 API：
 *
 * - hydrateApp / renderApp: 应用挂载入口
 * - SelectiveHydration: 选择性 Hydration 组件
 * - detectMismatch / reportMismatch: Hydration 不匹配检测与上报
 */

// 主 Hydration 逻辑
export { hydrateApp, renderApp } from './hydrate';
export type { HydrateOptions } from './hydrate';

// 选择性 Hydration
export { SelectiveHydration, HydrationPriority } from './selective-hydration';
export type { SelectiveHydrationProps } from './selective-hydration';

// Hydration 不匹配检测
export {
  detectMismatch,
  reportMismatch,
  createMismatchError,
  MismatchType,
} from './hydration-mismatch';
export type { MismatchDetail, MismatchReportOptions } from './hydration-mismatch';
