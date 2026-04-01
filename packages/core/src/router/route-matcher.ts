/**
 * @nami/core - 路由匹配器
 *
 * RouteMatcher 提供路径模式匹配能力，是路由系统的底层引擎。
 * 内部委托给 path-matcher 模块实现实际的匹配逻辑。
 *
 * 支持的路由模式：
 * 1. 静态路径：/about、/user/profile
 * 2. 动态参数：/user/:id、/post/:year/:slug
 * 3. 可选参数：/user/:id?
 * 4. 通配符（catch-all）：/docs/*、/api/*
 * 5. 正则分组：/file/(.*)
 * 6. 带约束参数：/user/:id(\d+)
 * 7. 多值参数：/docs/:path+
 *
 * 匹配算法：
 * 将路由模式编译为正则表达式，提取命名参数。
 * 匹配结果包含解析出的参数对象和优先级分数。
 *
 * @example
 * ```
 * /user/:id       → /user/123      → { id: '123' }
 * /post/:year/:slug → /post/2024/hello → { year: '2024', slug: 'hello' }
 * /docs/*         → /docs/a/b/c    → { '*': 'a/b/c' }
 * ```
 */

import { createLogger } from '@nami/shared';
import { matchPath, clearPathMatcherCache } from './path-matcher';
import type { PathMatchResult } from './path-matcher';

/** 路由匹配器日志 */
const logger = createLogger('@nami/core:route-matcher');

/**
 * 路由匹配结果
 */
export interface MatchResult {
  /** 是否匹配成功 */
  matched: boolean;
  /** 解析出的路由参数 */
  params: Record<string, string>;
}

/**
 * 带分数的路由匹配结果
 */
export interface MatchResultWithScore extends MatchResult {
  /** 路由优先级分数（越高越优先） */
  score: number;
}

/**
 * 路由匹配器
 *
 * 提供路径模式匹配的核心能力。
 * 内部委托给 path-matcher 模块，利用其编译缓存和优先级评分机制。
 *
 * @example
 * ```typescript
 * const matcher = new RouteMatcher();
 *
 * // 静态路径匹配
 * matcher.match('/about', '/about');
 * // { matched: true, params: {} }
 *
 * // 动态参数匹配
 * matcher.match('/user/:id', '/user/123');
 * // { matched: true, params: { id: '123' } }
 *
 * // 通配符匹配
 * matcher.match('/docs/*', '/docs/getting-started/install');
 * // { matched: true, params: { '*': 'getting-started/install' } }
 *
 * // 不匹配
 * matcher.match('/user/:id', '/post/123');
 * // { matched: false, params: {} }
 *
 * // 带分数的匹配
 * matcher.matchWithScore('/user/:id', '/user/123');
 * // { matched: true, params: { id: '123' }, score: 4 }
 * ```
 */
export class RouteMatcher {
  /**
   * 匹配路径与模式
   *
   * @param pattern - 路由模式（如 /user/:id）
   * @param path - 实际请求路径（如 /user/123）
   * @param exact - 是否精确匹配，默认 true
   * @returns 匹配结果
   */
  match(pattern: string, path: string, exact: boolean = true): MatchResult {
    // 特殊情况：空模式或空路径
    if (!pattern || !path) {
      return { matched: false, params: {} };
    }

    // 委托给 path-matcher 执行匹配
    const result: PathMatchResult | null = matchPath(pattern, path, { exact });

    if (!result) {
      return { matched: false, params: {} };
    }

    logger.debug('路由匹配成功', { pattern, path, params: result.params });

    return { matched: true, params: result.params };
  }

  /**
   * 匹配路径与模式（带优先级分数）
   *
   * 除了返回基础匹配结果外，还返回路由的优先级分数。
   * 分数越高表示路由越具体，适用于需要按优先级选择最佳匹配的场景。
   *
   * @param pattern - 路由模式（如 /user/:id）
   * @param path - 实际请求路径（如 /user/123）
   * @param exact - 是否精确匹配，默认 true
   * @returns 带分数的匹配结果
   */
  matchWithScore(
    pattern: string,
    path: string,
    exact: boolean = true,
  ): MatchResultWithScore {
    // 特殊情况：空模式或空路径
    if (!pattern || !path) {
      return { matched: false, params: {}, score: 0 };
    }

    // 委托给 path-matcher 执行匹配
    const result: PathMatchResult | null = matchPath(pattern, path, { exact });

    if (!result) {
      return { matched: false, params: {}, score: 0 };
    }

    logger.debug('路由匹配成功（带分数）', {
      pattern,
      path,
      params: result.params,
      score: result.score,
    });

    return {
      matched: true,
      params: result.params,
      score: result.score,
    };
  }

  /**
   * 清除编译缓存
   *
   * 用于测试或动态路由变更场景。
   */
  clearCache(): void {
    clearPathMatcherCache();
  }
}
