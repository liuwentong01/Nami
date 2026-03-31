/**
 * @nami/plugin-cache - 缓存插件主体
 *
 * NamiCachePlugin 是 Nami 框架的官方缓存插件，负责：
 * 1. 在渲染前（onBeforeRender）检查缓存，命中时直接返回缓存结果
 * 2. 在渲染后（onAfterRender）将渲染结果写入缓存
 * 3. 支持可配置的缓存策略（LRU / TTL）
 * 4. 支持自定义缓存键生成逻辑
 * 5. 通过 CDN 缓存管理器生成 Cache-Control 响应头
 *
 * 缓存流程：
 * ```
 * 请求到达 → onBeforeRender 检查缓存
 *   ├─ 命中 → 将缓存内容写入 context.extra，跳过渲染
 *   └─ 未命中 → 继续渲染流程
 *         → onAfterRender → 将渲染结果写入缓存
 * ```
 */

import type {
  NamiPlugin,
  PluginAPI,
  RenderContext,
  RenderResult,
  CacheStore,
} from '@nami/shared';
import { NamiLRUCache, type LRUCacheOptions } from './strategies/lru-cache';
import { NamiTTLCache, type TTLCacheOptions } from './strategies/ttl-cache';
import { CDNCacheManager, type CDNCacheConfig } from './strategies/cdn-cache';

/**
 * 缓存策略类型
 */
export type CacheStrategy = 'lru' | 'ttl';

/**
 * 缓存键生成函数类型
 *
 * 接收渲染上下文，返回用于缓存查找的唯一键。
 * 默认使用 URL 作为缓存键，可根据需要加入 cookie、header 等维度。
 *
 * @param context - 渲染上下文
 * @returns 缓存键字符串
 */
export type CacheKeyGenerator = (context: RenderContext) => string;

/**
 * 缓存插件配置选项
 */
export interface CachePluginOptions {
  /**
   * 缓存策略
   * - 'lru': 基于最近最少使用的淘汰策略（推荐用于页面缓存）
   * - 'ttl': 基于时间过期的策略（推荐用于需要精确过期控制的场景）
   * @default 'lru'
   */
  strategy?: CacheStrategy;

  /**
   * LRU 缓存配置（仅当 strategy 为 'lru' 时生效）
   */
  lruOptions?: LRUCacheOptions;

  /**
   * TTL 缓存配置（仅当 strategy 为 'ttl' 时生效）
   */
  ttlOptions?: TTLCacheOptions;

  /**
   * 外部提供的缓存存储实例
   * 如果提供，将忽略 strategy / lruOptions / ttlOptions 配置
   * 适用于使用 Redis 等外部缓存的场景
   */
  store?: CacheStore;

  /**
   * 自定义缓存键生成函数
   * 默认使用 `context.url` 作为缓存键
   *
   * @example
   * ```typescript
   * // 按设备类型区分缓存
   * keyGenerator: (ctx) => `${ctx.url}:${ctx.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'desktop'}`
   * ```
   */
  keyGenerator?: CacheKeyGenerator;

  /**
   * CDN 缓存配置
   * 如果提供，将在渲染结果中添加 Cache-Control 响应头
   */
  cdnConfig?: CDNCacheConfig;

  /**
   * 默认缓存 TTL（秒）
   * 写入缓存时的默认过期时间
   * @default 60
   */
  defaultTTL?: number;

  /**
   * 是否启用缓存
   * 可在运行时动态禁用缓存（如开发环境）
   * @default true
   */
  enabled?: boolean;

  /**
   * 缓存命中时的日志前缀
   * @default '[NamiCache]'
   */
  logPrefix?: string;
}

/**
 * 默认缓存键生成函数
 * 使用完整 URL（包含查询参数）作为缓存键
 */
const defaultKeyGenerator: CacheKeyGenerator = (context: RenderContext): string => {
  return `nami:page:${context.url}`;
};

/**
 * Nami 缓存插件
 *
 * 提供渲染结果的缓存能力，显著降低重复渲染的性能开销。
 *
 * @example
 * ```typescript
 * import { NamiCachePlugin } from '@nami/plugin-cache';
 *
 * const cachePlugin = new NamiCachePlugin({
 *   strategy: 'lru',
 *   lruOptions: { maxSize: 500, ttl: 300 },
 *   keyGenerator: (ctx) => `page:${ctx.url}`,
 *   cdnConfig: {
 *     scope: 'public',
 *     maxAge: 60,
 *     sMaxAge: 3600,
 *   },
 * });
 * ```
 */
export class NamiCachePlugin implements NamiPlugin {
  /** 插件唯一名称 */
  readonly name = 'nami:cache';

  /** 插件版本号 */
  readonly version = '0.1.0';

  /**
   * 执行顺序：pre（在其他插件之前执行）
   * 缓存检查应尽早执行，命中后可跳过后续渲染
   */
  readonly enforce = 'pre' as const;

  /** 缓存存储实例 */
  private store: CacheStore;

  /** CDN 缓存管理器 */
  private readonly cdnManager: CDNCacheManager;

  /** 插件配置 */
  private readonly options: Required<
    Pick<CachePluginOptions, 'keyGenerator' | 'defaultTTL' | 'enabled' | 'logPrefix'>
  > & CachePluginOptions;

  constructor(options: CachePluginOptions = {}) {
    // 合并默认配置
    this.options = {
      ...options,
      keyGenerator: options.keyGenerator ?? defaultKeyGenerator,
      defaultTTL: options.defaultTTL ?? 60,
      enabled: options.enabled ?? true,
      logPrefix: options.logPrefix ?? '[NamiCache]',
    };

    // 初始化缓存存储
    // 优先使用外部提供的 store，否则根据策略创建内置实例
    if (options.store) {
      this.store = options.store;
    } else {
      this.store = this.createStore(options.strategy ?? 'lru');
    }

    // 初始化 CDN 缓存管理器
    this.cdnManager = new CDNCacheManager();
  }

  /**
   * 插件初始化
   *
   * 注册渲染前和渲染后的生命周期钩子：
   * - onBeforeRender: 检查缓存，命中时将结果写入 context.extra
   * - onAfterRender:  将渲染结果写入缓存，并添加 Cache-Control 头
   * - onDispose:      清理缓存资源
   *
   * @param api - 插件 API
   */
  async setup(api: PluginAPI): Promise<void> {
    const logger = api.getLogger();

    // ==================== 渲染前：检查缓存 ====================
    api.onBeforeRender(async (context: RenderContext) => {
      if (!this.options.enabled) return;

      try {
        const cacheKey = this.options.keyGenerator(context);
        const cached = await this.store.get(cacheKey);

        if (cached !== null) {
          // 缓存命中！
          // 将缓存内容写入 context.extra，渲染引擎检测到后直接使用缓存结果
          context.extra['__cache_hit'] = true;
          context.extra['__cache_key'] = cacheKey;
          context.extra['__cache_content'] = cached.content;
          context.extra['__cache_etag'] = cached.etag;
          context.extra['__cache_created_at'] = cached.createdAt;

          logger.debug(`${this.options.logPrefix} 缓存命中`, {
            url: context.url,
            key: cacheKey,
            age: Math.round((Date.now() - cached.createdAt) / 1000),
          });
        } else {
          // 缓存未命中
          context.extra['__cache_hit'] = false;
          context.extra['__cache_key'] = cacheKey;

          logger.debug(`${this.options.logPrefix} 缓存未命中`, {
            url: context.url,
            key: cacheKey,
          });
        }
      } catch (error) {
        // 缓存读取失败不应影响渲染流程
        // 记录错误后继续正常渲染
        logger.warn(`${this.options.logPrefix} 缓存读取失败`, {
          url: context.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // ==================== 渲染后：写入缓存 ====================
    api.onAfterRender(async (context: RenderContext, result: RenderResult) => {
      if (!this.options.enabled) return;

      // 仅缓存成功的渲染结果（HTTP 2xx）
      if (result.statusCode < 200 || result.statusCode >= 300) {
        return;
      }

      // 如果是缓存命中的结果，不需要再次写入
      if (context.extra['__cache_hit'] === true) {
        return;
      }

      try {
        const cacheKey = context.extra['__cache_key'] as string | undefined;
        if (!cacheKey) return;

        // 确定缓存 TTL
        // 优先使用渲染结果中的 cacheControl.revalidate，其次使用默认 TTL
        const ttl = result.cacheControl?.revalidate ?? this.options.defaultTTL;

        // 构建缓存条目
        await this.store.set(
          cacheKey,
          {
            content: result.html,
            createdAt: Date.now(),
            revalidateAfter: ttl,
            tags: result.cacheControl?.tags ?? [],
            meta: {
              statusCode: result.statusCode,
              renderMode: result.meta.renderMode,
              duration: result.meta.duration,
            },
          },
          ttl,
        );

        // 添加 CDN Cache-Control 响应头
        if (this.options.cdnConfig) {
          result.headers['Cache-Control'] = this.cdnManager.generateHeader(
            this.options.cdnConfig,
          );
        } else if (result.cacheControl) {
          // 如果没有自定义 CDN 配置，但渲染结果中有 cacheControl，
          // 则自动生成 ISR 风格的 Cache-Control 头
          result.headers['Cache-Control'] = this.cdnManager.generateISRHeader(
            result.cacheControl.revalidate,
            result.cacheControl.staleWhileRevalidate,
          );
        }

        logger.debug(`${this.options.logPrefix} 缓存写入成功`, {
          url: context.url,
          key: cacheKey,
          ttl,
        });
      } catch (error) {
        // 缓存写入失败不应影响响应返回
        logger.warn(`${this.options.logPrefix} 缓存写入失败`, {
          url: context.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // ==================== 插件销毁：清理资源 ====================
    api.onDispose(async () => {
      // 如果使用的是 TTL 缓存，需要停止清理定时器
      if (this.store instanceof NamiTTLCache) {
        this.store.dispose();
      }
      logger.info(`${this.options.logPrefix} 插件已销毁，缓存资源已清理`);
    });
  }

  /**
   * 根据策略创建缓存存储实例
   *
   * @param strategy - 缓存策略类型
   * @returns 缓存存储实例
   */
  private createStore(strategy: CacheStrategy): CacheStore {
    switch (strategy) {
      case 'lru':
        return new NamiLRUCache(this.options.lruOptions);
      case 'ttl':
        return new NamiTTLCache(this.options.ttlOptions);
      default:
        // 未知策略，回退到 LRU
        return new NamiLRUCache(this.options.lruOptions);
    }
  }

  /**
   * 获取当前缓存存储实例
   * 可用于外部直接操作缓存（如手动失效）
   */
  getStore(): CacheStore {
    return this.store;
  }

  /**
   * 获取 CDN 缓存管理器
   */
  getCDNManager(): CDNCacheManager {
    return this.cdnManager;
  }
}
