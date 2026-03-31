/**
 * @nami/plugin-monitor - 性能指标收集器
 *
 * 收集服务端渲染流程中的性能计时指标，包括：
 * - 总渲染时间（从请求到达到 HTML 返回的完整耗时）
 * - 数据预取时间（getServerSideProps / getStaticProps 的耗时）
 * - React 渲染时间（renderToString / renderToPipeableStream 的耗时）
 * - HTML 组装时间（模板拼接、数据注入的耗时）
 *
 * 收集到的指标供 Reporter 上报，用于监控仪表盘展示和告警。
 */

import type { RenderContext, RenderResult } from '@nami/shared';

/**
 * 单次渲染的性能指标
 */
export interface PerformanceMetrics {
  /** 请求 URL */
  url: string;

  /** 请求唯一标识 */
  requestId: string;

  /** 渲染总耗时（毫秒） */
  totalDuration: number;

  /** 数据预取耗时（毫秒），如果没有数据预取则为 0 */
  dataFetchDuration: number;

  /** React 渲染耗时（毫秒） */
  renderDuration: number;

  /** HTML 组装耗时（毫秒） */
  htmlAssemblyDuration: number;

  /** 实际使用的渲染模式 */
  renderMode: string;

  /** 是否经历了降级 */
  degraded: boolean;

  /** 是否命中缓存 */
  cacheHit: boolean;

  /** 指标采集时间戳 */
  timestamp: number;
}

/**
 * 性能阈值配置
 * 超过阈值的指标将被标记为「慢」，触发告警
 */
export interface PerformanceThresholds {
  /**
   * 总渲染时间告警阈值（毫秒）
   * @default 3000
   */
  totalDuration?: number;

  /**
   * 数据预取时间告警阈值（毫秒）
   * @default 2000
   */
  dataFetchDuration?: number;

  /**
   * React 渲染时间告警阈值（毫秒）
   * @default 1000
   */
  renderDuration?: number;
}

/**
 * 性能指标收集器
 *
 * 从渲染上下文（RenderContext）和渲染结果（RenderResult）中
 * 提取性能计时数据，组装为结构化的性能指标。
 *
 * @example
 * ```typescript
 * const collector = new PerformanceCollector({
 *   thresholds: { totalDuration: 3000 },
 * });
 *
 * const metrics = collector.collect(context, result);
 * if (collector.isSlowRender(metrics)) {
 *   logger.warn('慢渲染', metrics);
 * }
 * ```
 */
export class PerformanceCollector {
  /** 性能阈值配置 */
  private readonly thresholds: Required<PerformanceThresholds>;

  /** 已收集的指标缓冲区 */
  private buffer: PerformanceMetrics[] = [];

  /** 缓冲区最大容量 */
  private readonly maxBufferSize: number;

  constructor(options: {
    thresholds?: PerformanceThresholds;
    maxBufferSize?: number;
  } = {}) {
    this.thresholds = {
      totalDuration: options.thresholds?.totalDuration ?? 3000,
      dataFetchDuration: options.thresholds?.dataFetchDuration ?? 2000,
      renderDuration: options.thresholds?.renderDuration ?? 1000,
    };
    this.maxBufferSize = options.maxBufferSize ?? 1000;
  }

  /**
   * 从渲染上下文和结果中收集性能指标
   *
   * 解析 RenderContext.timing 和 RenderResult.meta 中的计时数据，
   * 组装为结构化的 PerformanceMetrics 对象。
   *
   * @param context - 渲染上下文
   * @param result - 渲染结果
   * @returns 性能指标对象
   */
  collect(context: RenderContext, result: RenderResult): PerformanceMetrics {
    const { timing } = context;
    const { meta } = result;

    // 计算各阶段耗时
    // 数据预取耗时
    const dataFetchDuration = meta.dataFetchDuration ?? 0;

    // React 渲染耗时
    const renderDuration = meta.renderDuration ?? 0;

    // HTML 组装耗时：总时间 - 数据预取 - 渲染
    // 如果计算出负数（可能因为计时精度问题），取 0
    const htmlAssemblyDuration = Math.max(
      0,
      meta.duration - dataFetchDuration - renderDuration,
    );

    const metrics: PerformanceMetrics = {
      url: context.url,
      requestId: context.requestId,
      totalDuration: meta.duration,
      dataFetchDuration,
      renderDuration,
      htmlAssemblyDuration,
      renderMode: meta.renderMode,
      degraded: meta.degraded,
      cacheHit: meta.cacheHit ?? false,
      timestamp: timing.startTime,
    };

    // 将指标加入缓冲区
    this.addToBuffer(metrics);

    return metrics;
  }

  /**
   * 判断是否为慢渲染
   *
   * 任一指标超过对应阈值即视为慢渲染。
   *
   * @param metrics - 性能指标
   * @returns 是否为慢渲染
   */
  isSlowRender(metrics: PerformanceMetrics): boolean {
    return (
      metrics.totalDuration > this.thresholds.totalDuration ||
      metrics.dataFetchDuration > this.thresholds.dataFetchDuration ||
      metrics.renderDuration > this.thresholds.renderDuration
    );
  }

  /**
   * 获取超过阈值的指标项
   *
   * 返回具体哪些指标超标，便于定位慢渲染的瓶颈。
   *
   * @param metrics - 性能指标
   * @returns 超标的指标名称及对应值
   */
  getSlowParts(metrics: PerformanceMetrics): Array<{
    name: string;
    value: number;
    threshold: number;
  }> {
    const slowParts: Array<{ name: string; value: number; threshold: number }> = [];

    if (metrics.totalDuration > this.thresholds.totalDuration) {
      slowParts.push({
        name: 'totalDuration',
        value: metrics.totalDuration,
        threshold: this.thresholds.totalDuration,
      });
    }

    if (metrics.dataFetchDuration > this.thresholds.dataFetchDuration) {
      slowParts.push({
        name: 'dataFetchDuration',
        value: metrics.dataFetchDuration,
        threshold: this.thresholds.dataFetchDuration,
      });
    }

    if (metrics.renderDuration > this.thresholds.renderDuration) {
      slowParts.push({
        name: 'renderDuration',
        value: metrics.renderDuration,
        threshold: this.thresholds.renderDuration,
      });
    }

    return slowParts;
  }

  /**
   * 获取缓冲区中的所有指标并清空缓冲区
   *
   * 供 Reporter 批量获取并上报。
   *
   * @returns 所有已缓冲的性能指标
   */
  flush(): PerformanceMetrics[] {
    const metrics = [...this.buffer];
    this.buffer = [];
    return metrics;
  }

  /**
   * 获取缓冲区中的指标数量
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * 将指标加入缓冲区
   *
   * 当缓冲区满时，丢弃最旧的指标（FIFO）。
   */
  private addToBuffer(metrics: PerformanceMetrics): void {
    if (this.buffer.length >= this.maxBufferSize) {
      // 缓冲区已满，丢弃最旧的 10% 条目
      const dropCount = Math.floor(this.maxBufferSize * 0.1);
      this.buffer = this.buffer.slice(dropCount);
    }
    this.buffer.push(metrics);
  }
}
