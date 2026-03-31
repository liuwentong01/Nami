/**
 * @nami/plugin-cache - LRU 缓存策略
 *
 * 基于 LRU（Least Recently Used，最近最少使用）算法的内存缓存实现。
 * 当缓存容量达到上限时，自动淘汰最久未被访问的条目。
 *
 * 特性：
 * - 固定容量上限，防止内存无限增长
 * - O(1) 时间复杂度的读写操作（基于 lru-cache 库）
 * - 可选的 TTL（生存时间）支持
 * - 缓存统计信息（命中率、条目数等）
 * - 支持按标签批量失效
 */

import { LRUCache as LRUCacheLib } from 'lru-cache';
import type { CacheEntry, CacheStore, CacheStats } from '@nami/shared';

/**
 * LRU 缓存配置选项
 */
export interface LRUCacheOptions {
  /**
   * 最大缓存条目数
   * 达到上限后将淘汰最近最少使用的条目
   * @default 1000
   */
  maxSize?: number;

  /**
   * 默认 TTL（秒）
   * 条目写入后经过 TTL 秒自动过期
   * 设为 0 表示永不过期（仅受 LRU 淘汰策略影响）
   * @default 0
   */
  ttl?: number;

  /**
   * 是否启用统计信息收集
   * 开启后会记录命中/未命中次数
   * @default true
   */
  enableStats?: boolean;
}

/**
 * LRU 缓存实现
 *
 * 使用 `lru-cache` 库作为底层存储引擎，提供高性能的内存缓存。
 * 适用于：
 * - 页面渲染结果缓存
 * - 路由匹配结果缓存
 * - 模板编译结果缓存
 *
 * @example
 * ```typescript
 * const cache = new NamiLRUCache({ maxSize: 500, ttl: 300 });
 * await cache.set('page:/home', entry, 60);
 * const result = await cache.get('page:/home');
 * ```
 */
export class NamiLRUCache implements CacheStore {
  /** 底层 LRU 缓存实例 */
  private readonly cache: LRUCacheLib<string, CacheEntry>;

  /** 标签到缓存键的映射（用于按标签批量失效） */
  private readonly tagIndex: Map<string, Set<string>>;

  /** 缓存命中次数 */
  private hits: number = 0;

  /** 缓存未命中次数 */
  private misses: number = 0;

  /** 是否启用统计 */
  private readonly enableStats: boolean;

  /** 最后更新时间戳 */
  private lastUpdated: number = Date.now();

  constructor(options: LRUCacheOptions = {}) {
    const {
      maxSize = 1000,
      ttl = 0,
      enableStats = true,
    } = options;

    this.enableStats = enableStats;
    this.tagIndex = new Map();

    // 初始化 lru-cache 实例
    // TTL 单位在 lru-cache 中为毫秒，需要从秒转换
    this.cache = new LRUCacheLib<string, CacheEntry>({
      max: maxSize,
      ttl: ttl > 0 ? ttl * 1000 : undefined,
      // 允许 TTL 为 0 的条目永不过期
      allowStale: false,
      // 当条目被淘汰时清理标签索引
      dispose: (_value: CacheEntry, key: string) => {
        this.removeFromTagIndex(key);
      },
    });
  }

  /**
   * 获取缓存条目
   *
   * @param key - 缓存键
   * @returns 缓存条目，未命中时返回 null
   */
  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.cache.get(key);

    if (entry !== undefined) {
      // 缓存命中
      if (this.enableStats) {
        this.hits++;
      }
      return entry;
    }

    // 缓存未命中
    if (this.enableStats) {
      this.misses++;
    }
    return null;
  }

  /**
   * 写入缓存条目
   *
   * @param key - 缓存键
   * @param entry - 缓存内容
   * @param ttl - 过期时间（秒），0 表示使用默认 TTL
   */
  async set(key: string, entry: CacheEntry, ttl?: number): Promise<void> {
    // 构建 lru-cache 的选项
    const options: LRUCacheLib.SetOptions<string, CacheEntry, unknown> = {};
    if (ttl !== undefined && ttl > 0) {
      // 覆盖默认 TTL，单位转换为毫秒
      options.ttl = ttl * 1000;
    }

    this.cache.set(key, entry, options);

    // 更新标签索引
    // 将缓存键关联到其所有标签，便于后续按标签批量失效
    if (entry.tags && entry.tags.length > 0) {
      for (const tag of entry.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set());
        }
        this.tagIndex.get(tag)!.add(key);
      }
    }

    this.lastUpdated = Date.now();
  }

  /**
   * 删除指定缓存条目
   *
   * @param key - 缓存键
   */
  async delete(key: string): Promise<void> {
    // 先清理标签索引，再删除条目
    this.removeFromTagIndex(key);
    this.cache.delete(key);
    this.lastUpdated = Date.now();
  }

  /**
   * 检查缓存键是否存在
   *
   * @param key - 缓存键
   * @returns 是否存在且未过期
   */
  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  /**
   * 清空所有缓存
   *
   * 危险操作 - 会清除所有缓存条目和标签索引
   * 通常仅在部署或紧急情况下使用
   */
  async clear(): Promise<void> {
    this.cache.clear();
    this.tagIndex.clear();
    this.hits = 0;
    this.misses = 0;
    this.lastUpdated = Date.now();
  }

  /**
   * 按标签批量失效
   *
   * 使所有包含指定标签的缓存条目失效。
   * 例如：当商品数据更新时，可通过标签 'product:123' 失效所有相关页面缓存。
   *
   * @param tag - 缓存标签
   * @returns 失效的缓存条目数量
   */
  async invalidateByTag(tag: string): Promise<number> {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) {
      return 0;
    }

    let count = 0;
    // 遍历该标签关联的所有缓存键，逐一删除
    for (const key of keys) {
      if (this.cache.has(key)) {
        this.cache.delete(key);
        count++;
      }
    }

    // 清除该标签的索引
    this.tagIndex.delete(tag);
    this.lastUpdated = Date.now();

    return count;
  }

  /**
   * 获取缓存统计信息
   *
   * @returns 包含命中率、条目数等统计数据
   */
  async getStats(): Promise<CacheStats> {
    const totalRequests = this.hits + this.misses;
    return {
      totalEntries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: totalRequests > 0 ? this.hits / totalRequests : 0,
      sizeBytes: this.estimateSize(),
      lastUpdated: this.lastUpdated,
    };
  }

  /**
   * 估算缓存占用的内存大小（字节）
   *
   * 这是一个粗略估算，基于缓存条目中 content 字段的字符串长度。
   * 实际内存占用可能更高（包含对象元数据、标签索引等开销）。
   *
   * @returns 估算的内存占用（字节）
   */
  private estimateSize(): number {
    let size = 0;
    // 遍历所有缓存条目，累加 content 的近似字节数
    // JavaScript 字符串使用 UTF-16 编码，每字符约 2 字节
    for (const [, entry] of this.cache.entries()) {
      size += entry.content.length * 2;
    }
    return size;
  }

  /**
   * 从标签索引中移除指定缓存键
   *
   * 当缓存条目被删除或淘汰时调用，确保标签索引不会产生悬挂引用。
   *
   * @param key - 要移除的缓存键
   */
  private removeFromTagIndex(key: string): void {
    for (const [tag, keys] of this.tagIndex.entries()) {
      keys.delete(key);
      // 如果标签下已没有任何缓存键，清除该标签
      if (keys.size === 0) {
        this.tagIndex.delete(tag);
      }
    }
  }
}
