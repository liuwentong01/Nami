/**
 * @nami/core - 路由管理器
 *
 * RouteManager 是路由系统的上层管理类，负责：
 * - 管理路由注册表（增删查）
 * - URL 到路由的匹配
 * - 路由参数提取
 *
 * 它使用 RouteMatcher 作为底层匹配引擎，
 * 在此基础上提供路由注册、批量管理等能力。
 *
 * 匹配优先级：
 * 1. 精确匹配的静态路由优先
 * 2. 动态参数路由按注册顺序匹配
 * 3. 通配符路由最后匹配
 */

import type { NamiRoute, RouteMatchResult } from '@nami/shared';
import { createLogger } from '@nami/shared';
import { RouteMatcher } from './route-matcher';

/** 路由管理器日志 */
const logger = createLogger('@nami/core:route-manager');

/**
 * 路由管理器
 *
 * @example
 * ```typescript
 * const manager = new RouteManager([
 *   { path: '/', component: './pages/home', renderMode: 'ssr' },
 *   { path: '/user/:id', component: './pages/user', renderMode: 'ssr' },
 *   { path: '/about', component: './pages/about', renderMode: 'ssg' },
 * ]);
 *
 * // 匹配路由
 * const result = manager.match('/user/123');
 * // { route: { path: '/user/:id', ... }, params: { id: '123' }, isExact: true }
 *
 * // 动态注册
 * manager.register({ path: '/new-page', component: './pages/new', renderMode: 'csr' });
 *
 * // 获取所有路由
 * const allRoutes = manager.getRoutes();
 * ```
 */
export class RouteManager {
  /** 路由注册表 */
  private routes: NamiRoute[] = [];

  /** 底层路由匹配器 */
  private readonly matcher: RouteMatcher;

  /**
   * 构造函数
   *
   * @param routes - 初始路由配置列表
   */
  constructor(routes: NamiRoute[] = []) {
    this.matcher = new RouteMatcher();
    this.routes = [...routes];

    logger.info('路由管理器初始化完成', {
      routeCount: this.routes.length,
    });
  }

  /**
   * 匹配 URL 路径到路由
   *
   * 遍历所有注册的路由，按注册顺序进行匹配。
   * 第一个匹配成功的路由将被返回。
   *
   * 匹配流程：
   * 1. 提取路径（去除查询参数和哈希）
   * 2. 遍历路由列表，尝试逐个匹配
   * 3. 返回第一个匹配的路由及其提取的参数
   *
   * @param path - 请求路径（如 /user/123?tab=profile）
   * @returns 匹配结果，未匹配返回 null
   */
  match(path: string): RouteMatchResult | null {
    // 提取纯路径（去除查询参数和哈希）
    const cleanPath = this.extractPathname(path);

    logger.debug('开始路由匹配', { path: cleanPath });

    // 遍历路由列表进行匹配
    for (const route of this.routes) {
      const exact = route.exact !== false; // 默认精确匹配
      const result = this.matcher.match(route.path, cleanPath, exact);

      if (result.matched) {
        logger.debug('路由匹配成功', {
          pattern: route.path,
          path: cleanPath,
          params: result.params,
        });

        return {
          route,
          params: result.params,
          isExact: exact,
        };
      }
    }

    // 尝试匹配子路由（嵌套路由）
    for (const route of this.routes) {
      if (route.children && route.children.length > 0) {
        const childResult = this.matchChildren(route.children, cleanPath);
        if (childResult) {
          return childResult;
        }
      }
    }

    logger.debug('路由未匹配', { path: cleanPath });
    return null;
  }

  /**
   * 注册单个路由
   *
   * 将新路由追加到路由列表末尾。
   * 注意：路由匹配是按注册顺序进行的，后注册的路由优先级较低。
   *
   * @param route - 要注册的路由配置
   */
  register(route: NamiRoute): void {
    // 检查路径是否已存在
    const existing = this.routes.find((r) => r.path === route.path);
    if (existing) {
      logger.warn('路由路径已存在，将覆盖', { path: route.path });
      // 覆盖已有路由
      const index = this.routes.indexOf(existing);
      this.routes[index] = route;
    } else {
      this.routes.push(route);
    }

    logger.debug('注册路由', {
      path: route.path,
      renderMode: route.renderMode,
    });
  }

  /**
   * 批量注册路由
   *
   * @param routes - 要注册的路由配置列表
   */
  registerAll(routes: NamiRoute[]): void {
    for (const route of routes) {
      this.register(route);
    }
  }

  /**
   * 移除路由
   *
   * @param path - 要移除的路由路径
   * @returns 是否成功移除
   */
  remove(path: string): boolean {
    const index = this.routes.findIndex((r) => r.path === path);
    if (index === -1) {
      logger.warn('要移除的路由不存在', { path });
      return false;
    }

    this.routes.splice(index, 1);
    logger.debug('路由已移除', { path });
    return true;
  }

  /**
   * 获取所有注册的路由
   *
   * 返回路由列表的副本，防止外部直接修改内部状态。
   *
   * @returns 路由配置列表的副本
   */
  getRoutes(): NamiRoute[] {
    return [...this.routes];
  }

  /**
   * 根据路径获取路由配置
   *
   * 精确匹配路由路径（不是 URL 匹配，而是配置路径匹配）。
   *
   * @param path - 路由配置路径（如 /user/:id）
   * @returns 路由配置，未找到返回 undefined
   */
  getRoute(path: string): NamiRoute | undefined {
    return this.routes.find((r) => r.path === path);
  }

  /**
   * 获取路由数量
   */
  get size(): number {
    return this.routes.length;
  }

  /**
   * 匹配嵌套子路由
   *
   * 递归匹配子路由列表。
   *
   * @param children - 子路由列表
   * @param path - 请求路径
   * @returns 匹配结果或 null
   */
  private matchChildren(
    children: NamiRoute[],
    path: string,
  ): RouteMatchResult | null {
    for (const child of children) {
      const exact = child.exact !== false;
      const result = this.matcher.match(child.path, path, exact);

      if (result.matched) {
        return {
          route: child,
          params: result.params,
          isExact: exact,
        };
      }

      // 递归匹配更深层的子路由
      if (child.children && child.children.length > 0) {
        const deepResult = this.matchChildren(child.children, path);
        if (deepResult) {
          return deepResult;
        }
      }
    }

    return null;
  }

  /**
   * 从 URL 中提取纯路径
   *
   * 去除查询参数（?）和哈希（#）部分。
   *
   * @param url - 可能包含查询参数的 URL
   * @returns 纯路径部分
   *
   * @example
   * '/user/123?tab=profile#section' → '/user/123'
   */
  private extractPathname(url: string): string {
    // 去除哈希
    let path = url.split('#')[0] ?? url;
    // 去除查询参数
    path = path.split('?')[0] ?? path;
    // 确保路径以 / 开头
    if (!path.startsWith('/')) {
      path = `/${path}`;
    }
    return path;
  }
}
