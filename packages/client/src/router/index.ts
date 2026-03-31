/**
 * @nami/client - 路由层导出入口
 *
 * 导出路由相关的所有公共 API：
 *
 * - NamiRouter: 路由根组件
 * - NamiLink:   增强链接组件（支持预取）
 * - useRouter:  路由状态 Hook
 * - prefetchRoute / getPrefetchedData: 路由预取工具
 */

// 路由组件
export { NamiRouter } from './nami-router';
export type { NamiRouterProps, ComponentResolver } from './nami-router';

// 链接组件
export { NamiLink } from './link';
export type { NamiLinkProps } from './link';

// 路由 Hook
export { useRouter } from './use-router';
export type { NamiRouterState, NavigateOptions } from './use-router';

// 路由预取
export { prefetchRoute, getPrefetchedData, clearPrefetchCache } from './route-prefetch';
export type { PrefetchOptions } from './route-prefetch';
