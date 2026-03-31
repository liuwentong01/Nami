/**
 * @nami/plugin-error-boundary - 重试策略
 *
 * 当渲染错误发生时，RetryStrategy 决定是否以及如何重试。
 *
 * 重试策略的设计考量：
 * 1. 并非所有错误都值得重试（如代码逻辑错误重试也不会成功）
 * 2. 重试次数需要限制（避免无限循环）
 * 3. 重试间隔需要递增（避免加重服务端压力）
 * 4. 需要区分「可恢复」和「不可恢复」的错误
 *
 * 可恢复的错误示例：
 * - 数据预取超时（服务端暂时高负载）
 * - 网络抖动导致的请求失败
 * - 临时的资源加载失败
 *
 * 不可恢复的错误示例：
 * - React 组件代码错误（TypeError、ReferenceError 等）
 * - 配置错误
 * - 内存溢出
 */

import { NamiError, ErrorCode, ErrorSeverity } from '@nami/shared';

/**
 * 重试策略配置
 */
export interface RetryStrategyOptions {
  /**
   * 最大重试次数
   * @default 2
   */
  maxRetries?: number;

  /**
   * 重试基础延迟（毫秒）
   * 第 N 次重试延迟 = baseDelay * 2^(N-1)
   * @default 500
   */
  baseDelay?: number;

  /**
   * 最大重试延迟（毫秒）
   * @default 5000
   */
  maxDelay?: number;

  /**
   * 自定义可恢复错误判断函数
   * 返回 true 表示该错误可以通过重试恢复
   */
  isRecoverable?: (error: Error) => boolean;
}

/**
 * 重试执行结果
 */
export interface RetryResult<T> {
  /** 是否成功 */
  success: boolean;

  /** 重试次数（0 表示首次就成功了） */
  retryCount: number;

  /** 成功时的返回值 */
  result?: T;

  /** 失败时的最终错误 */
  error?: Error;
}

/**
 * 重试策略
 *
 * 提供可配置的重试逻辑，用于处理渲染过程中的可恢复错误。
 *
 * @example
 * ```typescript
 * const strategy = new RetryStrategy({ maxRetries: 2, baseDelay: 500 });
 *
 * const result = await strategy.execute(async () => {
 *   return await renderPage(context);
 * });
 *
 * if (result.success) {
 *   return result.result;
 * } else {
 *   // 所有重试都失败了，进入降级流程
 *   return fallbackRender(context);
 * }
 * ```
 */
export class RetryStrategy {
  /** 最大重试次数 */
  private readonly maxRetries: number;

  /** 基础延迟 */
  private readonly baseDelay: number;

  /** 最大延迟 */
  private readonly maxDelay: number;

  /** 可恢复判断函数 */
  private readonly isRecoverable: (error: Error) => boolean;

  constructor(options: RetryStrategyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelay = options.baseDelay ?? 500;
    this.maxDelay = options.maxDelay ?? 5000;
    this.isRecoverable = options.isRecoverable ?? RetryStrategy.defaultIsRecoverable;
  }

  /**
   * 执行带重试的操作
   *
   * @param fn - 要重试的异步操作
   * @returns 重试结果
   */
  async execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await fn();
        return {
          success: true,
          retryCount: attempt,
          result,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 检查错误是否可恢复
        if (!this.isRecoverable(lastError)) {
          // 不可恢复的错误，立即停止重试
          return {
            success: false,
            retryCount: attempt,
            error: lastError,
          };
        }

        // 如果还有重试机会，等待延迟后重试
        if (attempt < this.maxRetries) {
          const delay = this.calculateDelay(attempt + 1);
          await this.sleep(delay);
        }
      }
    }

    // 所有重试都失败了
    return {
      success: false,
      retryCount: this.maxRetries,
      error: lastError,
    };
  }

  /**
   * 判断错误是否值得重试
   *
   * 供外部调用，使用与 execute() 相同的判断逻辑。
   */
  shouldRetry(error: Error): boolean {
    return this.isRecoverable(error);
  }

  /**
   * 默认的可恢复错误判断逻辑
   *
   * 判断标准：
   * 1. NamiError 中的特定错误码（超时、数据预取失败等）
   * 2. 错误严重等级为 Warning 或以下
   * 3. 网络相关的错误
   *
   * 不可恢复：
   * 1. TypeError / ReferenceError / SyntaxError（代码逻辑错误）
   * 2. Fatal 级别错误
   * 3. 配置错误
   */
  static defaultIsRecoverable(error: Error): boolean {
    // NamiError：根据错误码和严重等级判断
    if (error instanceof NamiError) {
      // Fatal 级别不可恢复
      if (error.severity === ErrorSeverity.Fatal) {
        return false;
      }

      // 以下错误码是可恢复的
      const recoverableErrorCodes = new Set([
        ErrorCode.RENDER_SSR_TIMEOUT,
        ErrorCode.DATA_FETCH_FAILED,
        ErrorCode.DATA_FETCH_TIMEOUT,
        ErrorCode.CACHE_READ_FAILED,
        ErrorCode.CACHE_WRITE_FAILED,
        ErrorCode.SERVER_MIDDLEWARE_FAILED,
      ]);

      return recoverableErrorCodes.has(error.code);
    }

    // 代码逻辑错误不可恢复
    if (
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      error instanceof RangeError
    ) {
      return false;
    }

    // 包含特定关键词的错误消息视为可恢复
    const recoverableKeywords = [
      'timeout',
      'TIMEOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'network',
      'fetch failed',
      'socket hang up',
    ];

    const message = error.message.toLowerCase();
    return recoverableKeywords.some((keyword) => message.includes(keyword.toLowerCase()));
  }

  /**
   * 计算重试延迟
   */
  private calculateDelay(attempt: number): number {
    return Math.min(this.baseDelay * Math.pow(2, attempt - 1), this.maxDelay);
  }

  /**
   * 异步等待
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
