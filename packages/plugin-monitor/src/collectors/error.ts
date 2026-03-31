/**
 * @nami/plugin-monitor - 错误收集器
 *
 * 收集和分类渲染流程中产生的错误，包括：
 * - 渲染错误（SSR 失败、Hydration 不匹配等）
 * - 数据预取错误（API 超时、网络错误等）
 * - 插件错误（钩子执行失败等）
 *
 * 错误按类型和严重等级分类，供上报系统使用。
 * 同时维护错误计数器，用于健康度评估和熔断判断。
 */

import type { RenderContext } from '@nami/shared';
import { NamiError, ErrorSeverity } from '@nami/shared';

/**
 * 错误类型分类
 */
export enum ErrorType {
  /** 渲染错误 */
  Render = 'render',
  /** 数据预取错误 */
  DataFetch = 'data_fetch',
  /** 缓存错误 */
  Cache = 'cache',
  /** 路由错误 */
  Route = 'route',
  /** 插件错误 */
  Plugin = 'plugin',
  /** 客户端错误 */
  Client = 'client',
  /** 未分类错误 */
  Unknown = 'unknown',
}

/**
 * 结构化错误记录
 */
export interface ErrorRecord {
  /** 错误类型 */
  type: ErrorType;

  /** 严重等级 */
  severity: ErrorSeverity;

  /** 错误消息 */
  message: string;

  /** 错误堆栈（生产环境可能为空） */
  stack?: string;

  /** 错误码（如果是 NamiError） */
  code?: number;

  /** 关联的请求 URL */
  url?: string;

  /** 关联的请求 ID */
  requestId?: string;

  /** 附加上下文信息 */
  context: Record<string, unknown>;

  /** 错误发生时间戳 */
  timestamp: number;
}

/**
 * 错误统计摘要
 */
export interface ErrorSummary {
  /** 各类型错误计数 */
  byType: Record<ErrorType, number>;

  /** 各严重等级错误计数 */
  bySeverity: Record<ErrorSeverity, number>;

  /** 总错误数 */
  total: number;

  /** 统计时间窗口开始时间 */
  windowStart: number;

  /** 统计时间窗口结束时间 */
  windowEnd: number;
}

/**
 * 错误收集器配置
 */
export interface ErrorCollectorOptions {
  /**
   * 错误缓冲区最大容量
   * @default 500
   */
  maxBufferSize?: number;

  /**
   * 是否在生产环境收集错误堆栈
   * 生产环境的堆栈可能包含源码路径，需考虑安全性
   * @default false
   */
  collectStackInProduction?: boolean;

  /**
   * 错误采样率（0-1）
   * 高流量场景下可降低采样率以减少上报量
   * 1 表示全量采集，0.1 表示采集 10%
   * @default 1
   */
  sampleRate?: number;
}

/**
 * 错误收集器
 *
 * 接收错误对象，将其分类、结构化后存入缓冲区，
 * 供 Reporter 批量获取并上报。
 *
 * @example
 * ```typescript
 * const collector = new ErrorCollector({ maxBufferSize: 500 });
 *
 * // 收集渲染错误
 * collector.collectRenderError(context, error);
 *
 * // 获取错误摘要
 * const summary = collector.getSummary();
 * console.log(`错误总数: ${summary.total}`);
 *
 * // 批量获取并清空
 * const errors = collector.flush();
 * ```
 */
export class ErrorCollector {
  /** 错误缓冲区 */
  private buffer: ErrorRecord[] = [];

  /** 缓冲区最大容量 */
  private readonly maxBufferSize: number;

  /** 是否收集堆栈 */
  private readonly collectStack: boolean;

  /** 采样率 */
  private readonly sampleRate: number;

  /** 各类型错误计数器（不受采样率影响） */
  private readonly typeCounters: Map<ErrorType, number> = new Map();

  /** 各严重等级错误计数器（不受采样率影响） */
  private readonly severityCounters: Map<ErrorSeverity, number> = new Map();

  /** 总错误计数（不受采样率影响） */
  private totalCount: number = 0;

  /** 统计窗口开始时间 */
  private windowStart: number = Date.now();

  constructor(options: ErrorCollectorOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 500;
    this.sampleRate = Math.min(1, Math.max(0, options.sampleRate ?? 1));

    // 决定是否收集堆栈信息
    const isProduction = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
    this.collectStack = isProduction
      ? (options.collectStackInProduction ?? false)
      : true;
  }

  /**
   * 收集渲染错误
   *
   * 当 SSR 渲染过程中发生错误时调用。
   * 自动从 NamiError 中提取错误码和严重等级。
   *
   * @param context - 渲染上下文
   * @param error - 错误对象
   */
  collectRenderError(context: RenderContext, error: Error): void {
    const type = ErrorType.Render;
    const severity = this.extractSeverity(error);

    this.addRecord({
      type,
      severity,
      message: error.message,
      stack: this.collectStack ? error.stack : undefined,
      code: error instanceof NamiError ? error.code : undefined,
      url: context.url,
      requestId: context.requestId,
      context: {
        renderMode: context.route?.renderMode,
        path: context.path,
        ...(error instanceof NamiError ? error.context : {}),
      },
      timestamp: Date.now(),
    });
  }

  /**
   * 收集通用错误
   *
   * 用于收集非渲染阶段的错误（如插件错误、客户端错误等）。
   *
   * @param error - 错误对象
   * @param type - 错误类型
   * @param extraContext - 附加上下文
   */
  collectError(
    error: Error,
    type: ErrorType = ErrorType.Unknown,
    extraContext: Record<string, unknown> = {},
  ): void {
    const severity = this.extractSeverity(error);

    this.addRecord({
      type,
      severity,
      message: error.message,
      stack: this.collectStack ? error.stack : undefined,
      code: error instanceof NamiError ? error.code : undefined,
      context: {
        ...(error instanceof NamiError ? error.context : {}),
        ...extraContext,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * 获取错误统计摘要
   *
   * 返回按类型和严重等级汇总的错误计数。
   * 计数不受采样率影响，反映真实的错误数量。
   */
  getSummary(): ErrorSummary {
    const byType = {} as Record<ErrorType, number>;
    const bySeverity = {} as Record<ErrorSeverity, number>;

    // 初始化所有类型计数为 0
    for (const type of Object.values(ErrorType)) {
      byType[type] = this.typeCounters.get(type) ?? 0;
    }

    // 初始化所有严重等级计数为 0
    for (const severity of Object.values(ErrorSeverity)) {
      bySeverity[severity] = this.severityCounters.get(severity) ?? 0;
    }

    return {
      byType,
      bySeverity,
      total: this.totalCount,
      windowStart: this.windowStart,
      windowEnd: Date.now(),
    };
  }

  /**
   * 获取缓冲区中的所有错误记录并清空缓冲区
   *
   * @returns 所有已缓冲的错误记录
   */
  flush(): ErrorRecord[] {
    const records = [...this.buffer];
    this.buffer = [];
    return records;
  }

  /**
   * 重置统计计数器
   *
   * 开始新的统计窗口。通常在定期上报后调用。
   */
  resetCounters(): void {
    this.typeCounters.clear();
    this.severityCounters.clear();
    this.totalCount = 0;
    this.windowStart = Date.now();
  }

  /**
   * 获取缓冲区中的错误记录数量
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * 添加错误记录到缓冲区
   *
   * 更新计数器（不受采样率影响），
   * 然后根据采样率决定是否写入缓冲区。
   */
  private addRecord(record: ErrorRecord): void {
    // 计数器始终更新，不受采样率影响
    this.totalCount++;
    this.typeCounters.set(
      record.type,
      (this.typeCounters.get(record.type) ?? 0) + 1,
    );
    this.severityCounters.set(
      record.severity,
      (this.severityCounters.get(record.severity) ?? 0) + 1,
    );

    // 采样判断：严重和致命错误始终采集，其他按采样率
    const shouldSample =
      record.severity === ErrorSeverity.Fatal ||
      record.severity === ErrorSeverity.Error ||
      Math.random() < this.sampleRate;

    if (!shouldSample) return;

    // 缓冲区容量控制
    if (this.buffer.length >= this.maxBufferSize) {
      // 丢弃最旧的 10% 条目
      const dropCount = Math.floor(this.maxBufferSize * 0.1);
      this.buffer = this.buffer.slice(dropCount);
    }

    this.buffer.push(record);
  }

  /**
   * 从错误对象中提取严重等级
   *
   * NamiError 自带 severity，普通 Error 默认为 Error 级别。
   */
  private extractSeverity(error: Error): ErrorSeverity {
    if (error instanceof NamiError) {
      return error.severity;
    }
    return ErrorSeverity.Error;
  }
}
