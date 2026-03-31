/**
 * @nami/plugin-request - 缓存拦截器
 *
 * 拦截 GET 请求的响应并缓存，
 * 下次相同请求直接返回缓存结果，避免重复的网络请求。
 *
 * 缓存策略：
 * - 仅缓存 GET 请求（GET 是幂等的，缓存安全）
 * - 不缓存 POST/PUT/DELETE 等写操作
 * - 支持 TTL（缓存过期时间）
 * - 支持手动失效
 * - 缓存键默认为 URL + 查询参数的组合
 *
 * 缓存位置：内存（Map）
 * 适用于同一页面生命周期内的重复请求去重。
 */

import type { RequestOptions, RequestResponse, RequestAdapter } from '../adapters/server-adapter';

/**
 * 缓存条目
 */
interface CacheItem<T = unknown> {
  /** 缓存的响应数据 */
  response: RequestResponse<T>;
  /** 过期时间戳 */
  expiresAt: number;
  /** 缓存创建时间 */
  createdAt: number;
}

/**
 * 缓存拦截器配置
 */
export interface CacheInterceptorOptions {
  /**
   * 默认缓存 TTL（毫秒）
   * @default 60000（1 分钟）
   */
  defaultTTL?: number;

  /**
   * 最大缓存条目数
   * 超过此数量时移除最早的缓存
   * @default 100
   */
  maxEntries?: number;

  /**
   * 自定义缓存键生成函数
   * 默认使用 method + url + params 的组合
   */
  keyGenerator?: (url: string, options?: RequestOptions) => string;

  /**
   * 是否缓存请求
   * 返回 false 的请求将绕过缓存
   * 默认仅缓存 GET 请求
   */
  shouldCache?: (url: string, options?: RequestOptions) => boolean;
}

/**
 * 缓存拦截器
 *
 * 拦截请求，对可缓存的请求（默认为 GET）进行响应缓存。
 *
 * @example
 * ```typescript
 * const cache = new CacheInterceptor({
 *   defaultTTL: 30000,  // 30 秒
 *   maxEntries: 50,
 * });
 *
 * // 第一次请求：发起网络请求
 * const res1 = await cache.execute(adapter, '/api/data');
 *
 * // 第二次请求（30 秒内）：直接返回缓存
 * const res2 = await cache.execute(adapter, '/api/data');
 *
 * // 手动清除缓存
 * cache.invalidate('/api/data');
 * ```
 */
export class CacheInterceptor {
  /** 缓存存储 */
  private readonly store: Map<string, CacheItem>;

  /** 默认 TTL（毫秒） */
  private readonly defaultTTL: number;

  /** 最大条目数 */
  private readonly maxEntries: number;

  /** 缓存键生成器 */
  private readonly keyGenerator: (url: string, options?: RequestOptions) => string;

  /** 是否缓存判断函数 */
  private readonly shouldCache: (url: string, options?: RequestOptions) => boolean;

  constructor(options: CacheInterceptorOptions = {}) {
    this.store = new Map();
    this.defaultTTL = options.defaultTTL ?? 60000;
    this.maxEntries = options.maxEntries ?? 100;

    // 默认缓存键：method + url + 排序后的查询参数
    this.keyGenerator = options.keyGenerator ?? ((url: string, opts?: RequestOptions) => {
      const method = opts?.method ?? 'GET';
      const params = opts?.params
        ? JSON.stringify(
            Object.keys(opts.params)
              .sort()
              .reduce((acc, key) => {
                acc[key] = opts.params![key]!;
                return acc;
              }, {} as Record<string, string | number | boolean>),
          )
        : '';
      return `${method}:${url}:${params}`;
    });

    // 默认仅缓存 GET 请求
    this.shouldCache = options.shouldCache ?? ((_url: string, opts?: RequestOptions) => {
      const method = (opts?.method ?? 'GET').toUpperCase();
      return method === 'GET';
    });
  }

  /**
   * 执行带缓存的请求
   *
   * @param adapter - 请求适配器
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 响应数据（可能来自缓存）
   */
  async execute<T = unknown>(
    adapter: RequestAdapter,
    url: string,
    options?: RequestOptions,
  ): Promise<RequestResponse<T>> {
    // 检查是否应该缓存
    if (!this.shouldCache(url, options)) {
      return adapter.request<T>(url, options);
    }

    const cacheKey = this.keyGenerator(url, options);

    // 1. 查找缓存
    const cached = this.getFromCache<T>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    // 2. 缓存未命中，发起真实请求
    const response = await adapter.request<T>(url, options);

    // 3. 仅缓存成功的响应
    if (response.status >= 200 && response.status < 300) {
      this.setToCache(cacheKey, response);
    }

    return response;
  }

  /**
   * 手动失效指定 URL 的缓存
   *
   * @param url - 要失效的 URL（支持前缀匹配）
   * @returns 失效的条目数
   */
  invalidate(url: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      // 支持前缀匹配（如 '/api/user' 可失效 '/api/user:...' 的所有缓存）
      if (key.includes(url)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * 获取缓存条目数
   */
  size(): number {
    return this.store.size;
  }

  /**
   * 从缓存中获取数据
   *
   * 同时执行过期检查，过期的条目会被自动清除。
   */
  private getFromCache<T>(key: string): RequestResponse<T> | null {
    const item = this.store.get(key);
    if (!item) return null;

    // 过期检查
    if (Date.now() >= item.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return item.response as RequestResponse<T>;
  }

  /**
   * 将响应写入缓存
   */
  private setToCache<T>(key: string, response: RequestResponse<T>): void {
    // 容量控制：超过上限时删除最早的条目
    if (this.store.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.store.set(key, {
      response,
      expiresAt: Date.now() + this.defaultTTL,
      createdAt: Date.now(),
    });
  }

  /**
   * 淘汰最旧的缓存条目
   *
   * 删除创建时间最早的条目以腾出空间。
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, item] of this.store.entries()) {
      if (item.createdAt < oldestTime) {
        oldestTime = item.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.store.delete(oldestKey);
    }
  }
}
