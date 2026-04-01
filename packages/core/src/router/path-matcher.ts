/**
 * @nami/core - 生产级路径匹配器
 *
 * 实现 path-to-regexp 风格的路径匹配，无外部依赖。
 *
 * 支持的路由模式：
 * 1. 静态路径：/about、/user/profile
 * 2. 必选参数：/user/:id
 * 3. 可选参数：/user/:id?
 * 4. 带约束参数：/user/:id(\d+)
 * 5. 多值参数：/docs/:path+
 * 6. 通配符（catch-all）：/docs/*
 * 7. 正则分组：/file/(.*)
 *
 * 优先级评分算法：
 * - 每个静态段得 3 分
 * - 每个带约束的动态参数得 2 分
 * - 每个普通动态参数得 1 分
 * - 通配符得 0 分
 * - 精确匹配（无通配符）得额外 1 分
 *
 * 得分相同时，先定义的路由优先。
 */

import { createLogger } from '@nami/shared';

const logger = createLogger('@nami/core:path-matcher');

// ============================================================
// 类型定义
// ============================================================

/**
 * 路径匹配结果
 */
export interface PathMatchResult {
  /** 是否匹配成功 */
  matched: boolean;
  /** 解析出的路由参数 */
  params: Record<string, string>;
  /** 路由优先级得分 */
  score: number;
}

/**
 * 编译选项
 */
export interface CompileOptions {
  /** 是否精确匹配（默认 true） */
  exact?: boolean;
  /** 是否大小写敏感（默认 false，即不敏感） */
  sensitive?: boolean;
}

/**
 * 编译后的匹配函数
 * 传入路径，返回匹配结果或 null
 */
export type CompiledMatcher = (pathname: string) => PathMatchResult | null;

/**
 * 可排序的路由接口
 * 只要求有 path 字段，兼容 NamiRoute 等类型
 */
export interface RankableRoute {
  path: string;
  exact?: boolean;
  [key: string]: unknown;
}

// ============================================================
// 内部类型
// ============================================================

/** 编译后的路由规则 */
interface CompiledRule {
  /** 原始路由模式 */
  pattern: string;
  /** 匹配正则 */
  regexp: RegExp;
  /** 参数名列表 */
  paramNames: string[];
  /** 优先级得分 */
  score: number;
}

// ============================================================
// 编译缓存
// ============================================================

/** 编译缓存，避免重复编译相同模式 */
const ruleCache = new Map<string, CompiledRule>();

/** 缓存上限，防止内存泄漏 */
const MAX_CACHE_SIZE = 1024;

// ============================================================
// 内部工具函数
// ============================================================

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 标准化路径：确保以 / 开头，移除查询字符串和哈希
 */
function normalizePath(pathname: string): string {
  if (!pathname.startsWith('/')) {
    pathname = '/' + pathname;
  }
  const hashIndex = pathname.indexOf('#');
  if (hashIndex >= 0) {
    pathname = pathname.slice(0, hashIndex);
  }
  const queryIndex = pathname.indexOf('?');
  if (queryIndex >= 0) {
    pathname = pathname.slice(0, queryIndex);
  }
  return pathname;
}

/**
 * 编译路由模式为正则表达式和元信息
 *
 * 编译规则：
 * - :param → 匹配单个路径段
 * - :param? → 可选参数（整个段含 / 都可选）
 * - :param(\d+) → 带正则约束的参数
 * - :path+ → 多值参数（匹配一个或多个路径段）
 * - * → 通配符，匹配所有剩余路径
 * - (.*) → 正则分组
 * - 其他 → 静态段，字面匹配
 */
function compilePattern(
  pattern: string,
  options: CompileOptions = {},
): CompiledRule {
  const { exact = true, sensitive = false } = options;
  const cacheKey = `${pattern}|exact=${exact}|sensitive=${sensitive}`;

  // 查缓存
  const cached = ruleCache.get(cacheKey);
  if (cached) return cached;

  const paramNames: string[] = [];
  let score = 0;
  let regexpStr = '';

  const segments = pattern.split('/').filter(Boolean);

  for (const segment of segments) {
    regexpStr += '\\/';

    if (segment === '*') {
      // 通配符：匹配所有剩余路径
      paramNames.push('*');
      regexpStr += '(.+)';
      // 通配符得 0 分
    } else if (segment.match(/^\((.+)\)$/)) {
      // 正则分组：/file/(.*)
      const inner = segment.slice(1, -1);
      paramNames.push(`$${paramNames.length}`);
      regexpStr += `(${inner})`;
      // 正则分组得 0 分
    } else if (segment.startsWith(':')) {
      // 动态参数段
      let paramPart = segment.slice(1);
      const isOptional = paramPart.endsWith('?');
      if (isOptional) {
        paramPart = paramPart.slice(0, -1);
      }

      // 检查是否有正则约束: :id(\d+)
      const constraintMatch = paramPart.match(/^(\w+)\((.+)\)$/);
      let paramName: string;
      let paramRegex: string;

      if (constraintMatch) {
        paramName = constraintMatch[1]!;
        paramRegex = constraintMatch[2]!;
        score += 2; // 带约束参数得 2 分
      } else if (paramPart.endsWith('+')) {
        // 多值通配符: :path+
        paramName = paramPart.slice(0, -1);
        paramRegex = '.+';
        score += 0; // 多值参数等同通配符
      } else {
        paramName = paramPart;
        paramRegex = '[^/]+';
        score += 1; // 普通参数得 1 分
      }

      paramNames.push(paramName);

      if (isOptional) {
        // 可选参数：整个段（含 /）都是可选的
        regexpStr = regexpStr.slice(0, -2); // 去掉刚添加的 \/
        regexpStr += `(?:\\/(${paramRegex}))?`;
      } else {
        regexpStr += `(${paramRegex})`;
      }
    } else {
      // 静态段：字面匹配
      regexpStr += escapeRegExp(segment);
      score += 3; // 静态段得 3 分
    }
  }

  // 精确匹配（无通配符）加 1 分
  if (!pattern.includes('*')) {
    score += 1;
  }

  // 构建完整正则
  const flags = sensitive ? '' : 'i';
  const regexp = exact
    ? new RegExp(`^${regexpStr}\\/?$`, flags) // 精确匹配（允许尾部可选 /）
    : new RegExp(`^${regexpStr}`, flags);       // 前缀匹配

  const rule: CompiledRule = { pattern, regexp, paramNames, score };

  // 写入缓存（达到上限时清除旧缓存的一半）
  if (ruleCache.size >= MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(ruleCache.keys()).slice(
      0,
      Math.floor(MAX_CACHE_SIZE / 2),
    );
    for (const key of keysToDelete) {
      ruleCache.delete(key);
    }
    logger.debug('路径匹配器编译缓存已清理', {
      removedCount: keysToDelete.length,
    });
  }
  ruleCache.set(cacheKey, rule);

  return rule;
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 编译路径模式为匹配函数
 *
 * 将路由模式字符串编译为高性能匹配函数。
 * 编译结果会被缓存，重复调用同一模式不会重复编译。
 *
 * @param pattern - 路由模式（如 /user/:id、/docs/*）
 * @param options - 编译选项
 * @returns 匹配函数，传入路径返回匹配结果或 null
 *
 * @example
 * ```typescript
 * const match = compilePath('/user/:id');
 *
 * match('/user/123');
 * // { matched: true, params: { id: '123' }, score: 4 }
 *
 * match('/post/456');
 * // null
 * ```
 */
export function compilePath(
  pattern: string,
  options?: CompileOptions,
): CompiledMatcher {
  const rule = compilePattern(pattern, options);

  return (pathname: string): PathMatchResult | null => {
    if (!pathname) {
      return null;
    }

    const normalized = normalizePath(pathname);
    const match = rule.regexp.exec(normalized);

    if (!match) {
      return null;
    }

    // 提取参数
    const params: Record<string, string> = {};
    for (let i = 0; i < rule.paramNames.length; i++) {
      const value = match[i + 1];
      if (value !== undefined) {
        params[rule.paramNames[i]!] = decodeURIComponent(value);
      }
    }

    return {
      matched: true,
      params,
      score: rule.score,
    };
  };
}

/**
 * 匹配路径
 *
 * 将路径模式与实际路径进行匹配的快捷方法。
 * 内部会编译模式（带缓存），适用于不需要复用编译结果的场景。
 *
 * @param pattern - 路由模式
 * @param pathname - 实际请求路径
 * @param options - 编译选项
 * @returns 匹配结果，未匹配返回 null
 *
 * @example
 * ```typescript
 * matchPath('/user/:id', '/user/123');
 * // { matched: true, params: { id: '123' }, score: 4 }
 *
 * matchPath('/user/:id', '/post/123');
 * // null
 *
 * matchPath('/user/:id?', '/user');
 * // { matched: true, params: {}, score: 1 }
 * ```
 */
export function matchPath(
  pattern: string,
  pathname: string,
  options?: CompileOptions,
): PathMatchResult | null {
  const matcher = compilePath(pattern, options);
  return matcher(pathname);
}

/**
 * 按优先级排序路由列表
 *
 * 使用路由模式的特异性（specificity）对路由列表进行排序。
 * 更具体的路由排在前面，确保匹配时最精确的路由优先命中。
 *
 * 排序规则（按优先级从高到低）：
 * 1. 优先级分数更高的路由优先
 * 2. 分数相同时，段数更多的路由优先
 * 3. 都相同时，保持原始顺序（稳定排序）
 *
 * @param routes - 路由列表
 * @returns 排序后的路由列表（新数组，不修改原数组）
 *
 * @example
 * ```typescript
 * const routes = [
 *   { path: '/user/*' },
 *   { path: '/user/:id' },
 *   { path: '/user/profile' },
 * ];
 *
 * const sorted = rankRoutes(routes);
 * // [
 * //   { path: '/user/profile' },   // 分数最高（静态 + 静态 + 精确匹配）
 * //   { path: '/user/:id' },       // 分数中等（静态 + 参数 + 精确匹配）
 * //   { path: '/user/*' },         // 分数最低（静态 + 通配符）
 * // ]
 * ```
 */
export function rankRoutes<T extends RankableRoute>(routes: T[]): T[] {
  // 预计算每个路由的分数信息
  const scored = routes.map((route, index) => {
    const rule = compilePattern(route.path, {
      exact: route.exact !== false,
    });
    const segmentCount = route.path.split('/').filter(Boolean).length;

    return {
      route,
      score: rule.score,
      segmentCount,
      originalIndex: index,
    };
  });

  // 按分数降序排序（分数高的优先），分数相同按段数降序，都相同保持原序
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.segmentCount !== a.segmentCount) {
      return b.segmentCount - a.segmentCount;
    }
    return a.originalIndex - b.originalIndex;
  });

  return scored.map((item) => item.route);
}

/**
 * 获取路径模式的优先级分数
 *
 * 用于外部需要自定义排序逻辑的场景。
 *
 * @param pattern - 路由模式
 * @returns 优先级分数
 */
export function getPatternScore(pattern: string): number {
  const rule = compilePattern(pattern);
  return rule.score;
}

/**
 * 清除编译缓存
 *
 * 通常不需要调用此方法，仅在测试或特殊场景下使用。
 */
export function clearPathMatcherCache(): void {
  ruleCache.clear();
  logger.debug('路径匹配器编译缓存已清除');
}
