/**
 * @nami/shared - 缓存系统类型定义
 *
 * 定义三层缓存架构中的核心类型：
 * - Layer 1: CDN 缓存（通过 Cache-Control 头控制）
 * - Layer 2: 应用层缓存（ISR 页面缓存、数据缓存）
 * - Layer 3: 进程内存缓存（路由匹配、模板等热点数据）
 */

/**
 * 缓存条目
 * 缓存存储中的单条记录
 */
export interface CacheEntry {
  /** 缓存内容（HTML 字符串或序列化数据） */
  content: string;

  /** 缓存创建时间戳（毫秒） */
  createdAt: number;

  /** 重验证间隔（秒） */
  revalidateAfter: number;

  /**
   * 缓存标签
   * 用于按标签批量失效，如 ['product:123', 'category:electronics']
   */
  tags: string[];

  /** 关联的渲染元信息 */
  meta?: Record<string, unknown>;

  /**
   * ETag 值
   * 用于条件请求和缓存验证
   */
  etag?: string;
}

/**
 * 缓存存储接口（抽象）
 *
 * 所有缓存后端（内存、文件系统、Redis）都必须实现此接口。
 * ISRManager 通过此接口操作缓存，不关心底层存储实现。
 */
export interface CacheStore {
  /**
   * 获取缓存条目
   * @param key - 缓存键
   * @returns 缓存条目，未命中返回 null
   */
  get(key: string): Promise<CacheEntry | null>;

  /**
   * 写入缓存条目
   * @param key - 缓存键
   * @param entry - 缓存内容
   * @param ttl - 过期时间（秒），0 表示永不过期
   */
  set(key: string, entry: CacheEntry, ttl?: number): Promise<void>;

  /**
   * 删除指定缓存条目
   * @param key - 缓存键
   */
  delete(key: string): Promise<void>;

  /**
   * 检查缓存键是否存在
   * @param key - 缓存键
   */
  has(key: string): Promise<boolean>;

  /**
   * 清空所有缓存
   * 危险操作，通常仅在部署或紧急情况下使用
   */
  clear(): Promise<void>;

  /**
   * 按标签批量失效
   * 使所有包含指定标签的缓存条目失效
   *
   * @param tag - 缓存标签
   * @returns 失效的缓存条目数量
   */
  invalidateByTag(tag: string): Promise<number>;

  /**
   * 获取缓存统计信息
   */
  getStats(): Promise<CacheStats>;
}

/**
 * ISR 缓存结果
 * ISRManager.getOrRevalidate 的返回值
 */
export interface ISRCacheResult {
  /** 页面 HTML 内容 */
  html: string;

  /** 缓存是否过期（已触发后台重验证） */
  isStale: boolean;

  /** 是否缓存未命中（首次渲染） */
  isCacheMiss: boolean;

  /** 缓存条目的创建时间 */
  createdAt?: number;

  /** 缓存条目的 ETag */
  etag?: string;
}

/**
 * 缓存统计信息
 */
export interface CacheStats {
  /** 总缓存条目数 */
  totalEntries: number;

  /** 缓存命中次数 */
  hits: number;

  /** 缓存未命中次数 */
  misses: number;

  /** 命中率（0-1） */
  hitRate: number;

  /** 缓存占用大小（字节，如果可获取） */
  sizeBytes?: number;

  /** 最后更新时间 */
  lastUpdated?: number;
}

/**
 * 缓存配置选项
 */
export interface CacheOptions {
  /** 最大缓存条目数（LRU 策略） */
  maxEntries?: number;

  /** 默认 TTL（秒） */
  defaultTTL?: number;

  /** 是否启用统计 */
  enableStats?: boolean;

  /** 缓存键生成函数 */
  keyGenerator?: (url: string, headers?: Record<string, string>) => string;
}
