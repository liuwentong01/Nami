/**
 * @nami/plugin-cache - 缓存插件
 *
 * Nami 框架官方缓存插件，提供多层次的缓存能力：
 * - LRU 缓存：基于最近最少使用的内存缓存策略
 * - TTL 缓存：基于时间过期的缓存策略
 * - CDN 缓存：Cache-Control 响应头管理
 *
 * @example
 * ```typescript
 * import { NamiCachePlugin } from '@nami/plugin-cache';
 *
 * export default {
 *   plugins: [
 *     new NamiCachePlugin({
 *       strategy: 'lru',
 *       lruOptions: { maxSize: 500 },
 *     }),
 *   ],
 * };
 * ```
 *
 * @packageDocumentation
 */

// 导出插件主体
import { NamiCachePlugin } from './cache-plugin';
export type { CachePluginOptions, CacheStrategy, CacheKeyGenerator } from './cache-plugin';

// 导出缓存策略
export { NamiLRUCache } from './strategies/lru-cache';
export type { LRUCacheOptions } from './strategies/lru-cache';

export { NamiTTLCache } from './strategies/ttl-cache';
export type { TTLCacheOptions } from './strategies/ttl-cache';

export { CDNCacheManager } from './strategies/cdn-cache';
export type { CDNCacheConfig, CDNCachePreset } from './strategies/cdn-cache';

type LegacyCachePluginOptions = {
  maxAge?: number;
  maxSize?: number;
} & import('./cache-plugin').CachePluginOptions;

function normalizeCachePluginOptions(
  options: LegacyCachePluginOptions = {},
): import('./cache-plugin').CachePluginOptions {
  const normalizedLRUOptions = options.strategy === 'ttl'
    ? options.lruOptions
    : {
        maxSize: options.maxSize ?? options.lruOptions?.maxSize,
        ttl: options.maxAge ?? options.lruOptions?.ttl,
        enableStats: options.lruOptions?.enableStats,
      };

  return {
    ...options,
    lruOptions: normalizedLRUOptions,
  };
}

/**
 * 兼容历史 `pluginCache({...})` 调用方式的默认导出工厂。
 */
export default function pluginCache(options: LegacyCachePluginOptions = {}): NamiCachePlugin {
  return new NamiCachePlugin(normalizeCachePluginOptions(options));
}

export { NamiCachePlugin };
