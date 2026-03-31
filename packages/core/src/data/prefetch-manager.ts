/**
 * @nami/core - 数据预取管理器
 *
 * PrefetchManager 是框架数据层的核心类，负责在服务端执行数据预取。
 * 它统一管理 SSR 模式下的 getServerSideProps 和 SSG/ISR 模式下的 getStaticProps，
 * 提供超时保护、并行数据源、错误降级等能力。
 *
 * 设计原则：
 * 1. 超时保护 — 使用 Promise.race 确保数据预取不会阻塞渲染流程
 * 2. 部分失败容忍 — 单个数据源失败不影响其他数据源的结果
 * 3. 降级友好 — 预取失败时返回降级结果而非抛出异常
 * 4. 性能可观测 — 记录每个数据源的耗时，便于性能分析
 */

import type {
  PrefetchResult,
  PrefetchDetail,
  PrefetchOptions,
  GetServerSidePropsContext,
  GetServerSidePropsResult,
  GetStaticPropsContext,
  GetStaticPropsResult,
  NamiRoute,
} from '@nami/shared';

import {
  DataFetchError,
  ErrorCode,
  createLogger,
  measureAsync,
  createTimer,
} from '@nami/shared';

/**
 * 数据预取函数的类型签名
 * 从页面组件模块中导出的 getServerSideProps / getStaticProps
 */
type ServerSidePropsFunction = (
  context: GetServerSidePropsContext,
) => Promise<GetServerSidePropsResult>;

type StaticPropsFunction = (
  context: GetStaticPropsContext,
) => Promise<GetStaticPropsResult>;

/** 预取管理器内部使用的日志实例 */
const logger = createLogger('@nami/core:prefetch');

/**
 * 预取上下文 — 封装单次预取请求的完整上下文信息
 */
export interface PrefetchContext {
  /** 当前匹配的路由配置 */
  route: NamiRoute;
  /** 预取选项（超时、重试等） */
  options?: PrefetchOptions;
}

/**
 * 数据预取管理器
 *
 * 职责：
 * - 执行 SSR 数据预取（getServerSideProps）
 * - 执行 SSG/ISR 数据预取（getStaticProps）
 * - 超时保护（Promise.race）
 * - 并行数据源执行
 * - 错误捕获与降级结果生成
 *
 * @example
 * ```typescript
 * const manager = new PrefetchManager();
 *
 * // SSR 场景
 * const result = await manager.prefetchOnServer(
 *   getServerSidePropsFn,
 *   ssrContext,
 *   { timeout: 5000 },
 * );
 *
 * // SSG/ISR 场景
 * const result = await manager.prefetchForStatic(
 *   getStaticPropsFn,
 *   staticContext,
 *   { timeout: 10000 },
 * );
 * ```
 */
export class PrefetchManager {
  /** 默认超时时间（毫秒） */
  private readonly defaultTimeout: number;

  /**
   * 构造函数
   *
   * @param defaultTimeout - 默认超时时间，单位毫秒，默认 5000ms
   */
  constructor(defaultTimeout: number = 5000) {
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * 执行 SSR 数据预取（getServerSideProps）
   *
   * 在每次 SSR 请求时调用，执行页面组件导出的 getServerSideProps 函数。
   * 使用 Promise.race 进行超时保护，超时后返回降级结果。
   *
   * @param fetchFn - 页面组件导出的 getServerSideProps 函数
   * @param context - SSR 请求上下文（包含 params、query、headers 等）
   * @param options - 预取选项（超时、重试等）
   * @returns 预取结果，包含数据、错误列表、是否降级、耗时等信息
   */
  async prefetchOnServer(
    fetchFn: ServerSidePropsFunction,
    context: GetServerSidePropsContext,
    options?: PrefetchOptions,
  ): Promise<PrefetchResult> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const timer = createTimer();

    logger.debug('开始 SSR 数据预取', {
      path: context.path,
      requestId: context.requestId,
      timeout,
    });

    try {
      // 使用 Promise.race 实现超时保护
      const result = await this.executeWithTimeout(
        () => fetchFn(context),
        timeout,
        'getServerSideProps',
      );

      const duration = timer.total();

      logger.debug('SSR 数据预取完成', {
        path: context.path,
        requestId: context.requestId,
        duration,
      });

      return {
        data: (result.props ?? {}) as Record<string, unknown>,
        errors: [],
        degraded: false,
        duration,
        details: [
          {
            key: 'getServerSideProps',
            success: true,
            duration,
          },
        ],
      };
    } catch (error) {
      const duration = timer.total();
      const err = this.normalizeError(error, ErrorCode.DATA_GSSP_FAILED);

      logger.error('SSR 数据预取失败', {
        path: context.path,
        requestId: context.requestId,
        duration,
        error: err.message,
      });

      // 返回降级结果：数据为空，标记降级状态
      return this.createDegradedResult(err, duration, 'getServerSideProps');
    }
  }

  /**
   * 执行 SSG/ISR 数据预取（getStaticProps）
   *
   * 在构建时（SSG）或重验证时（ISR）调用。
   * 同样使用超时保护，但超时时间通常可以设置得更长。
   *
   * @param fetchFn - 页面组件导出的 getStaticProps 函数
   * @param context - 静态生成上下文（包含 params、locale 等）
   * @param options - 预取选项
   * @returns 预取结果
   */
  async prefetchForStatic(
    fetchFn: StaticPropsFunction,
    context: GetStaticPropsContext,
    options?: PrefetchOptions,
  ): Promise<PrefetchResult> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const timer = createTimer();

    logger.debug('开始 SSG/ISR 数据预取', {
      params: context.params,
      timeout,
    });

    try {
      const result = await this.executeWithTimeout(
        () => fetchFn(context),
        timeout,
        'getStaticProps',
      );

      const duration = timer.total();

      logger.debug('SSG/ISR 数据预取完成', {
        params: context.params,
        duration,
      });

      return {
        data: (result.props ?? {}) as Record<string, unknown>,
        errors: [],
        degraded: false,
        duration,
        details: [
          {
            key: 'getStaticProps',
            success: true,
            duration,
          },
        ],
      };
    } catch (error) {
      const duration = timer.total();
      const err = this.normalizeError(error, ErrorCode.DATA_GSP_FAILED);

      logger.error('SSG/ISR 数据预取失败', {
        params: context.params,
        duration,
        error: err.message,
      });

      return this.createDegradedResult(err, duration, 'getStaticProps');
    }
  }

  /**
   * 并行执行多个数据源的预取
   *
   * 当页面需要从多个独立数据源获取数据时使用。
   * 每个数据源独立执行，单个失败不影响其他数据源。
   *
   * @param sources - 数据源映射表，key 为数据源标识，value 为异步获取函数
   * @param options - 预取选项
   * @returns 聚合后的预取结果
   *
   * @example
   * ```typescript
   * const result = await manager.prefetchParallel({
   *   user: () => fetchUser(userId),
   *   posts: () => fetchPosts(userId),
   *   settings: () => fetchSettings(),
   * });
   * // result.data = { user: {...}, posts: [...], settings: {...} }
   * ```
   */
  async prefetchParallel(
    sources: Record<string, () => Promise<unknown>>,
    options?: PrefetchOptions,
  ): Promise<PrefetchResult> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const allowPartialFailure = options?.allowPartialFailure ?? true;
    const timer = createTimer();
    const keys = Object.keys(sources);

    logger.debug('开始并行数据预取', {
      sources: keys,
      timeout,
    });

    // 为每个数据源创建带超时保护的 Promise
    const tasks = keys.map(async (key) => {
      const sourceFn = sources[key];
      if (!sourceFn) {
        return { key, success: false, data: undefined, error: '数据源函数未定义', duration: 0 };
      }
      try {
        const [data, duration] = await measureAsync(() =>
          this.executeWithTimeout(sourceFn, timeout, key),
        );
        return { key, success: true, data, error: undefined, duration };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { key, success: false, data: undefined, error: err.message, duration: timer.total() };
      }
    });

    // 并行执行所有数据源
    const results = await Promise.all(tasks);
    const duration = timer.total();

    // 汇总结果
    const data: Record<string, unknown> = {};
    const errors: Error[] = [];
    const details: PrefetchDetail[] = [];
    let degraded = false;

    for (const result of results) {
      details.push({
        key: result.key,
        success: result.success,
        duration: result.duration,
        error: result.error,
      });

      if (result.success) {
        data[result.key] = result.data;
      } else {
        degraded = true;
        errors.push(new DataFetchError(
          `数据源 "${result.key}" 预取失败: ${result.error ?? '未知错误'}`,
          ErrorCode.DATA_FETCH_FAILED,
          { key: result.key },
        ));

        // 如果不允许部分失败，将 data[key] 设为 null 以标记
        if (!allowPartialFailure) {
          throw errors[0];
        }
        data[result.key] = null;
      }
    }

    logger.debug('并行数据预取完成', {
      sources: keys,
      duration,
      degraded,
      failedSources: errors.map((e) => e.message),
    });

    return { data, errors, degraded, duration, details };
  }

  /**
   * 使用 Promise.race 实现超时保护
   *
   * 如果执行函数在指定时间内未完成，则抛出超时错误。
   *
   * @param fn - 要执行的异步函数
   * @param timeout - 超时时间（毫秒）
   * @param label - 标签名称，用于错误信息
   * @returns 执行函数的返回值
   */
  private executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: number,
    label: string,
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new DataFetchError(
              `${label} 执行超时（${timeout}ms）`,
              ErrorCode.DATA_FETCH_TIMEOUT,
              { timeout, label },
            ),
          );
        }, timeout);
      }),
    ]);
  }

  /**
   * 将未知错误规范化为 DataFetchError
   *
   * @param error - 原始错误（可能是任意类型）
   * @param code - 错误码
   * @returns DataFetchError 实例
   */
  private normalizeError(error: unknown, code: ErrorCode): DataFetchError {
    if (error instanceof DataFetchError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new DataFetchError(message, code);
  }

  /**
   * 创建降级预取结果
   *
   * 当预取失败时，返回一个标记了降级状态的空结果，
   * 而非直接抛出异常，让渲染流程可以继续。
   *
   * @param error - 导致降级的错误
   * @param duration - 预取耗时
   * @param key - 数据源标识
   * @returns 降级后的预取结果
   */
  private createDegradedResult(
    error: Error,
    duration: number,
    key: string,
  ): PrefetchResult {
    return {
      data: {},
      errors: [error],
      degraded: true,
      duration,
      details: [
        {
          key,
          success: false,
          duration,
          error: error.message,
        },
      ],
    };
  }
}
