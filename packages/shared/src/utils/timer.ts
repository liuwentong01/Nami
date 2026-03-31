/**
 * @nami/shared - 性能计时工具
 *
 * 提供高精度计时能力，用于渲染流程各阶段的耗时统计。
 * 支持服务端（process.hrtime）和客户端（performance.now）。
 */

/**
 * 获取高精度时间戳（毫秒）
 */
function now(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  // Node.js 环境
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + nanoseconds / 1e6;
}

/**
 * 性能计时器
 *
 * 用于测量代码段执行耗时。
 *
 * @example
 * ```typescript
 * const timer = new Timer();
 *
 * timer.mark('dataFetch');
 * await fetchData();
 * timer.mark('dataFetchEnd');
 *
 * timer.mark('render');
 * const html = renderToString(app);
 * timer.mark('renderEnd');
 *
 * console.log(timer.duration('dataFetch', 'dataFetchEnd')); // 数据预取耗时
 * console.log(timer.total()); // 总耗时
 * ```
 */
export class Timer {
  private startTime: number;
  private marks: Map<string, number> = new Map();

  constructor() {
    this.startTime = now();
  }

  /**
   * 设置时间标记
   */
  mark(name: string): void {
    this.marks.set(name, now());
  }

  /**
   * 获取两个标记之间的耗时（毫秒）
   */
  duration(startMark: string, endMark: string): number {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);
    if (start === undefined || end === undefined) return -1;
    return Math.round((end - start) * 100) / 100;
  }

  /**
   * 获取从计时器创建到现在的总耗时（毫秒）
   */
  total(): number {
    return Math.round((now() - this.startTime) * 100) / 100;
  }

  /**
   * 获取从计时器创建到指定标记的耗时（毫秒）
   */
  elapsed(mark: string): number {
    const markTime = this.marks.get(mark);
    if (markTime === undefined) return -1;
    return Math.round((markTime - this.startTime) * 100) / 100;
  }

  /**
   * 获取所有标记的时间线
   * 返回按时间排序的 [标记名, 距起始的毫秒数] 列表
   */
  timeline(): Array<[string, number]> {
    return Array.from(this.marks.entries())
      .map(([name, time]) => [name, Math.round((time - this.startTime) * 100) / 100] as [string, number])
      .sort((a, b) => a[1] - b[1]);
  }

  /**
   * 重置计时器
   */
  reset(): void {
    this.startTime = now();
    this.marks.clear();
  }
}

/**
 * 便捷工厂函数
 */
export function createTimer(): Timer {
  return new Timer();
}

/**
 * 测量异步函数执行耗时
 *
 * @param fn - 要测量的异步函数
 * @returns [结果, 耗时毫秒数]
 */
export async function measureAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = now();
  const result = await fn();
  const duration = Math.round((now() - start) * 100) / 100;
  return [result, duration];
}
