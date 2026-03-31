/**
 * @nami/plugin-request - 超时拦截器
 *
 * 为请求添加超时控制能力。
 * 当请求在指定时间内未完成时，自动中断并抛出超时错误。
 *
 * 超时控制的重要性：
 * - SSR 场景：数据预取超时会阻塞整个页面渲染，必须有上限
 * - 客户端：长时间的 loading 状态严重影响用户体验
 * - 防止资源泄漏：未控制的请求可能导致连接池耗尽
 */

import type { RequestOptions, RequestResponse, RequestAdapter } from '../adapters/server-adapter';
import { RequestError } from '../adapters/server-adapter';

/**
 * 超时拦截器配置
 */
export interface TimeoutInterceptorOptions {
  /**
   * 默认超时时间（毫秒）
   * @default 10000（10 秒）
   */
  defaultTimeout?: number;

  /**
   * 超时后的回调
   * 可用于记录日志、触发告警等
   */
  onTimeout?: (url: string, timeout: number) => void;
}

/**
 * 超时拦截器
 *
 * 包装请求适配器，确保所有请求都有超时上限。
 * 如果请求选项中已指定 timeout，使用请求级别的超时；
 * 否则使用拦截器的默认超时。
 *
 * @example
 * ```typescript
 * const timeout = new TimeoutInterceptor({ defaultTimeout: 5000 });
 *
 * // 使用默认 5 秒超时
 * const res1 = await timeout.execute(adapter, '/api/data');
 *
 * // 使用请求级别的 3 秒超时
 * const res2 = await timeout.execute(adapter, '/api/data', { timeout: 3000 });
 * ```
 */
export class TimeoutInterceptor {
  /** 默认超时时间 */
  private readonly defaultTimeout: number;

  /** 超时回调 */
  private readonly onTimeout?: (url: string, timeout: number) => void;

  constructor(options: TimeoutInterceptorOptions = {}) {
    this.defaultTimeout = options.defaultTimeout ?? 10000;
    this.onTimeout = options.onTimeout;
  }

  /**
   * 执行带超时控制的请求
   *
   * 通过 AbortController 实现超时中断。
   * 当请求超时时，底层的 fetch 连接会被真正中断（而非仅仅忽略响应）。
   *
   * @param adapter - 请求适配器
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 响应数据
   * @throws TimeoutError 当请求超时时
   */
  async execute<T = unknown>(
    adapter: RequestAdapter,
    url: string,
    options: RequestOptions = {},
  ): Promise<RequestResponse<T>> {
    // 确定超时时间（请求级别优先）
    const timeout = options.timeout ?? this.defaultTimeout;

    // 创建 AbortController 用于超时中断
    const controller = new AbortController();

    // 如果外部已提供 signal，需要将两个 signal 合并
    // 任一个触发 abort 都应中断请求
    if (options.signal) {
      // 监听外部 signal 的 abort 事件
      const externalSignal = options.signal;
      if (externalSignal.aborted) {
        // 外部已经取消了，直接抛出
        throw new RequestError('请求已取消', { isCancelled: true, config: options });
      }
      externalSignal.addEventListener('abort', () => controller.abort());
    }

    // 设置超时定时器
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      // 将内部的 signal 传递给适配器
      const result = await adapter.request<T>(url, {
        ...options,
        signal: controller.signal,
        timeout: undefined, // 超时由拦截器控制，不传给适配器
      });

      return result;
    } catch (error) {
      // 判断是否为超时导致的 abort
      if (
        error instanceof RequestError && error.isTimeout ||
        (error instanceof DOMException && error.name === 'AbortError' && !options.signal?.aborted)
      ) {
        // 触发超时回调
        this.onTimeout?.(url, timeout);

        throw new RequestError(`请求超时: ${url} (${timeout}ms)`, {
          isTimeout: true,
          config: options,
        });
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 获取当前默认超时时间
   */
  getDefaultTimeout(): number {
    return this.defaultTimeout;
  }
}
