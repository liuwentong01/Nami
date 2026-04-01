/**
 * @nami/core - 路由层导出入口
 *
 * 路由层负责 URL 到组件的映射和路由匹配。
 *
 * 核心模块：
 * - RouteManager: 路由注册表管理（注册、匹配、查询）
 * - RouteMatcher: 底层路径模式匹配引擎（动态参数、通配符）
 * - PathMatcher: 生产级路径匹配器（优先级评分、更多模式语法）
 * - lazyRoute: 路由级代码分割（React.lazy + Suspense 封装）
 */

// 路由管理器
export { RouteManager } from './route-manager';

// 路由匹配器
export { RouteMatcher } from './route-matcher';
export type { MatchResult, MatchResultWithScore } from './route-matcher';

// 路径匹配器（生产级，支持优先级评分和路由排序）
export {
  compilePath,
  matchPath,
  rankRoutes,
  getPatternScore,
  clearPathMatcherCache,
} from './path-matcher';
export type {
  PathMatchResult,
  CompileOptions,
  CompiledMatcher,
  RankableRoute,
} from './path-matcher';

// 懒加载路由
export { lazyRoute } from './lazy-route';
export type { LazyRouteOptions, LazyRouteComponent } from './lazy-route';
