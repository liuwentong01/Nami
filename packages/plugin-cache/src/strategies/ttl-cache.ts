/**
 * @nami/plugin-cache - TTL 缓存策略
 *
 * 基于 TTL（Time To Live，生存时间）的缓存实现。
 * 每个缓存条目在写入时设定过期时间，过期后自动失效。
 *
 * 与 LRU 缓存的区别：
 * - LRU 按访问频率淘汰，TTL 按时间过期
 * - TTL 缓存不限制条目数量（但有安全上限）
 * - TTL 缓存通过定时器自动清理过期条目，减少内存占用
 *
 * 适用场景：
 * - 需要精确控制缓存有效期的场景（如 ISR 页面缓存）
 * - 数据有明确更新周期的场景（如每 5 分钟更新一次的数据）
 */

import type { CacheEntry, CacheStore, CacheStats } from '@nami/shared';

/**
 * TTL 缓存条目的内部包装
 * 在原始 CacheEntry 基础上添加过期时间信息
 */
interface TTLCacheItem {
  /** 原始缓存条目 */
  entry: CacheEntry;
  /** 过期时间戳（毫秒），undefined 表示永不过期 */
  expiresAt: number | undefined;
}

/**
 * TTL 缓存配置选项
 */
export interface TTLCacheOptions {
  /**
   * 默认 TTL（秒）
   * 未指定 TTL 的条目将使用此默认值
   * 设为 0 表示永不过期
   * @default 300（5 分钟）
   */
  defaultTTL?: number;

  /**
   * 自动清理间隔（秒）
   * 定时器每隔指定秒数扫描并清除过期条目
   * 设为 0 表示禁用自动清理（仅在读取时惰性清理）
   * @default 60（1 分钟）
   */
  cleanupInterval?: number;

  /**
   * 最大条目数安全上限
   * 超过此上限时拒绝写入新条目，防止内存泄漏
   * @default 10000
   */
  maxEntries?: number;

  /**
   * 是否启用统计信息收集
   * @default true
   */
  enableStats?: boolean;
}

/**
 * TTL 缓存实现
 *
 * 使用 Map 作为底层存储，通过定时器定期清理过期条目。
 * 同时支持惰性清理（读取时检查过期）和主动清理（定时器扫描）。
 *
 * @example
 * ```typescript
 * const cache = new NamiTTLCache({ defaultTTL: 300, cleanupInterval: 60 });
 * await cache.set('page:/home', entry, 120); // 120 秒后过期
 * const result = await cache.get('page:/home');
 * ```
 */
export class NamiTTLCache implements CacheStore {
  /** 缓存存储 */
  private readonly store: Map<string, TTLCacheItem>;

  /** 标签到缓存键的映射 */
  private readonly tagIndex: Map<string, Set<string>>;

  /** 自动清理定时器引用 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** 默认 TTL（秒） */
  private readonly defaultTTL: number;

  /** 最大条目数 */
  private readonly maxEntries: number;

  /** 缓存命中次数 */
  private hits: number = 0;

  /** 缓存未命中次数 */
  private misses: number = 0;

  /** 是否启用统计 */
  private readonly enableStats: boolean;

  /** 最后更新时间 */
  private lastUpdated: number = Date.now();

  /** 是否已销毁 */
  private disposed: boolean = false;

  constructor(options: TTLCacheOptions = {}) {
    const {
      defaultTTL = 300,
      cleanupInterval = 60,
      maxEntries = 10000,
      enableStats = true,
    } = options;

    this.defaultTTL = defaultTTL;
    this.maxEntries = maxEntries;
    this.enableStats = enableStats;
    this.store = new Map();
    this.tagIndex = new Map();

    // 启动自动清理定时器
    // 定时扫描所有条目，移除已过期的，避免内存持续增长
    if (cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, cleanupInterval * 1000);

      // 确保定时器不阻止 Node.js 进程退出
      // unref() 使得当定时器是唯一活跃的异步操作时，进程可以正常退出
      if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
        (this.cleanupTimer as NodeJS.Timeout).unref();
      }
    }
  }

  /**
   * 获取缓存条目
   *
   * 读取时执行惰性过期检查：如果条目已过期则删除并返回 null。
   *
   * @param key - 缓存键
   * @returns 缓存条目，未命中或已过期返回 null
   */
  async get(key: string): Promise<CacheEntry | null> {
    const item = this.store.get(key);

    if (item === undefined) {
      if (this.enableStats) this.misses++;
      return null;
    }

    // 检查是否过期
    if (this.isExpired(item)) {
      // 条目已过期，执行惰性清理
      this.removeEntry(key);
      if (this.enableStats) this.misses++;
      return null;
    }

    // 缓存命中
    if (this.enableStats) this.hits++;
    return item.entry;
  }

  /**
   * 写入缓存条目
   *
   * @param key - 缓存键
   * @param entry - 缓存内容
   * @param ttl - 过期时间（秒），0 使用默认 TTL，undefined 使用默认 TTL
   */
  async set(key: string, entry: CacheEntry, ttl?: number): Promise<void> {
    if (this.disposed) {
      throw new Error('[NamiTTLCache] 缓存已销毁，无法写入');
    }

    // 安全上限检查
    // 如果条目数已达上限且本次写入是新增（非更新），则拒绝写入
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      // 先尝试清理过期条目腾出空间
      this.cleanup();
      if (this.store.size >= this.maxEntries) {
        throw new Error(
          `[NamiTTLCache] 缓存条目数已达上限 ${this.maxEntries}，请清理缓存或增大上限`
        );
      }
    }

    // 计算过期时间
    const effectiveTTL = ttl !== undefined && ttl > 0 ? ttl : this.defaultTTL;
    const expiresAt = effectiveTTL > 0 ? Date.now() + effectiveTTL * 1000 : undefined;

    // 如果是更新已有条目，先从标签索引中移除旧的关联
    if (this.store.has(key)) {
      this.removeFromTagIndex(key);
    }

    // 写入缓存
    this.store.set(key, { entry, expiresAt });

    // 更新标签索引
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
    this.removeEntry(key);
    this.lastUpdated = Date.now();
  }

  /**
   * 检查缓存键是否存在且未过期
   *
   * @param key - 缓存键
   */
  async has(key: string): Promise<boolean> {
    const item = this.store.get(key);
    if (item === undefined) return false;

    // 惰性过期检查
    if (this.isExpired(item)) {
      this.removeEntry(key);
      return false;
    }

    return true;
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    this.store.clear();
    this.tagIndex.clear();
    this.hits = 0;
    this.misses = 0;
    this.lastUpdated = Date.now();
  }

  /**
   * 按标签批量失效
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
    for (const key of keys) {
      if (this.store.has(key)) {
        this.store.delete(key);
        count++;
      }
    }

    this.tagIndex.delete(tag);
    this.lastUpdated = Date.now();
    return count;
  }

  /**
   * 获取缓存统计信息
   */
  async getStats(): Promise<CacheStats> {
    const totalRequests = this.hits + this.misses;
    return {
      totalEntries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: totalRequests > 0 ? this.hits / totalRequests : 0,
      sizeBytes: this.estimateSize(),
      lastUpdated: this.lastUpdated,
    };
  }

  /**
   * 销毁缓存实例
   *
   * 清理定时器和所有缓存数据。
   * 销毁后不可再使用该实例。
   */
  dispose(): void {
    this.disposed = true;

    // 停止自动清理定时器
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // 清空所有数据
    this.store.clear();
    this.tagIndex.clear();
  }

  /**
   * 主动清理所有过期条目
   *
   * 由定时器定期调用，也可手动调用以立即释放过期条目占用的内存。
   *
   * @returns 清理的条目数量
   */
  cleanup(): number {
    let cleaned = 0;
    const now = Date.now();

    for (const [key, item] of this.store.entries()) {
      if (item.expiresAt !== undefined && now >= item.expiresAt) {
        this.removeEntry(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * 检查缓存条目是否已过期
   */
  private isExpired(item: TTLCacheItem): boolean {
    if (item.expiresAt === undefined) {
      // 未设置过期时间，永不过期
      return false;
    }
    return Date.now() >= item.expiresAt;
  }

  /**
   * 移除缓存条目及其标签索引
   */
  private removeEntry(key: string): void {
    this.removeFromTagIndex(key);
    this.store.delete(key);
  }

  /**
   * 从标签索引中移除指定缓存键的所有关联
   */
  private removeFromTagIndex(key: string): void {
    for (const [tag, keys] of this.tagIndex.entries()) {
      keys.delete(key);
      if (keys.size === 0) {
        this.tagIndex.delete(tag);
      }
    }
  }

  /**
   * 估算缓存内存占用
   */
  private estimateSize(): number {
    let size = 0;
    for (const [, item] of this.store.entries()) {
      size += item.entry.content.length * 2;
    }
    return size;
  }
}
