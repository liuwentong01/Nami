/**
 * @nami/server - 内存缓存存储实现
 *
 * 基于 Map 数据结构实现的内存缓存，带有 LRU（最近最少使用）淘汰策略。
 *
 * 特性：
 * 1. O(1) 的读写性能（Map 哈希查找）
 * 2. LRU 淘汰策略 — 当缓存条目数超过 maxEntries 时，淘汰最久未访问的条目
 * 3. TTL 过期 — 每个条目有独立的过期时间
 * 4. 标签索引 — 支持按标签批量失效
 * 5. 统计信息 — 命中率、总条目数等
 *
 * LRU 实现原理：
 * - 使用 Map 的插入顺序特性（ES2015 Map 保证迭代顺序即插入顺序）
 * - 每次 get() 命中时，删除并重新插入该条目（移到末尾 = 最近使用）
 * - 淘汰时从 Map 头部开始删除（最久未使用）
 *
 * 适用场景：
 * - 开发环境
 * - 单进程部署（PM2 fork 模式）
 * - 缓存数据量较小的场景
 *
 * @example
 * ```typescript
 * import { MemoryStore } from '@nami/server';
 *
 * const store = new MemoryStore({ maxEntries: 500 });
 * await store.set('/', { content: '<html>...', createdAt: Date.now(), revalidateAfter: 60, tags: [] });
 * const entry = await store.get('/');
 * ```
 */

import type { CacheEntry, CacheStore, CacheStats } from '@nami/shared';
import { createLogger } from '@nami/shared';

/**
 * 内存缓存配置选项
 */
export interface MemoryStoreOptions {
  /**
   * 最大缓存条目数
   * 超过此数量时触发 LRU 淘汰
   * 默认: 1000
   */
  maxEntries?: number;

  /**
   * 是否启用统计
   * 默认: true
   */
  enableStats?: boolean;
}

/** 模块级日志实例 */
const logger = createLogger('@nami/server:memory-store');

/**
 * 内存缓存条目包装
 *
 * 在 CacheEntry 的基础上增加 TTL 管理所需的字段
 */
interface MemoryCacheItem {
  /** 原始缓存条目 */
  entry: CacheEntry;
  /** 过期时间戳（毫秒），0 表示永不过期 */
  expireAt: number;
}

/**
 * 内存缓存存储
 *
 * 实现 @nami/shared 中的 CacheStore 接口。
 * 使用 JavaScript Map 作为底层存储，利用其有序特性实现 LRU。
 */
export class MemoryStore implements CacheStore {
  /** 底层存储（Map 的迭代顺序即 LRU 顺序） */
  private readonly cache: Map<string, MemoryCacheItem> = new Map();

  /** 标签到键的反向索引（用于按标签批量失效） */
  private readonly tagIndex: Map<string, Set<string>> = new Map();

  /** 最大缓存条目数 */
  private readonly maxEntries: number;

  /** 是否启用统计 */
  private readonly enableStats: boolean;

  // 统计数据
  private hits = 0;
  private misses = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.enableStats = options.enableStats ?? true;

    logger.debug('内存缓存初始化', { maxEntries: this.maxEntries });
  }

  /**
   * 获取缓存条目
   *
   * @param key - 缓存键
   * @returns 缓存条目，未命中或已过期返回 null
   */
  async get(key: string): Promise<CacheEntry | null> {
    const item = this.cache.get(key);

    // 未命中
    if (!item) {
      if (this.enableStats) this.misses++;
      return null;
    }

    // 检查是否过期
    if (item.expireAt > 0 && Date.now() > item.expireAt) {
      // 过期 → 删除并返回 null
      this.deleteInternal(key);
      if (this.enableStats) this.misses++;
      return null;
    }

    /**
     * 命中 → LRU 更新
     * 删除后重新插入，使该条目移到 Map 的末尾（最近使用）
     */
    this.cache.delete(key);
    this.cache.set(key, item);

    if (this.enableStats) this.hits++;
    return item.entry;
  }

  /**
   * 写入缓存条目
   *
   * @param key - 缓存键
   * @param entry - 缓存内容
   * @param ttl - 过期时间（秒），0 或不传表示永不过期
   */
  async set(key: string, entry: CacheEntry, ttl?: number): Promise<void> {
    // 如果已存在，先删除旧条目（包括标签索引清理）
    if (this.cache.has(key)) {
      this.deleteInternal(key);
    }

    // 计算过期时间
    const expireAt = ttl && ttl > 0
      ? Date.now() + ttl * 1000
      : 0;

    // 写入缓存
    this.cache.set(key, { entry, expireAt });

    // 更新标签索引
    if (entry.tags && entry.tags.length > 0) {
      for (const tag of entry.tags) {
        let keys = this.tagIndex.get(tag);
        if (!keys) {
          keys = new Set();
          this.tagIndex.set(tag, keys);
        }
        keys.add(key);
      }
    }

    // LRU 淘汰：超过最大条目数时，删除最久未使用的条目
    if (this.cache.size > this.maxEntries) {
      this.evict();
    }
  }

  /**
   * 删除指定缓存条目
   *
   * @param key - 缓存键
   */
  async delete(key: string): Promise<void> {
    this.deleteInternal(key);
  }

  /**
   * 检查缓存键是否存在（且未过期）
   *
   * @param key - 缓存键
   */
  async has(key: string): Promise<boolean> {
    const item = this.cache.get(key);
    if (!item) return false;

    // 检查是否过期
    if (item.expireAt > 0 && Date.now() > item.expireAt) {
      this.deleteInternal(key);
      return false;
    }

    return true;
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    this.cache.clear();
    this.tagIndex.clear();
    this.hits = 0;
    this.misses = 0;
    logger.info('内存缓存已清空');
  }

  /**
   * 按标签批量失效
   *
   * 删除所有包含指定标签的缓存条目。
   *
   * @param tag - 缓存标签
   * @returns 失效的缓存条目数量
   */
  async invalidateByTag(tag: string): Promise<number> {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) return 0;

    let invalidatedCount = 0;
    // 复制 Set 避免迭代时修改
    const keysToDelete = [...keys];

    for (const key of keysToDelete) {
      this.deleteInternal(key);
      invalidatedCount++;
    }

    logger.info(`按标签失效缓存: ${tag}`, {
      tag,
      invalidatedCount,
    });

    return invalidatedCount;
  }

  /**
   * 获取缓存统计信息
   */
  async getStats(): Promise<CacheStats> {
    const totalEntries = this.cache.size;
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? this.hits / total : 0;

    // 估算缓存大小（粗略估算 JSON 序列化后的字节数）
    let sizeBytes = 0;
    for (const [key, item] of this.cache) {
      sizeBytes += key.length * 2; // UTF-16 字符串
      sizeBytes += item.entry.content.length * 2;
    }

    return {
      totalEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: Number(hitRate.toFixed(4)),
      sizeBytes,
      lastUpdated: Date.now(),
    };
  }

  // ==================== 私有方法 ====================

  /**
   * 内部删除方法
   *
   * 同时清理标签索引，确保索引与缓存数据一致。
   *
   * @param key - 缓存键
   */
  private deleteInternal(key: string): void {
    const item = this.cache.get(key);
    if (!item) return;

    // 清理标签索引
    if (item.entry.tags) {
      for (const tag of item.entry.tags) {
        const keys = this.tagIndex.get(tag);
        if (keys) {
          keys.delete(key);
          // 如果该标签下已无任何键，清理标签条目本身
          if (keys.size === 0) {
            this.tagIndex.delete(tag);
          }
        }
      }
    }

    this.cache.delete(key);
  }

  /**
   * LRU 淘汰
   *
   * 从 Map 头部开始删除条目（最久未使用），
   * 直到缓存条目数降至 maxEntries 以下。
   */
  private evict(): void {
    const evictCount = Math.max(1, Math.floor(this.maxEntries * 0.1)); // 每次淘汰 10%
    let evicted = 0;

    for (const [key] of this.cache) {
      if (evicted >= evictCount) break;
      this.deleteInternal(key);
      evicted++;
    }

    logger.debug(`LRU 淘汰完成`, {
      evictedCount: evicted,
      remainingEntries: this.cache.size,
    });
  }
}
