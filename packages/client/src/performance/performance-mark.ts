/**
 * @nami/client - 性能标记工具
 *
 * 本模块提供框架级别的性能标记（Performance Mark）和测量（Performance Measure）能力。
 * 基于 Performance Timeline API（performance.mark / performance.measure），
 * 帮助开发者和框架内部测量关键操作的耗时。
 *
 * 使用场景：
 * - 框架内部：标记 Hydration 开始/结束、路由切换、数据加载等关键时间点
 * - 业务方：标记自定义的性能关键路径（如首屏渲染、弹窗展示等）
 * - DevTools：在 Chrome Performance 面板中可视化查看所有 Nami 标记
 *
 * 命名规范：
 * 所有 Nami 框架的性能标记都以 'nami:' 前缀命名，
 * 便于在 Performance 面板中过滤查看。
 *
 * @module
 */

import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * 性能标记条目
 */
export interface NamiPerformanceMark {
  /** 标记名称（含 'nami:' 前缀） */
  name: string;
  /** 标记时间戳（相对于 navigationStart，单位毫秒） */
  startTime: number;
  /** 标记的绝对时间戳 */
  timestamp: number;
}

/**
 * 性能测量结果
 */
export interface NamiPerformanceMeasure {
  /** 测量名称 */
  name: string;
  /** 起始标记名称 */
  startMark: string;
  /** 结束标记名称 */
  endMark: string;
  /** 起始时间 */
  startTime: number;
  /** 持续时间（毫秒） */
  duration: number;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:performance-mark');

/** Nami 性能标记的统一前缀 */
const NAMI_MARK_PREFIX = 'nami:';

/**
 * 检查 Performance API 是否可用
 *
 * 某些环境（如 Node.js SSR、旧浏览器）可能不支持完整的 Performance API。
 */
function isPerformanceAvailable(): boolean {
  return (
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function' &&
    typeof performance.measure === 'function'
  );
}

// ==================== 公共 API ====================

/**
 * 创建 Nami 性能标记
 *
 * 在 Performance Timeline 中创建一个命名标记，
 * 后续可以用 measureBetween 测量两个标记之间的耗时。
 *
 * 标记会自动添加 'nami:' 前缀，便于在 Chrome DevTools 中过滤。
 *
 * @param name - 标记名称（不需要包含 'nami:' 前缀，会自动添加）
 * @returns 标记信息对象，如果 Performance API 不可用返回 null
 *
 * @example
 * ```typescript
 * // 标记 Hydration 开始
 * markNamiEvent('hydration-start');
 *
 * // ... Hydration 过程 ...
 *
 * // 标记 Hydration 结束
 * markNamiEvent('hydration-end');
 *
 * // 测量 Hydration 耗时
 * const measure = measureBetween('hydration-start', 'hydration-end');
 * console.log(`Hydration 耗时: ${measure?.duration}ms`);
 * ```
 */
export function markNamiEvent(name: string): NamiPerformanceMark | null {
  if (!isPerformanceAvailable()) {
    logger.debug('Performance API 不可用，跳过标记', { name });
    return null;
  }

  const fullName = `${NAMI_MARK_PREFIX}${name}`;

  try {
    performance.mark(fullName);

    const mark: NamiPerformanceMark = {
      name: fullName,
      startTime: performance.now(),
      timestamp: Date.now(),
    };

    logger.debug('创建性能标记', { name: fullName, startTime: mark.startTime });
    return mark;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('创建性能标记失败', { name: fullName, error: message });
    return null;
  }
}

/**
 * 测量两个标记之间的耗时
 *
 * 使用 performance.measure 计算从 startMark 到 endMark 的持续时间。
 * 两个标记必须都已通过 markNamiEvent 创建。
 *
 * @param startName - 起始标记名称（不含 'nami:' 前缀）
 * @param endName   - 结束标记名称（不含 'nami:' 前缀）
 * @returns 测量结果，如果标记不存在或 API 不可用返回 null
 *
 * @example
 * ```typescript
 * markNamiEvent('route-change-start');
 * // ... 路由切换过程 ...
 * markNamiEvent('route-change-end');
 *
 * const result = measureBetween('route-change-start', 'route-change-end');
 * if (result) {
 *   console.log(`路由切换耗时: ${result.duration.toFixed(2)}ms`);
 * }
 * ```
 */
export function measureBetween(
  startName: string,
  endName: string,
): NamiPerformanceMeasure | null {
  if (!isPerformanceAvailable()) {
    return null;
  }

  const startMark = `${NAMI_MARK_PREFIX}${startName}`;
  const endMark = `${NAMI_MARK_PREFIX}${endName}`;
  const measureName = `${NAMI_MARK_PREFIX}${startName} -> ${endName}`;

  try {
    const measure = performance.measure(measureName, startMark, endMark);

    const result: NamiPerformanceMeasure = {
      name: measureName,
      startMark,
      endMark,
      startTime: measure.startTime,
      duration: measure.duration,
    };

    logger.debug('性能测量完成', {
      name: measureName,
      duration: `${measure.duration.toFixed(2)}ms`,
    });

    return result;
  } catch (error) {
    // 标记不存在时 measure 会抛出异常
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('性能测量失败', {
      startMark,
      endMark,
      error: message,
    });
    return null;
  }
}

/**
 * 获取所有 Nami 性能标记的时间线
 *
 * 返回当前页面中所有以 'nami:' 前缀的性能标记，
 * 按时间顺序排列。可用于构建完整的性能时间线视图。
 *
 * @returns 按时间排序的性能标记列表
 *
 * @example
 * ```typescript
 * const timeline = getTimeline();
 * for (const mark of timeline) {
 *   console.log(`[${mark.startTime.toFixed(2)}ms] ${mark.name}`);
 * }
 *
 * // 输出示例:
 * // [0.00ms]   nami:app-init
 * // [12.34ms]  nami:hydration-start
 * // [156.78ms] nami:hydration-end
 * // [200.00ms] nami:first-interaction
 * ```
 */
export function getTimeline(): NamiPerformanceMark[] {
  if (!isPerformanceAvailable()) {
    return [];
  }

  try {
    /**
     * performance.getEntriesByType('mark') 返回所有通过 performance.mark 创建的标记。
     * 我们通过 'nami:' 前缀过滤出框架相关的标记。
     */
    const allMarks = performance.getEntriesByType('mark');
    const namiMarks = allMarks
      .filter((mark) => mark.name.startsWith(NAMI_MARK_PREFIX))
      .map((mark) => ({
        name: mark.name,
        startTime: mark.startTime,
        timestamp: Date.now() - (performance.now() - mark.startTime),
      }))
      // 按时间顺序排列
      .sort((a, b) => a.startTime - b.startTime);

    logger.debug('获取性能时间线', { count: namiMarks.length });
    return namiMarks;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('获取性能时间线失败', { error: message });
    return [];
  }
}

/**
 * 清除所有 Nami 性能标记和测量
 *
 * 在长期运行的 SPA 中，过多的性能条目可能占用内存。
 * 定期清理可以释放资源。
 */
export function clearNamiMarks(): void {
  if (!isPerformanceAvailable()) return;

  try {
    // 获取所有 nami 标记并清除
    const allMarks = performance.getEntriesByType('mark');
    for (const mark of allMarks) {
      if (mark.name.startsWith(NAMI_MARK_PREFIX)) {
        performance.clearMarks(mark.name);
      }
    }

    // 获取所有 nami 测量并清除
    const allMeasures = performance.getEntriesByType('measure');
    for (const measure of allMeasures) {
      if (measure.name.startsWith(NAMI_MARK_PREFIX)) {
        performance.clearMeasures(measure.name);
      }
    }

    logger.debug('Nami 性能标记和测量已清除');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('清除性能标记失败', { error: message });
  }
}
