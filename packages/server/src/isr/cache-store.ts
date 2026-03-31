/**
 * @nami/server - 缓存存储工厂
 *
 * 重新导出 @nami/shared 中的 CacheStore 接口，
 * 并提供 createCacheStore 工厂函数，根据配置创建对应的缓存后端实例。
 *
 * 三种缓存后端：
 * - memory:      内存缓存（基于 Map + LRU 淘汰）
 * - filesystem:  文件系统缓存（JSON 文件持久化）
 * - redis:       Redis 缓存（分布式共享）
 *
 * 选型建议：
 * - 开发环境 / 单进程部署 → memory
 * - 单机多进程部署 → filesystem
 * - 多机分布式部署 → redis
 *
 * @example
 * ```typescript
 * import { createCacheStore } from '@nami/server';
 *
 * const store = createCacheStore({
 *   cacheAdapter: 'redis',
 *   redis: { host: '127.0.0.1', port: 6379 },
 * });
 * ```
 */

import type { CacheStore, CacheOptions, ISRConfig } from '@nami/shared';
import { createLogger } from '@nami/shared';
import { MemoryStore } from './memory-store';
import { FilesystemStore } from './filesystem-store';
import { RedisStore } from './redis-store';

/** 模块级日志实例 */
const logger = createLogger('@nami/server:cache-store');

/**
 * 重新导出 CacheStore 接口
 *
 * 所有缓存后端（MemoryStore、FilesystemStore、RedisStore）
 * 都实现此接口，ISRManager 通过此接口操作缓存，不关心底层存储。
 */
export type { CacheStore, CacheEntry, CacheStats, CacheOptions } from '@nami/shared';

/**
 * 缓存存储工厂配置
 */
export interface CreateCacheStoreOptions {
  /** 缓存适配器类型 */
  cacheAdapter: ISRConfig['cacheAdapter'];

  /** 缓存目录（filesystem 模式） */
  cacheDir?: string;

  /** Redis 连接配置（redis 模式） */
  redis?: ISRConfig['redis'];

  /** 缓存选项（通用） */
  cacheOptions?: CacheOptions;
}

/**
 * 创建缓存存储实例
 *
 * 根据配置中的 cacheAdapter 字段选择对应的缓存后端实现，
 * 返回统一的 CacheStore 接口实例。
 *
 * @param options - 缓存存储工厂配置
 * @returns CacheStore 实例
 * @throws Error 当配置无效时（如 redis 模式缺少连接配置）
 */
export function createCacheStore(options: CreateCacheStoreOptions): CacheStore {
  const { cacheAdapter, cacheDir, redis, cacheOptions } = options;

  logger.info(`创建缓存存储: ${cacheAdapter}`, {
    cacheAdapter,
    cacheDir,
    redisHost: redis?.host,
  });

  switch (cacheAdapter) {
    /**
     * 内存缓存
     *
     * 适用于开发环境和单进程部署。
     * 优点：最快的读写速度，零外部依赖
     * 缺点：进程重启后缓存丢失，多进程间不共享
     */
    case 'memory': {
      return new MemoryStore({
        maxEntries: cacheOptions?.maxEntries ?? 1000,
        enableStats: cacheOptions?.enableStats ?? true,
      });
    }

    /**
     * 文件系统缓存
     *
     * 适用于单机多进程部署（如 cluster 模式）。
     * 优点：进程重启后缓存持久化，多进程共享
     * 缺点：I/O 速度不如内存，不适合高并发场景
     */
    case 'filesystem': {
      if (!cacheDir) {
        logger.warn('filesystem 缓存未指定 cacheDir，使用默认路径 .nami-cache/isr');
      }
      return new FilesystemStore({
        cacheDir: cacheDir ?? '.nami-cache/isr',
        enableStats: cacheOptions?.enableStats ?? true,
      });
    }

    /**
     * Redis 缓存
     *
     * 适用于分布式多机部署。
     * 优点：所有实例共享缓存，支持 TTL 自动过期
     * 缺点：依赖外部 Redis 服务，网络延迟
     */
    case 'redis': {
      if (!redis) {
        throw new Error(
          '使用 redis 缓存适配器时必须提供 redis 连接配置（ISRConfig.redis）',
        );
      }
      return new RedisStore({
        host: redis.host,
        port: redis.port,
        password: redis.password,
        db: redis.db,
        keyPrefix: redis.keyPrefix ?? 'nami:isr:',
        enableStats: cacheOptions?.enableStats ?? true,
      });
    }

    /**
     * 未知的缓存适配器类型
     */
    default: {
      throw new Error(`不支持的缓存适配器类型: ${cacheAdapter as string}`);
    }
  }
}
