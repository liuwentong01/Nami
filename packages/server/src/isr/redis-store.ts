/**
 * @nami/server - Redis 缓存存储实现
 *
 * 基于 ioredis 的 Redis 缓存后端，适用于分布式多机部署。
 *
 * 特性：
 * 1. 分布式共享 — 所有服务实例共享同一份缓存
 * 2. 原生 TTL — 利用 Redis EXPIRE 自动过期，无需应用层维护
 * 3. 标签索引 — 使用 Redis SET 数据结构实现标签到键的映射
 * 4. 连接池 — ioredis 内置连接池，支持高并发
 * 5. 断线重连 — ioredis 自动处理连接中断和重连
 *
 * Redis 键设计：
 * ```
 * {keyPrefix}entry:{key}     → JSON 序列化的缓存条目
 * {keyPrefix}tag:{tag}       → SET 类型，存储该标签关联的所有缓存键
 * {keyPrefix}stats:hits      → 命中计数
 * {keyPrefix}stats:misses    → 未命中计数
 * ```
 *
 * 适用场景：
 * - 多机分布式部署（K8s 多副本、多台物理机）
 * - 需要缓存在多个服务实例间共享
 * - 缓存数据量较大的场景（Redis 可使用大容量实例）
 *
 * @example
 * ```typescript
 * import { RedisStore } from '@nami/server';
 *
 * const store = new RedisStore({
 *   host: '127.0.0.1',
 *   port: 6379,
 *   keyPrefix: 'nami:isr:',
 * });
 * ```
 */

import type { CacheEntry, CacheStore, CacheStats } from '@nami/shared';
import { createLogger } from '@nami/shared';
import Redis from 'ioredis';

/**
 * Redis 缓存配置选项
 */
export interface RedisStoreOptions {
  /** Redis 主机地址 */
  host: string;

  /** Redis 端口 */
  port: number;

  /** Redis 密码（可选） */
  password?: string;

  /** Redis 数据库索引（默认 0） */
  db?: number;

  /**
   * 键名前缀
   * 默认: 'nami:isr:'
   * 用于在 Redis 中区分 Nami ISR 缓存和其他业务数据
   */
  keyPrefix?: string;

  /**
   * 是否启用统计
   * 默认: true
   */
  enableStats?: boolean;

  /**
   * 连接超时（毫秒）
   * 默认: 5000
   */
  connectTimeout?: number;

  /**
   * 最大重试次数
   * 默认: 3
   */
  maxRetriesPerRequest?: number;
}

/** 模块级日志实例 */
const logger = createLogger('@nami/server:redis-store');

/**
 * Redis 缓存存储
 *
 * 实现 @nami/shared 中的 CacheStore 接口。
 */
export class RedisStore implements CacheStore {
  /** ioredis 客户端实例 */
  private readonly client: Redis;

  /** 键名前缀 */
  private readonly prefix: string;

  /** 是否启用统计 */
  private readonly enableStats: boolean;

  constructor(options: RedisStoreOptions) {
    this.prefix = options.keyPrefix ?? 'nami:isr:';
    this.enableStats = options.enableStats ?? true;

    /**
     * 创建 ioredis 客户端
     *
     * ioredis 默认配置已经非常合理：
     * - 自动重连（exponential backoff）
     * - 离线命令队列（断连期间的命令会排队等待重连后执行）
     * - 连接池
     */
    this.client = new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      db: options.db ?? 0,
      connectTimeout: options.connectTimeout ?? 5000,
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
      /**
       * 不使用 ioredis 的 keyPrefix 选项，
       * 因为我们需要在 SCAN 等命令中手动处理前缀
       */
      lazyConnect: true, // 延迟连接，避免构造函数阻塞
    });

    // 监听连接事件
    this.client.on('connect', () => {
      logger.info('Redis 连接成功', {
        host: options.host,
        port: options.port,
        db: options.db ?? 0,
      });
    });

    this.client.on('error', (err) => {
      logger.error('Redis 连接错误', {
        error: err.message,
      });
    });

    this.client.on('close', () => {
      logger.warn('Redis 连接关闭');
    });

    // 建立连接
    void this.client.connect().catch((err) => {
      logger.error('Redis 初始连接失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ==================== 键名生成工具 ====================

  /** 生成缓存条目的 Redis 键 */
  private entryKey(key: string): string {
    return `${this.prefix}entry:${key}`;
  }

  /** 生成标签索引的 Redis 键 */
  private tagKey(tag: string): string {
    return `${this.prefix}tag:${tag}`;
  }

  /** 生成统计计数器的 Redis 键 */
  private statsKey(name: string): string {
    return `${this.prefix}stats:${name}`;
  }

  // ==================== CacheStore 接口实现 ====================

  /**
   * 获取缓存条目
   *
   * @param key - 缓存键
   * @returns 缓存条目，未命中返回 null
   */
  async get(key: string): Promise<CacheEntry | null> {
    try {
      const data = await this.client.get(this.entryKey(key));

      if (!data) {
        if (this.enableStats) {
          void this.client.incr(this.statsKey('misses')).catch(() => {});
        }
        return null;
      }

      /**
       * 反序列化缓存条目
       * Redis 中存储的是 JSON 字符串
       */
      const entry: CacheEntry = JSON.parse(data);

      if (this.enableStats) {
        void this.client.incr(this.statsKey('hits')).catch(() => {});
      }

      return entry;
    } catch (error) {
      logger.error('Redis GET 失败', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 写入缓存条目
   *
   * @param key - 缓存键
   * @param entry - 缓存内容
   * @param ttl - 过期时间（秒），0 或不传表示永不过期
   */
  async set(key: string, entry: CacheEntry, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(entry);
      const redisKey = this.entryKey(key);

      /**
       * 使用 Redis SETEX（SET + EXPIRE 的原子操作）
       * 确保写入和 TTL 设置不会因为中途失败而不一致
       */
      if (ttl && ttl > 0) {
        await this.client.setex(redisKey, ttl, serialized);
      } else {
        await this.client.set(redisKey, serialized);
      }

      /**
       * 更新标签索引
       * 使用 Redis SET（SADD）数据结构存储标签到键的映射
       */
      if (entry.tags && entry.tags.length > 0) {
        const pipeline = this.client.pipeline();
        for (const tag of entry.tags) {
          pipeline.sadd(this.tagKey(tag), key);
        }
        await pipeline.exec();
      }
    } catch (error) {
      logger.error('Redis SET 失败', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 删除指定缓存条目
   *
   * @param key - 缓存键
   */
  async delete(key: string): Promise<void> {
    try {
      // 先获取条目以清理标签索引
      const data = await this.client.get(this.entryKey(key));
      if (data) {
        const entry: CacheEntry = JSON.parse(data);
        if (entry.tags && entry.tags.length > 0) {
          const pipeline = this.client.pipeline();
          for (const tag of entry.tags) {
            pipeline.srem(this.tagKey(tag), key);
          }
          await pipeline.exec();
        }
      }

      await this.client.del(this.entryKey(key));
    } catch (error) {
      logger.error('Redis DEL 失败', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 检查缓存键是否存在
   *
   * @param key - 缓存键
   */
  async has(key: string): Promise<boolean> {
    try {
      const exists = await this.client.exists(this.entryKey(key));
      return exists === 1;
    } catch (error) {
      logger.error('Redis EXISTS 失败', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 清空所有缓存
   *
   * 使用 SCAN + DEL 而非 FLUSHDB，避免影响同一 Redis 实例中的其他数据。
   */
  async clear(): Promise<void> {
    try {
      const pattern = `${this.prefix}*`;
      let cursor = '0';

      /**
       * 使用 SCAN 遍历所有匹配前缀的键
       *
       * SCAN 是增量式的，不会像 KEYS 那样阻塞 Redis。
       * 每次迭代返回一批键，直到 cursor 回到 '0'。
       */
      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;

        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      } while (cursor !== '0');

      logger.info('Redis 缓存已清空', { pattern });
    } catch (error) {
      logger.error('清空 Redis 缓存失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 按标签批量失效
   *
   * @param tag - 缓存标签
   * @returns 失效的缓存条目数量
   */
  async invalidateByTag(tag: string): Promise<number> {
    try {
      const tagRedisKey = this.tagKey(tag);

      // 获取该标签下的所有缓存键
      const keys = await this.client.smembers(tagRedisKey);

      if (keys.length === 0) return 0;

      // 批量删除缓存条目
      const pipeline = this.client.pipeline();
      for (const key of keys) {
        pipeline.del(this.entryKey(key));
      }
      // 删除标签索引本身
      pipeline.del(tagRedisKey);
      await pipeline.exec();

      logger.info(`按标签失效 Redis 缓存: ${tag}`, {
        tag,
        invalidatedCount: keys.length,
      });

      return keys.length;
    } catch (error) {
      logger.error('Redis 按标签失效失败', {
        tag,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * 获取缓存统计信息
   */
  async getStats(): Promise<CacheStats> {
    try {
      // 获取命中和未命中计数
      const [hitsStr, missesStr] = await Promise.all([
        this.client.get(this.statsKey('hits')),
        this.client.get(this.statsKey('misses')),
      ]);

      const hits = parseInt(hitsStr ?? '0', 10);
      const misses = parseInt(missesStr ?? '0', 10);
      const total = hits + misses;
      const hitRate = total > 0 ? hits / total : 0;

      // 统计缓存条目总数
      let totalEntries = 0;
      let cursor = '0';
      const pattern = `${this.prefix}entry:*`;

      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = nextCursor;
        totalEntries += keys.length;
      } while (cursor !== '0');

      return {
        totalEntries,
        hits,
        misses,
        hitRate: Number(hitRate.toFixed(4)),
        lastUpdated: Date.now(),
      };
    } catch (error) {
      logger.error('获取 Redis 缓存统计失败', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        totalEntries: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        lastUpdated: Date.now(),
      };
    }
  }

  // ==================== 生命周期方法 ====================

  /**
   * 关闭 Redis 连接
   *
   * 在服务停机时应调用此方法，确保 Redis 连接被正确释放。
   * 同时提供 close() 别名，与 CacheStore 接口及 ISRManager.close() 保持一致。
   */
  async disconnect(): Promise<void> {
    try {
      await this.client.quit();
      logger.info('Redis 连接已关闭');
    } catch (error) {
      logger.error('关闭 Redis 连接失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** CacheStore 统一关闭接口 — ISRManager.close() 会调用此方法 */
  async close(): Promise<void> {
    return this.disconnect();
  }
}
