/**
 * @nami/plugin-monitor - 渲染指标收集器
 *
 * 收集渲染模式、降级状态、缓存命中率等渲染层面的指标。
 * 与 PerformanceCollector（关注耗时）不同，
 * RenderMetricsCollector 更关注渲染「质量」和「状态」。
 *
 * 收集的指标维度：
 * - 渲染模式分布（SSR / CSR / SSG / ISR 各占比多少）
 * - 降级率（多少请求经历了降级处理）
 * - 缓存命中率（ISR 模式下的缓存效果）
 * - 渲染成功率
 */

import type { RenderContext, RenderResult } from '@nami/shared';

/**
 * 单次渲染的状态指标
 */
export interface RenderMetric {
  /** 请求 URL */
  url: string;

  /** 请求 ID */
  requestId: string;

  /** 实际使用的渲染模式 */
  renderMode: string;

  /** 是否经历了降级 */
  degraded: boolean;

  /** 降级原因（如果降级了） */
  degradeReason?: string;

  /** 是否命中缓存 */
  cacheHit: boolean;

  /** 缓存是否过期（stale-while-revalidate 状态） */
  cacheStale: boolean;

  /** HTTP 状态码 */
  statusCode: number;

  /** 采集时间戳 */
  timestamp: number;
}

/**
 * 渲染指标聚合统计
 */
export interface RenderMetricsSummary {
  /** 统计的总渲染次数 */
  totalRenders: number;

  /** 各渲染模式的次数 */
  renderModeDistribution: Record<string, number>;

  /** 降级次数 */
  degradedCount: number;

  /** 降级率（0-1） */
  degradationRate: number;

  /** 缓存命中次数 */
  cacheHitCount: number;

  /** 缓存命中率（0-1） */
  cacheHitRate: number;

  /** 成功渲染次数（HTTP 2xx） */
  successCount: number;

  /** 渲染成功率（0-1） */
  successRate: number;

  /** 统计窗口开始时间 */
  windowStart: number;

  /** 统计窗口结束时间 */
  windowEnd: number;
}

/**
 * 渲染指标收集器
 *
 * 持续收集渲染状态指标，维护滑动窗口内的聚合统计。
 *
 * @example
 * ```typescript
 * const collector = new RenderMetricsCollector();
 *
 * // 每次渲染后收集指标
 * collector.collect(context, result);
 *
 * // 获取聚合统计
 * const summary = collector.getSummary();
 * console.log(`降级率: ${(summary.degradationRate * 100).toFixed(1)}%`);
 * console.log(`缓存命中率: ${(summary.cacheHitRate * 100).toFixed(1)}%`);
 * ```
 */
export class RenderMetricsCollector {
  /** 指标缓冲区 */
  private buffer: RenderMetric[] = [];

  /** 缓冲区最大容量 */
  private readonly maxBufferSize: number;

  /** 聚合计数器 */
  private counters = {
    total: 0,
    degraded: 0,
    cacheHit: 0,
    success: 0,
    renderModes: new Map<string, number>(),
  };

  /** 统计窗口开始时间 */
  private windowStart: number = Date.now();

  constructor(options: { maxBufferSize?: number } = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 1000;
  }

  /**
   * 收集单次渲染的状态指标
   *
   * @param context - 渲染上下文
   * @param result - 渲染结果
   * @returns 收集到的指标
   */
  collect(context: RenderContext, result: RenderResult): RenderMetric {
    const metric: RenderMetric = {
      url: context.url,
      requestId: context.requestId,
      renderMode: result.meta.renderMode,
      degraded: result.meta.degraded,
      degradeReason: result.meta.degradeReason,
      cacheHit: result.meta.cacheHit ?? false,
      cacheStale: result.meta.cacheStale ?? false,
      statusCode: result.statusCode,
      timestamp: Date.now(),
    };

    // 更新聚合计数器
    this.updateCounters(metric);

    // 写入缓冲区
    this.addToBuffer(metric);

    return metric;
  }

  /**
   * 获取聚合统计摘要
   *
   * 返回从统计窗口开始至今的渲染指标聚合结果。
   */
  getSummary(): RenderMetricsSummary {
    const { total, degraded, cacheHit, success, renderModes } = this.counters;

    // 将 Map 转换为普通对象
    const renderModeDistribution: Record<string, number> = {};
    for (const [mode, count] of renderModes.entries()) {
      renderModeDistribution[mode] = count;
    }

    return {
      totalRenders: total,
      renderModeDistribution,
      degradedCount: degraded,
      degradationRate: total > 0 ? degraded / total : 0,
      cacheHitCount: cacheHit,
      cacheHitRate: total > 0 ? cacheHit / total : 0,
      successCount: success,
      successRate: total > 0 ? success / total : 0,
      windowStart: this.windowStart,
      windowEnd: Date.now(),
    };
  }

  /**
   * 获取缓冲区中的所有指标并清空
   *
   * @returns 所有已缓冲的渲染指标
   */
  flush(): RenderMetric[] {
    const metrics = [...this.buffer];
    this.buffer = [];
    return metrics;
  }

  /**
   * 重置聚合计数器，开始新的统计窗口
   */
  resetCounters(): void {
    this.counters = {
      total: 0,
      degraded: 0,
      cacheHit: 0,
      success: 0,
      renderModes: new Map(),
    };
    this.windowStart = Date.now();
  }

  /**
   * 获取缓冲区大小
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * 更新聚合计数器
   */
  private updateCounters(metric: RenderMetric): void {
    this.counters.total++;

    if (metric.degraded) {
      this.counters.degraded++;
    }

    if (metric.cacheHit) {
      this.counters.cacheHit++;
    }

    if (metric.statusCode >= 200 && metric.statusCode < 300) {
      this.counters.success++;
    }

    // 更新渲染模式分布
    const modeCount = this.counters.renderModes.get(metric.renderMode) ?? 0;
    this.counters.renderModes.set(metric.renderMode, modeCount + 1);
  }

  /**
   * 将指标加入缓冲区
   */
  private addToBuffer(metric: RenderMetric): void {
    if (this.buffer.length >= this.maxBufferSize) {
      const dropCount = Math.floor(this.maxBufferSize * 0.1);
      this.buffer = this.buffer.slice(dropCount);
    }
    this.buffer.push(metric);
  }
}
