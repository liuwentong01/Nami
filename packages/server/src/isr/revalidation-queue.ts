/**
 * @nami/server - ISR 后台重验证队列
 *
 * 管理 ISR 模式下的后台重验证任务。
 * 当缓存过期（stale）但仍可用时，先返回旧内容给用户，
 * 同时将重新渲染任务加入此队列，后台异步执行。
 *
 * 核心特性：
 * 1. 任务去重 — 同一个缓存键不会被重复加入队列（避免并发请求触发多次渲染）
 * 2. 并发控制 — 限制同时执行的重验证任务数量（防止瞬时大量渲染压垮服务）
 * 3. 错误隔离 — 单个任务失败不影响其他任务和主请求流程
 * 4. 超时保护 — 每个任务有最大执行时间限制
 *
 * 工作流程：
 * ```
 * enqueue(key, renderFn, revalidateSeconds)
 *   ↓
 * 去重检查 → 已在队列中？ → 跳过
 *   ↓ 不在队列中
 * 加入等待队列
 *   ↓
 * processQueue()
 *   ↓
 * 并发控制 → 当前执行数 < maxConcurrency？
 *   ↓ 是
 * 执行 renderFn() → 成功？ → 更新缓存
 *                     ↓ 失败
 *                  记录日志，保留旧缓存
 * ```
 *
 * @example
 * ```typescript
 * import { RevalidationQueue } from '@nami/server';
 *
 * const queue = new RevalidationQueue({
 *   maxConcurrency: 2,
 *   timeout: 30000,
 *   onRevalidated: async (key, html) => {
 *     await cacheStore.set(key, entry);
 *   },
 * });
 *
 * queue.enqueue('/products/1', renderFn, 60);
 * ```
 */

import { createLogger } from '@nami/shared';
import type { CacheEntry, CacheStore } from '@nami/shared';

/** 模块级日志实例 */
const logger = createLogger('@nami/server:revalidation-queue');

/**
 * 重验证任务
 */
interface RevalidationJob {
  /** 缓存键（通常是请求路径） */
  key: string;

  /** 渲染函数 — 执行实际的 SSR 渲染并返回 HTML */
  renderFn: () => Promise<string>;

  /** 重验证间隔（秒）— 渲染成功后的新缓存 TTL */
  revalidateSeconds: number;

  /** 缓存标签（可选）— 渲染结果缓存时关联的标签 */
  tags?: string[];

  /** 入队时间戳 */
  enqueuedAt: number;
}

/**
 * 重验证队列配置选项
 */
export interface RevalidationQueueOptions {
  /**
   * 最大并发数
   * 同时执行的重验证任务数量上限
   * 默认: 2
   */
  maxConcurrency?: number;

  /**
   * 单个任务超时时间（毫秒）
   * 默认: 30000（30秒）
   */
  timeout?: number;

  /**
   * 缓存存储实例
   * 重验证成功后用于更新缓存
   */
  cacheStore: CacheStore;

  /**
   * 重验证成功回调
   * 在缓存更新之后调用
   */
  onRevalidated?: (key: string, html: string) => void | Promise<void>;

  /**
   * 重验证失败回调
   */
  onRevalidationFailed?: (key: string, error: Error) => void | Promise<void>;
}

/**
 * ISR 后台重验证队列
 */
export class RevalidationQueue {
  /** 等待执行的任务队列 */
  private readonly pendingQueue: RevalidationJob[] = [];

  /** 正在执行中的任务键集合（用于去重） */
  private readonly activeKeys: Set<string> = new Set();

  /** 已在队列中等待的任务键集合（用于去重） */
  private readonly pendingKeys: Set<string> = new Set();

  /** 最大并发数 */
  private readonly maxConcurrency: number;

  /** 单个任务超时时间（毫秒） */
  private readonly timeout: number;

  /** 缓存存储实例 */
  private readonly cacheStore: CacheStore;

  /** 回调函数 */
  private readonly onRevalidated?: (key: string, html: string) => void | Promise<void>;
  private readonly onRevalidationFailed?: (key: string, error: Error) => void | Promise<void>;

  /** 当前正在执行的任务数 */
  private activeCount = 0;

  /** 是否已关闭 */
  private closed = false;

  constructor(options: RevalidationQueueOptions) {
    this.maxConcurrency = options.maxConcurrency ?? 2;
    this.timeout = options.timeout ?? 30000;
    this.cacheStore = options.cacheStore;
    this.onRevalidated = options.onRevalidated;
    this.onRevalidationFailed = options.onRevalidationFailed;

    logger.debug('重验证队列初始化', {
      maxConcurrency: this.maxConcurrency,
      timeout: this.timeout,
    });
  }

  /**
   * 将重验证任务加入队列
   *
   * 如果同一个 key 的任务已经在队列中（等待或执行中），
   * 则跳过此次入队，避免重复渲染。
   *
   * @param key - 缓存键
   * @param renderFn - 渲染函数
   * @param revalidateSeconds - 重验证间隔（秒）
   * @param tags - 缓存标签（可选）
   */
  enqueue(
    key: string,
    renderFn: () => Promise<string>,
    revalidateSeconds: number,
    tags?: string[],
  ): void {
    // 队列已关闭
    if (this.closed) {
      logger.warn('重验证队列已关闭，忽略入队请求', { key });
      return;
    }

    // 去重检查：该 key 是否已在队列中或正在执行
    if (this.pendingKeys.has(key) || this.activeKeys.has(key)) {
      logger.debug('重验证任务已存在，跳过', { key });
      return;
    }

    // 加入队列
    const job: RevalidationJob = {
      key,
      renderFn,
      revalidateSeconds,
      tags,
      enqueuedAt: Date.now(),
    };

    this.pendingQueue.push(job);
    this.pendingKeys.add(key);

    logger.debug('重验证任务入队', {
      key,
      queueSize: this.pendingQueue.length,
      activeCount: this.activeCount,
    });

    // 尝试处理队列
    this.processQueue();
  }

  /**
   * 获取队列状态
   */
  getStatus(): {
    pending: number;
    active: number;
    maxConcurrency: number;
  } {
    return {
      pending: this.pendingQueue.length,
      active: this.activeCount,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /**
   * 关闭队列
   *
   * 停止接受新任务，但允许正在执行的任务完成。
   */
  close(): void {
    this.closed = true;
    this.pendingQueue.length = 0;
    this.pendingKeys.clear();
    logger.info('重验证队列已关闭', {
      activeCount: this.activeCount,
    });
  }

  // ==================== 私有方法 ====================

  /**
   * 处理队列
   *
   * 检查是否有空闲的并发槽位，如果有则从队列头部取出任务执行。
   * 此方法是非阻塞的，不会等待任务完成。
   */
  private processQueue(): void {
    // 如果已关闭或没有待处理任务，直接返回
    while (this.activeCount < this.maxConcurrency && this.pendingQueue.length > 0) {
      const job = this.pendingQueue.shift();
      if (!job) break;

      this.pendingKeys.delete(job.key);
      this.activeKeys.add(job.key);
      this.activeCount++;

      // 异步执行任务（不等待完成）
      void this.executeJob(job);
    }
  }

  /**
   * 执行单个重验证任务
   *
   * @param job - 重验证任务
   */
  private async executeJob(job: RevalidationJob): Promise<void> {
    const startTime = Date.now();

    logger.info('开始执行重验证', {
      key: job.key,
      queueWaitTime: startTime - job.enqueuedAt,
    });

    try {
      /**
       * 使用 Promise.race 实现超时保护
       * 防止渲染函数长时间阻塞占用并发槽位
       */
      const html = await Promise.race([
        job.renderFn(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`重验证超时（${this.timeout}ms）`)),
            this.timeout,
          );
        }),
      ]);

      const duration = Date.now() - startTime;

      /**
       * 重验证成功 → 更新缓存
       */
      const cacheEntry: CacheEntry = {
        content: html,
        createdAt: Date.now(),
        revalidateAfter: job.revalidateSeconds,
        tags: job.tags ?? [],
      };

      await this.cacheStore.set(job.key, cacheEntry, job.revalidateSeconds);

      logger.info('重验证成功，缓存已更新', {
        key: job.key,
        duration,
        revalidateSeconds: job.revalidateSeconds,
      });

      // 执行成功回调
      if (this.onRevalidated) {
        try {
          await this.onRevalidated(job.key, html);
        } catch (callbackError) {
          logger.warn('重验证成功回调执行失败', {
            key: job.key,
            error: callbackError instanceof Error
              ? callbackError.message
              : String(callbackError),
          });
        }
      }
    } catch (error) {
      const normalizedError = error instanceof Error
        ? error
        : new Error(String(error));

      const duration = Date.now() - startTime;

      /**
       * 重验证失败 → 保留旧缓存，记录日志
       *
       * 这是 stale-while-revalidate 的核心优势：
       * 即使重验证失败，用户仍然看到旧内容，而不是错误页面。
       */
      logger.error('重验证失败，保留旧缓存', {
        key: job.key,
        duration,
        error: normalizedError.message,
      });

      // 执行失败回调
      if (this.onRevalidationFailed) {
        try {
          await this.onRevalidationFailed(job.key, normalizedError);
        } catch {
          // 忽略回调失败
        }
      }
    } finally {
      /**
       * 释放并发槽位
       * 无论成功还是失败，都要释放并尝试处理下一个任务
       */
      this.activeKeys.delete(job.key);
      this.activeCount--;

      // 继续处理队列中的下一个任务
      this.processQueue();
    }
  }
}
