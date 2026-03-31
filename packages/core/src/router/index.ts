/**
 * @nami/core - 路由层导出入口
 *
 * 路由层负责 URL 到组件的映射和路由匹配。
 *
 * 核心模块：
 * - RouteManager: 路由注册表管理（注册、匹配、查询）
 * - RouteMatcher: 底层路径模式匹配引擎（动态参数、通配符）
 * - lazyRoute: 路由级代码分割（React.lazy + Suspense 封装）
 */

// 路由管理器
export { RouteManager } from './route-manager';

// 路由匹配器
export { RouteMatcher } from './route-matcher';
export type { MatchResult } from './route-matcher';

// 懒加载路由
export { lazyRoute } from './lazy-route';
export type { LazyRouteOptions, LazyRouteComponent } from './lazy-route';
