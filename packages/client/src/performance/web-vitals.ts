/**
 * @nami/client - Web Vitals 采集
 *
 * 本模块负责收集 Google 定义的 Web Vitals 核心指标，
 * 这些指标直接反映用户体验质量。
 *
 * 采集的指标：
 *
 * 1. LCP（Largest Contentful Paint）— 最大内容绘制
 *    衡量页面主要内容的加载速度。
 *    记录视口中最大的图片或文本块首次渲染完成的时间。
 *    良好: < 2.5s | 需改进: 2.5s - 4s | 较差: > 4s
 *
 * 2. FID（First Input Delay）— 首次输入延迟
 *    衡量页面的交互响应速度。
 *    记录用户首次交互（如点击按钮）到浏览器开始处理之间的延迟。
 *    良好: < 100ms | 需改进: 100ms - 300ms | 较差: > 300ms
 *
 * 3. CLS（Cumulative Layout Shift）— 累积布局偏移
 *    衡量页面视觉稳定性。
 *    记录页面生命周期内所有意外布局偏移的累积分数。
 *    良好: < 0.1 | 需改进: 0.1 - 0.25 | 较差: > 0.25
 *
 * 4. FCP（First Contentful Paint）— 首次内容绘制
 *    衡量浏览器首次渲染来自 DOM 的内容的时间。
 *
 * 5. TTFB（Time to First Byte）— 首字节时间
 *    衡量从请求发出到收到第一个字节响应的时间。
 *
 * 6. INP（Interaction to Next Paint）— 交互到下一次绘制
 *    衡量页面对所有用户交互的整体响应能力。
 *    记录最差的交互延迟（排除异常值后的最高延迟）。
 *    良好: < 200ms | 需改进: 200ms - 500ms | 较差: > 500ms
 *
 * 实现方式：
 * 使用 PerformanceObserver API 监听各类性能条目。
 * 每个指标采集到后通过回调函数上报。
 * 支持配置上报端点 URL，自动将指标发送到监控服务。
 *
 * @module
 */

import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * Web Vitals 指标名称
 */
export type WebVitalName = 'LCP' | 'FID' | 'CLS' | 'FCP' | 'TTFB' | 'INP';

/**
 * Web Vitals 指标数据
 */
export interface WebVitalMetric {
  /** 指标名称 */
  name: WebVitalName;

  /** 指标值（单位取决于指标类型） */
  value: number;

  /**
   * 指标评级
   * - 'good':             表现良好
   * - 'needs-improvement': 需要改进
   * - 'poor':             表现较差
   */
  rating: 'good' | 'needs-improvement' | 'poor';

  /** 指标条目（PerformanceEntry 列表） */
  entries: PerformanceEntry[];

  /** 采集时间戳 */
  timestamp: number;

  /** 页面 URL */
  url: string;
}

/**
 * Web Vitals 回调函数
 *
 * 每采集到一个指标时调用一次。
 */
export type WebVitalCallback = (metric: WebVitalMetric) => void;

/**
 * Web Vitals 采集选项
 */
export interface WebVitalsOptions {
  /**
   * 采样率（0 - 1）
   *
   * 1 = 全量采集，0.1 = 10% 采样。
   * 在高流量网站中使用采样可以减少上报量和对性能的影响。
   * @default 1
   */
  sampleRate?: number;

  /**
   * 指标上报端点 URL
   *
   * 配置后每采集到一个指标就自动上报到此端点。
   * 使用 navigator.sendBeacon 发送，确保页面卸载时也能可靠上报。
   * 如果不配置，仅通过 onMetric 回调通知调用方。
   */
  reportUrl?: string;

  /**
   * 指标回调函数
   *
   * 每采集到一个指标时调用。
   * 可用于自定义处理逻辑（如记录到本地、发送到自定义后端等）。
   */
  onMetric?: WebVitalCallback;

  /**
   * 是否采集 LCP
   * @default true
   */
  lcp?: boolean;

  /**
   * 是否采集 FID
   * @default true
   */
  fid?: boolean;

  /**
   * 是否采集 CLS
   * @default true
   */
  cls?: boolean;

  /**
   * 是否采集 FCP
   * @default true
   */
  fcp?: boolean;

  /**
   * 是否采集 TTFB
   * @default true
   */
  ttfb?: boolean;

  /**
   * 是否采集 INP
   * @default true
   */
  inp?: boolean;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:web-vitals');

/**
 * 已创建的 PerformanceObserver 列表
 *
 * 用于 cleanup 时断开所有观察器。
 */
const observers: PerformanceObserver[] = [];

/**
 * LCP 评级阈值
 */
function rateLCP(value: number): WebVitalMetric['rating'] {
  if (value <= 2500) return 'good';
  if (value <= 4000) return 'needs-improvement';
  return 'poor';
}

/**
 * FID 评级阈值
 */
function rateFID(value: number): WebVitalMetric['rating'] {
  if (value <= 100) return 'good';
  if (value <= 300) return 'needs-improvement';
  return 'poor';
}

/**
 * CLS 评级阈值
 */
function rateCLS(value: number): WebVitalMetric['rating'] {
  if (value <= 0.1) return 'good';
  if (value <= 0.25) return 'needs-improvement';
  return 'poor';
}

/**
 * FCP 评级阈值
 */
function rateFCP(value: number): WebVitalMetric['rating'] {
  if (value <= 1800) return 'good';
  if (value <= 3000) return 'needs-improvement';
  return 'poor';
}

/**
 * TTFB 评级阈值
 */
function rateTTFB(value: number): WebVitalMetric['rating'] {
  if (value <= 800) return 'good';
  if (value <= 1800) return 'needs-improvement';
  return 'poor';
}

/**
 * INP 评级阈值
 *
 * INP（Interaction to Next Paint）衡量所有交互的整体响应能力。
 * 阈值基于 Google 的 Web Vitals 建议：
 * 良好: <= 200ms | 需改进: 200ms - 500ms | 较差: > 500ms
 */
function rateINP(value: number): WebVitalMetric['rating'] {
  if (value <= 200) return 'good';
  if (value <= 500) return 'needs-improvement';
  return 'poor';
}

/**
 * 创建指标数据对象
 */
function createMetric(
  name: WebVitalName,
  value: number,
  rating: WebVitalMetric['rating'],
  entries: PerformanceEntry[],
): WebVitalMetric {
  return {
    name,
    value,
    rating,
    entries,
    timestamp: Date.now(),
    url: typeof window !== 'undefined' ? window.location.href : '',
  };
}

/**
 * 安全创建 PerformanceObserver
 *
 * 某些浏览器或环境可能不支持特定的 entryType，
 * 此函数会捕获异常并返回 null。
 */
function safeObserve(
  entryType: string,
  callback: (entries: PerformanceEntryList) => void,
  options?: { buffered?: boolean },
): PerformanceObserver | null {
  try {
    // 检查浏览器是否支持 PerformanceObserver
    if (typeof PerformanceObserver === 'undefined') {
      logger.debug('PerformanceObserver 不可用');
      return null;
    }

    // 检查是否支持指定的 entryType
    const supportedTypes = PerformanceObserver.supportedEntryTypes;
    if (supportedTypes && !supportedTypes.includes(entryType)) {
      logger.debug(`不支持的 entryType: ${entryType}`);
      return null;
    }

    const observer = new PerformanceObserver((entryList) => {
      callback(entryList.getEntries());
    });

    observer.observe({
      type: entryType,
      buffered: options?.buffered ?? true,
    });

    observers.push(observer);
    return observer;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`创建 PerformanceObserver 失败: ${entryType}`, { error: message });
    return null;
  }
}

/**
 * 将指标上报到配置的端点
 *
 * 优先使用 navigator.sendBeacon（页面卸载时也能可靠发送），
 * 降级使用 fetch。上报失败不影响应用运行。
 *
 * @param metric    - 要上报的指标数据
 * @param reportUrl - 上报端点 URL
 */
function reportMetricToEndpoint(metric: WebVitalMetric, reportUrl: string): void {
  try {
    const payload = JSON.stringify({
      type: 'web-vital',
      metric: {
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
        url: metric.url,
        timestamp: metric.timestamp,
      },
    });

    // 优先使用 sendBeacon — 可靠且不阻塞页面
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' });
      const sent = navigator.sendBeacon(reportUrl, blob);
      if (sent) {
        logger.debug(`${metric.name} 已通过 sendBeacon 上报`);
        return;
      }
    }

    // 降级使用 fetch
    if (typeof globalThis.fetch === 'function') {
      globalThis.fetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch((fetchError: Error) => {
        logger.warn(`${metric.name} 上报失败`, { error: fetchError.message });
      });
    }
  } catch (error) {
    // 上报失败不影响应用运行
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`指标上报异常: ${metric.name}`, { error: message });
  }
}

// ==================== 公共 API ====================

/**
 * 采集 Web Vitals 指标
 *
 * 启动 PerformanceObserver 监听各项性能指标，
 * 每采集到一个指标就通过回调函数通知调用方。
 * 支持自动上报到配置的监控端点。
 *
 * @param callback - 指标回调函数，每个指标采集到时调用一次
 * @param options  - 采集选项（控制采样率、上报端点和采集的指标）
 * @returns 清理函数 — 调用后断开所有观察器
 *
 * @example
 * ```typescript
 * // 基础用法 — 自定义回调
 * const cleanup = collectWebVitals((metric) => {
 *   console.log(`${metric.name}: ${metric.value} (${metric.rating})`);
 * });
 *
 * // 自动上报到监控端点
 * const cleanup = collectWebVitals(
 *   (metric) => console.log(metric),
 *   {
 *     reportUrl: 'https://monitor.example.com/api/vitals',
 *     sampleRate: 0.1,
 *   },
 * );
 *
 * // 使用 onMetric 回调 + 上报端点
 * const cleanup = collectWebVitals(() => {}, {
 *   reportUrl: '/api/metrics',
 *   onMetric: (metric) => {
 *     // 额外的自定义处理逻辑
 *     analyticsTracker.track('web_vital', metric);
 *   },
 *   fcp: false,  // 不采集 FCP
 *   ttfb: false, // 不采集 TTFB
 * });
 *
 * // 在应用卸载时清理
 * window.addEventListener('beforeunload', cleanup);
 * ```
 */
export function collectWebVitals(
  callback: WebVitalCallback,
  options: WebVitalsOptions = {},
): () => void {
  const {
    sampleRate = 1,
    reportUrl,
    onMetric,
    lcp: collectLCP = true,
    fid: collectFID = true,
    cls: collectCLS = true,
    fcp: collectFCP = true,
    ttfb: collectTTFB = true,
    inp: collectINP = true,
  } = options;

  // 采样率检查 — 在采集开始前决定此次页面访问是否参与采样
  if (Math.random() > sampleRate) {
    logger.debug('本次访问未被采样，跳过 Web Vitals 采集');
    return () => {};
  }

  // 浏览器环境检查
  if (typeof window === 'undefined') {
    logger.debug('非浏览器环境，跳过 Web Vitals 采集');
    return () => {};
  }

  logger.info('开始采集 Web Vitals');

  /**
   * 统一的指标分发函数
   *
   * 每个指标采集到后统一通过此函数分发：
   * 1. 调用主回调函数 callback
   * 2. 调用 onMetric 回调（如果配置了）
   * 3. 上报到配置的端点 URL（如果配置了）
   */
  const dispatchMetric = (metric: WebVitalMetric): void => {
    // 主回调
    callback(metric);

    // onMetric 回调
    onMetric?.(metric);

    // 自动上报到端点
    if (reportUrl) {
      reportMetricToEndpoint(metric, reportUrl);
    }
  };

  // -------- LCP（最大内容绘制）--------
  if (collectLCP) {
    safeObserve('largest-contentful-paint', (entries) => {
      // LCP 可能报告多次（随着更大的元素渲染完成而更新），
      // 最后一个条目是最终的 LCP 值
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        const value = lastEntry.startTime;
        const metric = createMetric('LCP', value, rateLCP(value), entries);
        dispatchMetric(metric);
        logger.debug('LCP 采集完成', { value, rating: metric.rating });
      }
    });
  }

  // -------- FID（首次输入延迟）--------
  if (collectFID) {
    safeObserve('first-input', (entries) => {
      const firstEntry = entries[0] as PerformanceEventTiming | undefined;
      if (firstEntry) {
        // FID = 事件处理开始时间 - 事件触发时间
        const value = firstEntry.processingStart - firstEntry.startTime;
        const metric = createMetric('FID', value, rateFID(value), entries);
        dispatchMetric(metric);
        logger.debug('FID 采集完成', { value, rating: metric.rating });
      }
    });
  }

  // -------- CLS（累积布局偏移）--------
  if (collectCLS) {
    let clsValue = 0;
    let clsEntries: PerformanceEntry[] = [];

    /**
     * CLS 是累积值，需要持续累加所有布局偏移条目。
     * 使用 Session Window 算法：
     * 只累加间隔不超过 1 秒且总窗口不超过 5 秒的偏移。
     */
    let sessionValue = 0;
    let sessionEntries: PerformanceEntry[] = [];
    let firstSessionEntry: number | undefined;
    let previousSessionEntry: number | undefined;

    safeObserve('layout-shift', (entries) => {
      for (const entry of entries) {
        const layoutShift = entry as PerformanceEntry & {
          hadRecentInput?: boolean;
          value?: number;
        };

        // 忽略用户输入引起的布局偏移（如键盘输入导致的页面变化）
        if (layoutShift.hadRecentInput) continue;

        const shiftValue = layoutShift.value ?? 0;

        // Session Window 算法
        if (
          firstSessionEntry === undefined ||
          entry.startTime - (previousSessionEntry ?? 0) >= 1000 ||
          entry.startTime - firstSessionEntry >= 5000
        ) {
          // 开始新的 Session
          if (sessionValue > clsValue) {
            clsValue = sessionValue;
            clsEntries = [...sessionEntries];
          }
          sessionValue = shiftValue;
          sessionEntries = [entry];
          firstSessionEntry = entry.startTime;
        } else {
          sessionValue += shiftValue;
          sessionEntries.push(entry);
        }
        previousSessionEntry = entry.startTime;
      }

      // 取最大的 Session 值作为 CLS
      const finalValue = Math.max(clsValue, sessionValue);
      const finalEntries = sessionValue > clsValue ? sessionEntries : clsEntries;

      const metric = createMetric('CLS', finalValue, rateCLS(finalValue), finalEntries);
      dispatchMetric(metric);
      logger.debug('CLS 更新', { value: finalValue, rating: metric.rating });
    });
  }

  // -------- FCP（首次内容绘制）--------
  if (collectFCP) {
    safeObserve('paint', (entries) => {
      const fcpEntry = entries.find(
        (entry) => entry.name === 'first-contentful-paint',
      );
      if (fcpEntry) {
        const value = fcpEntry.startTime;
        const metric = createMetric('FCP', value, rateFCP(value), [fcpEntry]);
        dispatchMetric(metric);
        logger.debug('FCP 采集完成', { value, rating: metric.rating });
      }
    });
  }

  // -------- TTFB（首字节时间）--------
  if (collectTTFB) {
    /**
     * TTFB 通过 Navigation Timing API 获取。
     * 使用 PerformanceObserver 监听 'navigation' 类型。
     */
    safeObserve('navigation', (entries) => {
      const navEntry = entries[0] as PerformanceNavigationTiming | undefined;
      if (navEntry) {
        const value = navEntry.responseStart - navEntry.requestStart;
        const metric = createMetric('TTFB', value, rateTTFB(value), [navEntry]);
        dispatchMetric(metric);
        logger.debug('TTFB 采集完成', { value, rating: metric.rating });
      }
    });
  }

  // -------- INP（交互到下一次绘制）--------
  if (collectINP) {
    /**
     * INP 测量所有用户交互（点击、触摸、键盘）的延迟，
     * 取排除异常值后的最大延迟作为最终指标值。
     *
     * 算法：
     * - 收集所有 event 类型的 PerformanceEntry
     * - 按 duration 排序
     * - 如果交互数量 >= 50，排除最高的一个（视为异常值）
     * - 取最高值作为 INP
     */
    const interactionDurations: Array<{ duration: number; entry: PerformanceEntry }> = [];

    safeObserve('event', (entries) => {
      for (const entry of entries) {
        const eventEntry = entry as PerformanceEventTiming;
        // 只关注有交互 ID 的事件（表示独立的用户交互）
        // duration > 0 排除无延迟的事件
        if (eventEntry.duration > 0) {
          interactionDurations.push({
            duration: eventEntry.duration,
            entry: eventEntry,
          });
        }
      }

      if (interactionDurations.length === 0) return;

      // 按 duration 降序排列
      const sorted = [...interactionDurations].sort(
        (a, b) => b.duration - a.duration,
      );

      // 排除异常值：交互数量 >= 50 时去掉最高的一个
      const index = sorted.length >= 50 ? 1 : 0;
      const worstInteraction = sorted[index];

      if (worstInteraction) {
        const value = worstInteraction.duration;
        const metric = createMetric('INP', value, rateINP(value), [worstInteraction.entry]);
        dispatchMetric(metric);
        logger.debug('INP 更新', { value, rating: metric.rating });
      }
    }, { buffered: true });
  }

  // 返回清理函数
  return () => {
    for (const observer of observers) {
      try {
        observer.disconnect();
      } catch {
        // 忽略断开连接时的错误
      }
    }
    observers.length = 0;
    logger.debug('Web Vitals 观察器已断开');
  };
}
