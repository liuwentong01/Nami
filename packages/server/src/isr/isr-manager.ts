/**
 * @nami/server - ISR 管理器
 *
 * ISRManager 是增量静态再生（ISR）功能的核心管理器，
 * 整合缓存存储、重验证队列和 SWR 策略判断，提供统一的 ISR 操作接口。
 *
 * 核心职责：
 * 1. 缓存读写协调 — 统一管理缓存的读取、写入和失效
 * 2. SWR 策略判断 — 根据缓存新鲜度决定返回策略
 * 3. 后台重验证调度 — 将过期缓存的重新渲染交给队列后台执行
 * 4. 按需失效 — 支持按路径或标签主动失效缓存
 * 5. 缓存预热 — 在服务启动时预生成热门页面的缓存
 *
 * 使用流程：
 * ```
 * const manager = new ISRManager(config, cacheStore);
 *
 * // 核心方法：获取缓存或触发重验证
 * const result = await manager.getOrRevalidate(
 *   '/products/1',
 *   async () => await renderPage('/products/1'),
 *   60, // 60 秒后重验证
 * );
 *
 * // 按需失效
 * await manager.invalidate('/products/1');       // 按路径失效
 * await manager.invalidateByTag('product:123');  // 按标签失效
 *
 * // 缓存预热
 * await manager.warmup(['/products/1', '/about']);
 * ```
 *
 * @example
 * ```typescript
 * import { ISRManager, createCacheStore } from '@nami/server';
 *
 * const cacheStore = createCacheStore({ cacheAdapter: 'redis', redis: { ... } });
 * const isrManager = new ISRManager(config.isr, cacheStore);
 * ```
 */

import type { CacheStore, CacheEntry, ISRCacheResult, ISRConfig, CacheStats } from '@nami/shared';
import { createLogger, generateETag } from '@nami/shared';
import { RevalidationQueue } from './revalidation-queue';
import {
  evaluateCacheFreshness,
  SWRState,
} from './stale-while-revalidate';
import type { SWROptions } from './stale-while-revalidate';

/** 模块级日志实例 */
const logger = createLogger('@nami/server:isr-manager');

/**
 * ISR 管理器配置选项
 */
export interface ISRManagerOptions {
  /**
   * SWR 策略配置
   */
  swrOptions?: SWROptions;

  /**
   * 重验证队列最大并发数
   * 默认: 2
   */
  revalidationConcurrency?: number;

  /**
   * 重验证超时时间（毫秒）
   * 默认: 30000
   */
  revalidationTimeout?: number;
}

/**
 * ISR 管理器
 *
 * 增量静态再生的核心管理类，整合缓存、重验证和 SWR 策略。
 */
export class ISRManager {
  /** ISR 配置 */
  private readonly config: ISRConfig;

  /** 缓存存储后端 */
  private readonly cacheStore: CacheStore;

  /** 后台重验证队列 */
  private readonly revalidationQueue: RevalidationQueue;

  /** SWR 策略配置 */
  private readonly swrOptions: SWROptions;

  constructor(
    config: ISRConfig,
    cacheStore: CacheStore,
    options: ISRManagerOptions = {},
  ) {
    this.config = config;
    this.cacheStore = cacheStore;
    this.swrOptions = options.swrOptions ?? {};

    /**
     * 创建后台重验证队列
     * 队列负责限制并发、去重、超时保护等
     */
    this.revalidationQueue = new RevalidationQueue({
      cacheStore,
      maxConcurrency: options.revalidationConcurrency ?? 2,
      timeout: options.revalidationTimeout ?? 30000,
      onRevalidated: (key, _html) => {
        logger.info('ISR 后台重验证完成', { key });
      },
      onRevalidationFailed: (key, error) => {
        logger.error('ISR 后台重验证失败', {
          key,
          error: error.message,
        });
      },
    });

    logger.info('ISR 管理器初始化完成', {
      cacheAdapter: config.cacheAdapter,
      defaultRevalidate: config.defaultRevalidate,
      revalidationConcurrency: options.revalidationConcurrency ?? 2,
    });
  }

  /**
   * 获取缓存或触发重验证（核心 SWR 方法）
   *
   * 这是 ISR 最核心的方法，实现了完整的 stale-while-revalidate 语义：
   *
   * 1. 缓存命中且新鲜 → 直接返回缓存内容
   * 2. 缓存命中但过期 → 返回过期内容，后台触发重验证
   * 3. 缓存未命中 → 同步执行渲染，缓存结果后返回
   *
   * @param key - 缓存键（通常是请求路径）
   * @param renderFn - 渲染函数（缓存未命中或重验证时调用）
   * @param revalidateSeconds - 重验证间隔（秒）
   * @returns ISR 缓存结果
   */
  async getOrRevalidate(
    key: string,
    renderFn: () => Promise<string>,
    revalidateSeconds: number,
  ): Promise<ISRCacheResult> {
    const effectiveRevalidate = revalidateSeconds || this.config.defaultRevalidate;

    // ===== 1. 尝试读取缓存 =====
    const cachedEntry = await this.cacheStore.get(key);

    if (cachedEntry) {
      // ===== 2. 评估缓存新鲜度 =====
      const evaluation = evaluateCacheFreshness(
        cachedEntry.createdAt,
        cachedEntry.revalidateAfter,
        this.swrOptions,
      );

      switch (evaluation.state) {
        /**
         * Fresh — 缓存新鲜，直接返回
         * 这是最理想的情况，响应时间 < 1ms
         */
        case SWRState.Fresh: {
          logger.debug('ISR 缓存命中（新鲜）', {
            key,
            age: evaluation.age,
            ttl: evaluation.ttl,
          });

          return {
            html: cachedEntry.content,
            isStale: false,
            isCacheMiss: false,
            createdAt: cachedEntry.createdAt,
            etag: cachedEntry.etag,
          };
        }

        /**
         * Stale — 缓存过期但可用
         * 返回过期内容给用户（用户无感知），后台异步重新渲染
         */
        case SWRState.Stale: {
          logger.info('ISR 缓存命中（过期），触发后台重验证', {
            key,
            age: evaluation.age,
          });

          // 后台触发重验证（非阻塞）
          this.revalidationQueue.enqueue(
            key,
            renderFn,
            effectiveRevalidate,
            cachedEntry.tags,
          );

          return {
            html: cachedEntry.content,
            isStale: true,
            isCacheMiss: false,
            createdAt: cachedEntry.createdAt,
            etag: cachedEntry.etag,
          };
        }

        /**
         * Expired — 缓存完全过期
         * 不返回旧内容，走缓存未命中流程
         */
        case SWRState.Expired: {
          logger.info('ISR 缓存已完全过期，需要重新渲染', {
            key,
            age: evaluation.age,
          });
          // 继续到下方的缓存未命中流程
          break;
        }
      }
    }

    // ===== 3. 缓存未命中 — 同步渲染并缓存结果 =====
    logger.info('ISR 缓存未命中，执行同步渲染', { key });

    try {
      const html = await renderFn();

      // 生成 ETag（用于条件请求）
      const etag = generateETag(html);

      // 创建缓存条目
      const entry: CacheEntry = {
        content: html,
        createdAt: Date.now(),
        revalidateAfter: effectiveRevalidate,
        tags: [],
        etag,
      };

      // 写入缓存（异步，不阻塞响应）
      void this.cacheStore.set(key, entry, effectiveRevalidate * 2).catch((err) => {
        logger.error('ISR 缓存写入失败', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return {
        html,
        isStale: false,
        isCacheMiss: true,
        createdAt: entry.createdAt,
        etag,
      };
    } catch (error) {
      logger.error('ISR 同步渲染失败', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 按路径失效缓存
   *
   * 主动使指定路径的缓存失效，下次请求时将触发重新渲染。
   * 适用于 CMS 内容更新后的即时刷新场景。
   *
   * @param path - 需要失效的路径
   */
  async invalidate(path: string): Promise<void> {
    logger.info('ISR 按路径失效缓存', { path });
    await this.cacheStore.delete(path);
  }

  /**
   * 按标签批量失效缓存
   *
   * 使所有包含指定标签的缓存条目失效。
   * 适用于数据实体更新后，需要刷新所有引用该实体的页面。
   *
   * @param tag - 缓存标签
   * @returns 失效的缓存条目数量
   *
   * @example
   * ```typescript
   * // 产品信息更新后，失效所有引用该产品的页面
   * await isrManager.invalidateByTag('product:123');
   * ```
   */
  async invalidateByTag(tag: string): Promise<number> {
    logger.info('ISR 按标签失效缓存', { tag });
    return this.cacheStore.invalidateByTag(tag);
  }

  /**
   * 缓存预热
   *
   * 在服务启动时或部署后，预先渲染并缓存指定路径的页面。
   * 确保热门页面的首次请求也能命中缓存。
   *
   * @param routes - 需要预热的路径列表
   * @param renderFn - 渲染函数
   *
   * @example
   * ```typescript
   * await isrManager.warmup(
   *   ['/', '/products', '/about'],
   *   async (path) => await renderPage(path),
   * );
   * ```
   */
  async warmup(
    routes: string[],
    renderFn: (path: string) => Promise<string>,
  ): Promise<void> {
    logger.info('开始 ISR 缓存预热', {
      routeCount: routes.length,
      routes,
    });

    let successCount = 0;
    let failCount = 0;

    for (const route of routes) {
      try {
        const html = await renderFn(route);
        const etag = generateETag(html);

        const entry: CacheEntry = {
          content: html,
          createdAt: Date.now(),
          revalidateAfter: this.config.defaultRevalidate,
          tags: [],
          etag,
        };

        await this.cacheStore.set(route, entry, this.config.defaultRevalidate * 2);
        successCount++;

        logger.debug('ISR 缓存预热成功', { route });
      } catch (error) {
        failCount++;
        logger.error('ISR 缓存预热失败', {
          route,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('ISR 缓存预热完成', {
      total: routes.length,
      success: successCount,
      failed: failCount,
    });
  }

  /**
   * 获取缓存统计信息
   *
   * 包括缓存命中率、总条目数、存储大小等指标，
   * 用于监控 ISR 缓存的健康状态。
   *
   * @returns 缓存统计信息
   */
  async getStats(): Promise<CacheStats & { queueStatus: ReturnType<RevalidationQueue['getStatus']> }> {
    const cacheStats = await this.cacheStore.getStats();
    const queueStatus = this.revalidationQueue.getStatus();

    return {
      ...cacheStats,
      queueStatus,
    };
  }

  /**
   * 关闭 ISR 管理器
   *
   * 在服务停机时调用，关闭重验证队列并释放缓存存储资源。
   * 对于 Redis 等需要连接管理的缓存后端，必须调用此方法释放连接。
   */
  async close(): Promise<void> {
    logger.info('关闭 ISR 管理器');
    this.revalidationQueue.close();

    // 关闭缓存存储后端（释放 Redis 连接等资源）
    if (typeof (this.cacheStore as any).close === 'function') {
      try {
        await (this.cacheStore as any).close();
        logger.debug('缓存存储已关闭');
      } catch (error) {
        logger.warn('缓存存储关闭失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
