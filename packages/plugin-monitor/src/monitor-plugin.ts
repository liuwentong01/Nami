/**
 * @nami/plugin-monitor - 监控插件主体
 *
 * NamiMonitorPlugin 是 Nami 框架的官方监控插件，提供全方位的运行时监控能力：
 *
 * 1. 性能监控：采集服务端渲染各阶段的耗时指标
 * 2. 错误监控：收集和分类渲染错误，追踪错误趋势
 * 3. 渲染指标：统计渲染模式分布、降级率、缓存命中率
 * 4. 客户端性能：采集 Web Vitals 指标（LCP、FID、CLS 等）
 * 5. 数据上报：通过 Beacon/HTTP 将指标批量发送到监控后端
 *
 * 插件在以下生命周期钩子中工作：
 * - onAfterRender:  采集服务端渲染性能和状态指标
 * - onRenderError:  采集渲染错误
 * - onHydrated:     采集客户端 Web Vitals 指标
 * - onDispose:      上报剩余数据并清理资源
 */

import type {
  NamiPlugin,
  PluginAPI,
  RenderContext,
  RenderResult,
} from '@nami/shared';
import { PerformanceCollector, type PerformanceThresholds } from './collectors/performance';
import { ErrorCollector, type ErrorCollectorOptions } from './collectors/error';
import { RenderMetricsCollector } from './collectors/render-metrics';
import { BeaconReporter, type BeaconReporterOptions } from './reporters/beacon-reporter';

/**
 * 监控插件配置选项
 */
export interface MonitorPluginOptions {
  /**
   * 上报接口 URL
   * 必填，所有监控数据将发送到此地址
   */
  endpoint: string;

  /**
   * 上报器配置
   * 可覆盖默认的批量间隔、重试策略等
   */
  reporterOptions?: Omit<BeaconReporterOptions, 'endpoint'>;

  /**
   * 性能阈值配置
   * 超过阈值的渲染将被标记为「慢渲染」
   */
  performanceThresholds?: PerformanceThresholds;

  /**
   * 错误收集器配置
   */
  errorCollectorOptions?: ErrorCollectorOptions;

  /**
   * 数据上报的定时刷新间隔（毫秒）
   * @default 30000（30 秒）
   */
  flushInterval?: number;

  /**
   * 是否启用客户端 Web Vitals 采集
   * @default true
   */
  enableWebVitals?: boolean;

  /**
   * 附加的元信息
   * 会随每次上报一并发送（如应用名称、版本号等）
   */
  meta?: Record<string, unknown>;

  /**
   * 是否启用监控
   * @default true
   */
  enabled?: boolean;
}

/**
 * Web Vitals 指标数据结构
 */
interface WebVitalsMetric {
  /** 指标名称 */
  name: string;
  /** 指标值 */
  value: number;
  /** 评级：good / needs-improvement / poor */
  rating: string;
  /** 采集时间戳 */
  timestamp: number;
}

/**
 * Nami 监控插件
 *
 * @example
 * ```typescript
 * import { NamiMonitorPlugin } from '@nami/plugin-monitor';
 *
 * export default {
 *   plugins: [
 *     new NamiMonitorPlugin({
 *       endpoint: 'https://monitor.example.com/api/report',
 *       performanceThresholds: {
 *         totalDuration: 3000,
 *         dataFetchDuration: 2000,
 *       },
 *       meta: {
 *         appName: 'my-app',
 *         appVersion: '1.0.0',
 *       },
 *     }),
 *   ],
 * };
 * ```
 */
export class NamiMonitorPlugin implements NamiPlugin {
  /** 插件唯一名称 */
  readonly name = 'nami:monitor';

  /** 插件版本号 */
  readonly version = '0.1.0';

  /**
   * 执行顺序：post（在其他插件之后执行）
   * 监控采集应在所有业务逻辑完成后执行，避免干扰业务
   */
  readonly enforce = 'post' as const;

  /** 性能收集器 */
  private readonly performanceCollector: PerformanceCollector;

  /** 错误收集器 */
  private readonly errorCollector: ErrorCollector;

  /** 渲染指标收集器 */
  private readonly renderMetricsCollector: RenderMetricsCollector;

  /** 数据上报器 */
  private readonly reporter: BeaconReporter;

  /** 定时刷新器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** 插件配置 */
  private readonly options: MonitorPluginOptions;

  constructor(options: MonitorPluginOptions) {
    this.options = options;

    // 初始化性能收集器
    this.performanceCollector = new PerformanceCollector({
      thresholds: options.performanceThresholds,
    });

    // 初始化错误收集器
    this.errorCollector = new ErrorCollector(options.errorCollectorOptions);

    // 初始化渲染指标收集器
    this.renderMetricsCollector = new RenderMetricsCollector();

    // 初始化上报器
    this.reporter = new BeaconReporter({
      endpoint: options.endpoint,
      ...options.reporterOptions,
    });

    // 设置附加元信息
    if (options.meta) {
      this.reporter.setMeta(options.meta);
    }
  }

  /**
   * 插件初始化
   *
   * 注册各生命周期钩子并启动定时上报。
   *
   * @param api - 插件 API
   */
  async setup(api: PluginAPI): Promise<void> {
    const logger = api.getLogger();
    const enabled = this.options.enabled ?? true;

    if (!enabled) {
      logger.info('[NamiMonitor] 监控插件已禁用');
      return;
    }

    logger.info('[NamiMonitor] 监控插件初始化', {
      endpoint: this.options.endpoint,
    });

    // ==================== 渲染后：采集性能和状态指标 ====================
    api.onAfterRender(async (context: RenderContext, result: RenderResult) => {
      try {
        // 采集性能指标
        const perfMetrics = this.performanceCollector.collect(context, result);

        // 检查是否为慢渲染，记录警告日志
        if (this.performanceCollector.isSlowRender(perfMetrics)) {
          const slowParts = this.performanceCollector.getSlowParts(perfMetrics);
          logger.warn('[NamiMonitor] 检测到慢渲染', {
            url: context.url,
            duration: perfMetrics.totalDuration,
            slowParts: slowParts.map((p) => `${p.name}: ${p.value}ms > ${p.threshold}ms`),
          });
        }

        // 采集渲染状态指标
        this.renderMetricsCollector.collect(context, result);
      } catch (error) {
        // 监控采集不应影响渲染流程
        logger.debug('[NamiMonitor] 指标采集失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // ==================== 渲染错误：采集错误指标 ====================
    api.onRenderError(async (context: RenderContext, error: Error) => {
      try {
        this.errorCollector.collectRenderError(context, error);

        logger.debug('[NamiMonitor] 渲染错误已采集', {
          url: context.url,
          error: error.message,
        });
      } catch (collectError) {
        logger.debug('[NamiMonitor] 错误采集失败', {
          error: collectError instanceof Error ? collectError.message : String(collectError),
        });
      }
    });

    // ==================== Hydration 完成：采集客户端 Web Vitals ====================
    if (this.options.enableWebVitals !== false) {
      api.onHydrated(async () => {
        try {
          this.collectWebVitals();
        } catch (error) {
          logger.debug('[NamiMonitor] Web Vitals 采集失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // ==================== 启动定时上报 ====================
    this.startPeriodicFlush(logger);

    // ==================== 插件销毁 ====================
    api.onDispose(async () => {
      await this.dispose(logger);
    });
  }

  /**
   * 启动定时上报
   *
   * 每隔指定时间从各收集器中取出数据，提交给上报器。
   */
  private startPeriodicFlush(logger: ReturnType<PluginAPI['getLogger']>): void {
    const interval = this.options.flushInterval ?? 30000;

    this.flushTimer = setInterval(() => {
      this.flushCollectors(logger).catch(() => {
        // 定时刷新的错误静默处理
      });
    }, interval);

    // 确保定时器不阻止进程退出
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * 从各收集器刷新数据到上报器
   */
  private async flushCollectors(logger: ReturnType<PluginAPI['getLogger']>): Promise<void> {
    try {
      // 1. 刷新性能指标
      const perfMetrics = this.performanceCollector.flush();
      if (perfMetrics.length > 0) {
        this.reporter.report('performance', perfMetrics);
      }

      // 2. 刷新错误记录
      const errorRecords = this.errorCollector.flush();
      if (errorRecords.length > 0) {
        this.reporter.report('error', errorRecords);
      }

      // 3. 刷新渲染指标
      const renderMetrics = this.renderMetricsCollector.flush();
      if (renderMetrics.length > 0) {
        this.reporter.report('render', renderMetrics);
      }

      // 4. 附加聚合摘要
      const summary = {
        performance: { bufferSize: perfMetrics.length },
        errors: this.errorCollector.getSummary(),
        render: this.renderMetricsCollector.getSummary(),
      };
      this.reporter.report('summary', [summary]);

      // 5. 触发上报器发送
      await this.reporter.flush();

      logger.debug('[NamiMonitor] 定时上报完成', {
        perfCount: perfMetrics.length,
        errorCount: errorRecords.length,
        renderCount: renderMetrics.length,
      });
    } catch (error) {
      logger.warn('[NamiMonitor] 定时上报失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 采集客户端 Web Vitals 指标
   *
   * Web Vitals 是 Google 定义的核心网页性能指标：
   * - LCP (Largest Contentful Paint): 最大内容渲染时间
   * - FID (First Input Delay): 首次输入延迟
   * - CLS (Cumulative Layout Shift): 累计布局偏移
   * - FCP (First Contentful Paint): 首次内容渲染时间
   * - TTFB (Time to First Byte): 首字节时间
   *
   * 仅在浏览器环境下执行。
   */
  private collectWebVitals(): void {
    // 仅在浏览器环境执行
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
      return;
    }

    // 采集 LCP（最大内容渲染时间）
    this.observePerformanceEntry('largest-contentful-paint', (entries) => {
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        this.reportWebVital({
          name: 'LCP',
          value: lastEntry.startTime,
          rating: this.rateLCP(lastEntry.startTime),
          timestamp: Date.now(),
        });
      }
    });

    // 采集 FID（首次输入延迟）
    this.observePerformanceEntry('first-input', (entries) => {
      const firstEntry = entries[0] as PerformanceEventTiming | undefined;
      if (firstEntry) {
        const fid = firstEntry.processingStart - firstEntry.startTime;
        this.reportWebVital({
          name: 'FID',
          value: fid,
          rating: this.rateFID(fid),
          timestamp: Date.now(),
        });
      }
    });

    // 采集 CLS（累计布局偏移）
    let clsValue = 0;
    this.observePerformanceEntry('layout-shift', (entries) => {
      for (const entry of entries) {
        // 仅计算非用户交互触发的布局偏移
        if (!(entry as LayoutShiftEntry).hadRecentInput) {
          clsValue += (entry as LayoutShiftEntry).value;
        }
      }
      this.reportWebVital({
        name: 'CLS',
        value: clsValue,
        rating: this.rateCLS(clsValue),
        timestamp: Date.now(),
      });
    });

    // 采集 FCP（首次内容渲染时间）
    this.observePerformanceEntry('paint', (entries) => {
      const fcpEntry = entries.find((e) => e.name === 'first-contentful-paint');
      if (fcpEntry) {
        this.reportWebVital({
          name: 'FCP',
          value: fcpEntry.startTime,
          rating: this.rateFCP(fcpEntry.startTime),
          timestamp: Date.now(),
        });
      }
    });

    // 采集 TTFB（首字节时间）
    // TTFB 可从 Navigation Timing API 获取
    if (typeof performance !== 'undefined' && performance.getEntriesByType) {
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (navEntries.length > 0 && navEntries[0]) {
        const ttfb = navEntries[0].responseStart - navEntries[0].requestStart;
        this.reportWebVital({
          name: 'TTFB',
          value: ttfb,
          rating: this.rateTTFB(ttfb),
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * 观察指定类型的 PerformanceEntry
   *
   * 封装 PerformanceObserver API，自动处理浏览器兼容性。
   */
  private observePerformanceEntry(
    entryType: string,
    callback: (entries: PerformanceEntry[]) => void,
  ): void {
    try {
      const observer = new PerformanceObserver((list) => {
        callback(list.getEntries());
      });
      observer.observe({ type: entryType, buffered: true });
    } catch {
      // 当前浏览器不支持此 entryType，静默忽略
    }
  }

  /**
   * 上报 Web Vital 指标
   */
  private reportWebVital(metric: WebVitalsMetric): void {
    this.reporter.report('web-vitals', [metric]);
  }

  // ==================== Web Vitals 评级函数 ====================
  // 基于 Google 的 Web Vitals 阈值标准

  /** LCP 评级：<2.5s 好, <4s 需改进, >=4s 差 */
  private rateLCP(value: number): string {
    if (value <= 2500) return 'good';
    if (value <= 4000) return 'needs-improvement';
    return 'poor';
  }

  /** FID 评级：<100ms 好, <300ms 需改进, >=300ms 差 */
  private rateFID(value: number): string {
    if (value <= 100) return 'good';
    if (value <= 300) return 'needs-improvement';
    return 'poor';
  }

  /** CLS 评级：<0.1 好, <0.25 需改进, >=0.25 差 */
  private rateCLS(value: number): string {
    if (value <= 0.1) return 'good';
    if (value <= 0.25) return 'needs-improvement';
    return 'poor';
  }

  /** FCP 评级：<1.8s 好, <3s 需改进, >=3s 差 */
  private rateFCP(value: number): string {
    if (value <= 1800) return 'good';
    if (value <= 3000) return 'needs-improvement';
    return 'poor';
  }

  /** TTFB 评级：<800ms 好, <1.8s 需改进, >=1.8s 差 */
  private rateTTFB(value: number): string {
    if (value <= 800) return 'good';
    if (value <= 1800) return 'needs-improvement';
    return 'poor';
  }

  /**
   * 销毁插件
   *
   * 停止定时上报，刷新剩余数据，清理资源。
   */
  private async dispose(logger: ReturnType<PluginAPI['getLogger']>): Promise<void> {
    // 停止定时器
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 最后一次刷新
    try {
      await this.flushCollectors(logger);
    } catch {
      // 销毁时的错误不需要处理
    }

    // 销毁上报器
    await this.reporter.dispose();

    logger.info('[NamiMonitor] 监控插件已销毁');
  }

  // ==================== 公开的读取接口 ====================

  /** 获取性能收集器（可用于外部查询指标） */
  getPerformanceCollector(): PerformanceCollector {
    return this.performanceCollector;
  }

  /** 获取错误收集器 */
  getErrorCollector(): ErrorCollector {
    return this.errorCollector;
  }

  /** 获取渲染指标收集器 */
  getRenderMetricsCollector(): RenderMetricsCollector {
    return this.renderMetricsCollector;
  }
}

// ==================== 浏览器 API 类型补充 ====================
// 这些类型在 TypeScript 标准 DOM 定义中可能缺失

/** Layout Shift 条目 */
interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

/** PerformanceEventTiming 条目（FID） */
interface PerformanceEventTiming extends PerformanceEntry {
  processingStart: number;
}
