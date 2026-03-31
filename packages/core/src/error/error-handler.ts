/**
 * @nami/core - 错误处理器
 *
 * ErrorHandler 是框架的统一错误处理入口。
 * 所有框架内部产生的错误都应通过此处理器进行分类、记录和上报。
 *
 * 职责：
 * 1. 错误分类 — 将错误按严重等级归类（Fatal/Error/Warning/Info）
 * 2. 可恢复性判断 — 判断错误是否允许降级处理
 * 3. 日志记录 — 使用框架日志系统记录错误详情
 * 4. 错误上报 — 通过 ErrorReporter 向监控平台上报（如果配置了）
 *
 * 设计原则：
 * - 不吞噬错误：所有错误都有记录
 * - 分类明确：根据错误类型决定后续行为
 * - 降级友好：优先返回降级结果而非崩溃
 */

import {
  NamiError,
  RenderError,
  DataFetchError,
  ErrorCode,
  ErrorSeverity,
  createLogger,
} from '@nami/shared';

/** 错误处理器内部日志 */
const logger = createLogger('@nami/core:error');

/**
 * 错误上下文信息
 * 附加在错误上的额外调试信息
 */
export interface ErrorContext {
  /** 发生错误的 URL */
  url?: string;
  /** 请求 ID */
  requestId?: string;
  /** 渲染模式 */
  renderMode?: string;
  /** 路由路径 */
  routePath?: string;
  /** 任意额外信息 */
  [key: string]: unknown;
}

/**
 * 错误处理结果
 */
export interface ErrorHandleResult {
  /** 错误严重等级 */
  severity: ErrorSeverity;
  /** 是否可恢复（可以降级处理） */
  recoverable: boolean;
  /** 处理后的错误实例 */
  error: NamiError;
}

/**
 * 统一错误处理器
 *
 * @example
 * ```typescript
 * const handler = new ErrorHandler();
 *
 * try {
 *   await renderPage(context);
 * } catch (error) {
 *   const result = handler.handle(error, { url: '/page', requestId: 'req-123' });
 *   if (result.recoverable) {
 *     // 执行降级逻辑
 *     return fallbackRender(context);
 *   } else {
 *     // 致命错误，返回 503
 *     return { statusCode: 503, html: '服务不可用' };
 *   }
 * }
 * ```
 */
export class ErrorHandler {
  /**
   * 处理错误
   *
   * 接收任意类型的错误，执行以下步骤：
   * 1. 将错误规范化为 NamiError
   * 2. 判断错误严重等级
   * 3. 记录错误日志
   * 4. 判断是否可恢复
   *
   * @param error - 原始错误（可能是 Error、NamiError 或任意类型）
   * @param context - 可选的错误上下文信息
   * @returns 错误处理结果
   */
  handle(error: unknown, context?: ErrorContext): ErrorHandleResult {
    // 规范化错误为 NamiError
    const namiError = this.normalize(error);

    // 分类错误严重等级
    const severity = this.classify(namiError);

    // 判断是否可恢复
    const recoverable = this.isRecoverable(namiError);

    // 记录错误日志
    this.logError(namiError, severity, context);

    return {
      severity,
      recoverable,
      error: namiError,
    };
  }

  /**
   * 判断错误是否可恢复
   *
   * 可恢复的错误允许框架执行降级处理（如 SSR 降级到 CSR），
   * 不可恢复的错误需要直接返回错误页面。
   *
   * 可恢复的场景：
   * - SSR 渲染超时（可降级到 CSR）
   * - 数据预取失败（可使用空数据渲染）
   * - 数据序列化失败（可跳过数据注入）
   * - 缓存相关错误（可跳过缓存）
   *
   * 不可恢复的场景：
   * - 配置错误（启动就应该失败）
   * - 服务启动失败
   * - Fatal 级别错误
   *
   * @param error - NamiError 实例
   * @returns 是否可恢复
   */
  isRecoverable(error: NamiError): boolean {
    // Fatal 级别不可恢复
    if (error.severity === ErrorSeverity.Fatal) {
      return false;
    }

    // 根据错误码判断可恢复性
    const recoverableCodes = new Set<ErrorCode>([
      // 渲染相关 — 可降级
      ErrorCode.RENDER_SSR_FAILED,
      ErrorCode.RENDER_SSR_TIMEOUT,
      ErrorCode.RENDER_HYDRATION_MISMATCH,
      ErrorCode.RENDER_DEGRADED,
      ErrorCode.RENDER_ISR_REVALIDATE_FAILED,

      // 数据预取 — 可用空数据渲染
      ErrorCode.DATA_FETCH_FAILED,
      ErrorCode.DATA_FETCH_TIMEOUT,
      ErrorCode.DATA_SERIALIZE_FAILED,
      ErrorCode.DATA_GSSP_FAILED,
      ErrorCode.DATA_GSP_FAILED,

      // 缓存 — 可跳过缓存
      ErrorCode.CACHE_READ_FAILED,
      ErrorCode.CACHE_WRITE_FAILED,
      ErrorCode.CACHE_INVALIDATE_FAILED,
      ErrorCode.CACHE_REDIS_CONNECTION_FAILED,

      // 插件钩子 — 单个钩子失败不应阻断渲染
      ErrorCode.PLUGIN_HOOK_FAILED,
    ]);

    return recoverableCodes.has(error.code);
  }

  /**
   * 分类错误严重等级
   *
   * 根据错误的类型和错误码，判断其严重等级。
   * 等级决定了日志级别和告警策略。
   *
   * @param error - NamiError 实例
   * @returns 错误严重等级
   */
  classify(error: NamiError): ErrorSeverity {
    // 如果错误自身已有明确的 severity，直接使用
    if (error.severity) {
      return error.severity;
    }

    // 根据错误码范围判断
    const code = error.code;

    // 配置错误和服务启动错误 — Fatal
    if (code >= 9000 || code === ErrorCode.SERVER_START_FAILED) {
      return ErrorSeverity.Fatal;
    }

    // 渲染超时和数据预取超时 — Warning（可降级）
    if (
      code === ErrorCode.RENDER_SSR_TIMEOUT ||
      code === ErrorCode.DATA_FETCH_TIMEOUT
    ) {
      return ErrorSeverity.Warning;
    }

    // 缓存错误 — Warning（不影响核心渲染）
    if (code >= 3000 && code < 4000) {
      return ErrorSeverity.Warning;
    }

    // 其他渲染错误 — Error
    return ErrorSeverity.Error;
  }

  /**
   * 将任意错误规范化为 NamiError
   *
   * @param error - 原始错误
   * @returns NamiError 实例
   */
  private normalize(error: unknown): NamiError {
    // 已经是 NamiError，直接返回
    if (error instanceof NamiError) {
      return error;
    }

    // 是标准 Error，包装为 NamiError
    if (error instanceof Error) {
      const namiError = new NamiError(
        error.message,
        ErrorCode.RENDER_SSR_FAILED,
        ErrorSeverity.Error,
        { originalStack: error.stack },
      );
      return namiError;
    }

    // 其他类型，转为字符串后包装
    return new NamiError(
      String(error),
      ErrorCode.RENDER_SSR_FAILED,
      ErrorSeverity.Error,
    );
  }

  /**
   * 记录错误日志
   *
   * 根据严重等级使用不同的日志方法。
   */
  private logError(
    error: NamiError,
    severity: ErrorSeverity,
    context?: ErrorContext,
  ): void {
    const meta: Record<string, unknown> = {
      code: error.code,
      severity,
      ...error.context,
      ...context,
    };

    switch (severity) {
      case ErrorSeverity.Fatal:
        logger.fatal(error.message, meta);
        break;
      case ErrorSeverity.Error:
        logger.error(error.message, meta);
        break;
      case ErrorSeverity.Warning:
        logger.warn(error.message, meta);
        break;
      case ErrorSeverity.Info:
        logger.info(error.message, meta);
        break;
    }
  }
}
