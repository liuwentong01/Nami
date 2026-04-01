/**
 * @nami/core - 路由匹配器
 *
 * RouteMatcher 提供路径模式匹配能力，是路由系统的底层引擎。
 *
 * 支持的路由模式：
 * 1. 静态路径：/about、/user/profile
 * 2. 动态参数：/user/:id、/post/:year/:slug
 * 3. 可选参数：/user/:id?
 * 4. 通配符（catch-all）：/docs/*、/api/*
 *
 * 匹配算法：
 * 将路由模式编译为正则表达式，提取命名参数。
 * 匹配结果包含解析出的参数对象。
 *
 * @example
 * ```
 * /user/:id       → /user/123      → { id: '123' }
 * /post/:year/:slug → /post/2024/hello → { year: '2024', slug: 'hello' }
 * /docs/*         → /docs/a/b/c    → { '*': 'a/b/c' }
 * ```
 */

import { createLogger } from '@nami/shared';

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
 * 编译后的路由模式
 */
interface CompiledPattern {
  /** 匹配用的正则表达式 */
  regexp: RegExp;
  /** 参数名称列表（按出现顺序） */
  paramNames: string[];
}

/** 编译缓存：避免重复编译相同的路由模式 */
const patternCache = new Map<string, CompiledPattern>();

/**
 * 路由匹配器
 *
 * 提供路径模式匹配的核心能力。
 * 路由模式被编译为正则表达式并缓存，后续匹配直接使用缓存。
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

    // 编译路由模式（带缓存）
    const compiled = this.compile(pattern, exact);

    // 执行正则匹配
    const match = compiled.regexp.exec(path);

    if (!match) {
      return { matched: false, params: {} };
    }

    // 提取命名参数
    const params: Record<string, string> = {};
    compiled.paramNames.forEach((name, index) => {
      const value = match[index + 1];
      if (value !== undefined) {
        // URL 解码参数值
        params[name] = decodeURIComponent(value);
      }
    });

    logger.debug('路由匹配成功', { pattern, path, params });

    return { matched: true, params };
  }

  /**
   * 编译路由模式为正则表达式
   *
   * 编译规则：
   * - :param → 匹配单个路径段（不含 /）
   * - :param? → 可选参数
   * - * → 匹配任意路径（含 /）
   * - 其他字符 → 字面匹配
   *
   * @param pattern - 路由模式
   * @param exact - 是否精确匹配
   * @returns 编译后的模式对象
   */
  private compile(pattern: string, exact: boolean): CompiledPattern {
    const cacheKey = `${pattern}:${exact ? '1' : '0'}`;

    // 查缓存
    const cached = patternCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const paramNames: string[] = [];
    let regexpStr = '';

    // 按 / 分割路由模式的各段
    const segments = pattern.split('/').filter(Boolean);

    for (const segment of segments) {
      regexpStr += '\\/';

      if (segment === '*') {
        // 通配符：匹配剩余的所有路径
        paramNames.push('*');
        regexpStr += '(.+)';
      } else if (segment.startsWith(':')) {
        // 动态参数
        const isOptional = segment.endsWith('?');
        const paramName = isOptional
          ? segment.slice(1, -1)
          : segment.slice(1);

        paramNames.push(paramName);

        if (isOptional) {
          // 可选参数：整个段（含前面的 /）都是可选的
          // 需要回溯修正前面添加的 \/
          regexpStr = regexpStr.slice(0, -2); // 去掉刚添加的 \/
          regexpStr += '(?:\\/([^/]+))?';
        } else {
          // 必选参数：匹配一个路径段
          regexpStr += '([^/]+)';
        }
      } else {
        // 静态段：字面匹配（转义正则特殊字符）
        regexpStr += this.escapeRegExp(segment);
      }
    }

    // 构建完整正则
    const flags = 'i'; // 不区分大小写
    const fullRegexp = exact
      ? new RegExp(`^${regexpStr}\\/?$`, flags) // 精确匹配（允许尾部可选的 /）
      : new RegExp(`^${regexpStr}`, flags);       // 前缀匹配

    const compiled: CompiledPattern = {
      regexp: fullRegexp,
      paramNames,
    };

    // 写入缓存
    patternCache.set(cacheKey, compiled);

    return compiled;
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 清除编译缓存
   *
   * 用于测试或动态路由变更场景。
   */
  clearCache(): void {
    patternCache.clear();
  }
}
