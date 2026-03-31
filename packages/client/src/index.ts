/**
 * @nami/client - 包总入口
 *
 * Nami 框架客户端运行时包，提供完整的浏览器端能力：
 *
 * - Hydration 层：SSR Hydration、选择性 Hydration、不匹配检测
 * - Router 层：客户端路由、链接预取、路由 Hook
 * - Data 层：服务端数据读取、客户端数据请求
 * - Head 层：document.head 动态管理（CSR 直接操作 + SSR 收集输出）
 * - Error 层：错误边界、开发模式错误浮层
 * - Performance 层：Web Vitals 采集（LCP/FID/CLS/FCP/TTFB/INP）、性能标记
 * - App：应用根组件
 * - Entry：客户端初始化入口（含 Service Worker 注册）
 *
 * 使用方式：
 * ```typescript
 * import { initNamiClient, useRouter, useNamiData } from '@nami/client';
 * ```
 */

// ==================== 入口函数 ====================

export { initNamiClient } from './entry-client';
export type { InitClientOptions } from './entry-client';

// ==================== 应用组件 ====================

export { NamiApp } from './app';
export type { NamiAppProps } from './app';

// ==================== Hydration 层 ====================

export {
  hydrateApp,
  renderApp,
  SelectiveHydration,
  HydrationPriority,
  detectMismatch,
  reportMismatch,
  createMismatchError,
  MismatchType,
} from './hydration';
export type {
  HydrateOptions,
  SelectiveHydrationProps,
  MismatchDetail,
  MismatchReportOptions,
} from './hydration';

// ==================== Router 层 ====================

export {
  NamiRouter,
  NamiLink,
  useRouter,
  prefetchRoute,
  getPrefetchedData,
  clearPrefetchCache,
} from './router';
export type {
  NamiRouterProps,
  ComponentResolver,
  NamiLinkProps,
  NamiRouterState,
  NavigateOptions,
  PrefetchOptions,
} from './router';

// ==================== Data 层 ====================

export {
  useNamiData,
  useClientFetch,
  readServerData,
  cleanupServerData,
  resetDataHydrator,
} from './data';
export type {
  ClientFetchOptions,
  ClientFetchResult,
  ServerInjectedData,
} from './data';

// ==================== Head 层 ====================

export {
  NamiHead,
  HeadManagerContext,
  createSSRHeadManager,
  renderHeadToString,
} from './head';
export type {
  NamiHeadProps,
  MetaTag,
  LinkTag,
  ScriptTag,
  CollectedHeadTags,
  HeadManagerContextValue,
} from './head';

// ==================== Error 层 ====================

export { ClientErrorBoundary, ErrorOverlay } from './error';
export type {
  ClientErrorBoundaryProps,
  FallbackRenderProps,
  ErrorOverlayProps,
} from './error';

// ==================== Performance 层 ====================

export {
  collectWebVitals,
  markNamiEvent,
  measureBetween,
  getTimeline,
  clearNamiMarks,
} from './performance';
export type {
  WebVitalName,
  WebVitalMetric,
  WebVitalCallback,
  WebVitalsOptions,
  NamiPerformanceMark,
  NamiPerformanceMeasure,
} from './performance';
