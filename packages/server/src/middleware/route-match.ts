import type { NamiRoute, RouteMatchResult } from '@nami/shared';
import { matchPath, rankRoutes } from '@nami/core';
import type { RankableRoute } from '@nami/core';

/**
 * 服务端统一路由匹配器
 *
 * `render-middleware` 和 `isr-cache-middleware` 都必须使用同一套路由优先级，
 * 否则会出现“缓存层命中某个路由，但真正渲染层命中另一个路由”的语义分叉。
 *
 * 因此这里抽出一个共享实现，统一采用 `rankRoutes + matchPath`，
 * 让 ISR 判定与真实渲染命中保持一致。
 */
export function matchConfiguredRoute(
  requestPath: string,
  routes: NamiRoute[],
): RouteMatchResult | null {
  return matchRouteList(requestPath, routes);
}

function matchRouteList(
  requestPath: string,
  routes: NamiRoute[],
): RouteMatchResult | null {
  const sortedRoutes = rankRoutes(routes as unknown as RankableRoute[]) as unknown as NamiRoute[];

  for (const route of sortedRoutes) {
    const exact = route.exact !== false;
    const result = matchPath(route.path, requestPath, { exact });

    if (result) {
      return {
        route,
        params: result.params,
        isExact: exact,
      };
    }
  }

  for (const route of sortedRoutes) {
    if (!route.children || route.children.length === 0) {
      continue;
    }

    const childMatch = matchRouteList(requestPath, route.children);
    if (childMatch) {
      return childMatch;
    }
  }

  return null;
}
