/**
 * @nami/server - ISR 层导出入口
 *
 * 增量静态再生（Incremental Static Regeneration）完整实现。
 *
 * 架构概览：
 * ```
 * ISRManager（管理器）
 *   ├── CacheStore（缓存存储接口）
 *   │   ├── MemoryStore（内存缓存）
 *   │   ├── FilesystemStore（文件系统缓存）
 *   │   └── RedisStore（Redis 缓存）
 *   ├── RevalidationQueue（后台重验证队列）
 *   └── SWR（stale-while-revalidate 策略）
 * ```
 */

// ===== 缓存存储工厂 =====
export { createCacheStore } from './cache-store';
export type { CreateCacheStoreOptions } from './cache-store';

// 重新导出 CacheStore 相关类型
export type { CacheStore, CacheEntry, CacheStats, CacheOptions } from './cache-store';

// ===== 内存缓存 =====
export { MemoryStore } from './memory-store';
export type { MemoryStoreOptions } from './memory-store';

// ===== 文件系统缓存 =====
export { FilesystemStore } from './filesystem-store';
export type { FilesystemStoreOptions } from './filesystem-store';

// ===== Redis 缓存 =====
export { RedisStore } from './redis-store';
export type { RedisStoreOptions } from './redis-store';

// ===== 重验证队列 =====
export { RevalidationQueue } from './revalidation-queue';
export type { RevalidationQueueOptions } from './revalidation-queue';

// ===== SWR 策略 =====
export {
  SWRState,
  evaluateCacheFreshness,
  isCacheUsable,
  needsRevalidation,
} from './stale-while-revalidate';
export type { SWREvaluation, SWROptions } from './stale-while-revalidate';

// ===== ISR 管理器 =====
export { ISRManager } from './isr-manager';
export type { ISRManagerOptions } from './isr-manager';
