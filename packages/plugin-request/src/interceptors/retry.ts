/**
 * @nami/plugin-request - 重试拦截器
 *
 * 当请求失败时自动进行重试。
 * 采用指数退避（Exponential Backoff）策略控制重试间隔，
 * 避免在服务端压力大时雪崩式重试。
 *
 * 重试策略：
 * - 仅对「可恢复」的错误进行重试（网络超时、5xx 服务端错误）
 * - 不对 4xx 客户端错误重试（参数错误、认证失败等不可通过重试恢复）
 * - 指数退避间隔：第 N 次重试等待 baseDelay * 2^(N-1) 毫秒
 * - 可添加随机抖动（jitter）避免多个客户端同时重试
 */

import type { RequestOptions, RequestResponse, RequestAdapter } from '../adapters/server-adapter';
import { RequestError } from '../adapters/server-adapter';

/**
 * 重试拦截器配置
 */
export interface RetryInterceptorOptions {
  /**
   * 最大重试次数
   * @default 3
   */
  maxRetries?: number;

  /**
   * 基础延迟时间（毫秒）
   * 实际延迟 = baseDelay * 2^(retryCount - 1)
   * @default 1000
   */
  baseDelay?: number;

  /**
   * 最大延迟时间（毫秒）
   * 指数退避的上限，防止延迟过长
   * @default 30000
   */
  maxDelay?: number;

  /**
   * 是否启用随机抖动
   * 启用后会在延迟时间上添加 0-50% 的随机偏移
   * @default true
   */
  jitter?: boolean;

  /**
   * 自定义重试条件判断函数
   * 返回 true 表示应该重试，false 表示不重试
   * 不提供时使用默认判断逻辑
   */
  retryCondition?: (error: RequestError) => boolean;

  /**
   * 重试前的回调钩子
   * 可用于记录日志、更新 UI 等
   */
  onRetry?: (retryCount: number, error: RequestError) => void;
}

/**
 * 重试拦截器
 *
 * 包装请求适配器，在请求失败时自动重试。
 *
 * @example
 * ```typescript
 * const retry = new RetryInterceptor({
 *   maxRetries: 3,
 *   baseDelay: 1000,
 *   jitter: true,
 * });
 *
 * const response = await retry.execute(adapter, '/api/data', { method: 'GET' });
 * ```
 */
export class RetryInterceptor {
  /** 最大重试次数 */
  private readonly maxRetries: number;

  /** 基础延迟（毫秒） */
  private readonly baseDelay: number;

  /** 最大延迟（毫秒） */
  private readonly maxDelay: number;

  /** 是否启用抖动 */
  private readonly jitter: boolean;

  /** 自定义重试条件 */
  private readonly retryCondition?: (error: RequestError) => boolean;

  /** 重试回调 */
  private readonly onRetry?: (retryCount: number, error: RequestError) => void;

  constructor(options: RetryInterceptorOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelay = options.baseDelay ?? 1000;
    this.maxDelay = options.maxDelay ?? 30000;
    this.jitter = options.jitter ?? true;
    this.retryCondition = options.retryCondition;
    this.onRetry = options.onRetry;
  }

  /**
   * 执行带重试的请求
   *
   * @param adapter - 请求适配器
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 响应数据
   * @throws 当所有重试都失败时抛出最后一次的错误
   */
  async execute<T = unknown>(
    adapter: RequestAdapter,
    url: string,
    options?: RequestOptions,
  ): Promise<RequestResponse<T>> {
    let lastError: RequestError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await adapter.request<T>(url, options);
      } catch (error) {
        const requestError = this.normalizeError(error);
        lastError = requestError;

        // 判断是否应该重试
        if (attempt >= this.maxRetries || !this.shouldRetry(requestError)) {
          throw requestError;
        }

        // 如果请求已被取消，不重试
        if (requestError.isCancelled) {
          throw requestError;
        }

        // 计算重试延迟
        const delay = this.calculateDelay(attempt + 1);

        // 触发重试回调
        this.onRetry?.(attempt + 1, requestError);

        // 等待延迟后重试
        await this.sleep(delay);
      }
    }

    // 理论上不会执行到这里，但 TypeScript 需要
    throw lastError ?? new RequestError('未知错误：重试耗尽');
  }

  /**
   * 判断错误是否应该重试
   *
   * 默认重试条件：
   * 1. 网络超时
   * 2. 服务端错误（5xx）
   * 3. 网络异常（无状态码）
   *
   * 不重试的情况：
   * 1. 客户端错误（4xx）
   * 2. 请求被取消
   */
  private shouldRetry(error: RequestError): boolean {
    // 使用自定义判断函数
    if (this.retryCondition) {
      return this.retryCondition(error);
    }

    // 取消的请求不重试
    if (error.isCancelled) {
      return false;
    }

    // 超时总是重试
    if (error.isTimeout) {
      return true;
    }

    // 有状态码时，仅对 5xx 重试
    if (error.status !== undefined) {
      return error.status >= 500;
    }

    // 无状态码（网络错误），重试
    return true;
  }

  /**
   * 计算第 N 次重试的延迟时间
   *
   * 使用指数退避 + 可选抖动：
   * delay = min(baseDelay * 2^(retryCount-1), maxDelay) * (1 + random_jitter)
   *
   * @param retryCount - 第几次重试（从 1 开始）
   * @returns 延迟时间（毫秒）
   */
  private calculateDelay(retryCount: number): number {
    // 指数退避
    let delay = Math.min(
      this.baseDelay * Math.pow(2, retryCount - 1),
      this.maxDelay,
    );

    // 添加随机抖动（0% ~ 50%）
    if (this.jitter) {
      const jitterFactor = Math.random() * 0.5;
      delay = delay * (1 + jitterFactor);
    }

    return Math.round(delay);
  }

  /**
   * 将任意错误标准化为 RequestError
   */
  private normalizeError(error: unknown): RequestError {
    if (error instanceof RequestError) {
      return error;
    }
    if (error instanceof Error) {
      return new RequestError(error.message);
    }
    return new RequestError(String(error));
  }

  /**
   * 异步等待
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
