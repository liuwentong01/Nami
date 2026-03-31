/**
 * @nami/core - 错误上报器
 *
 * ErrorReporter 负责将错误信息发送到外部监控平台。
 * 支持采样率控制、错误去重、批量上报等能力。
 *
 * 上报策略：
 * - 根据 MonitorConfig.sampleRate 进行概率采样
 * - Fatal 和 Error 级别的错误始终上报（不受采样率影响）
 * - Hydration 错误有专门的上报通道
 * - 开发环境默认不上报（除非显式开启）
 */

import type { MonitorConfig } from '@nami/shared';
import {
  NamiError,
  ErrorCode,
  ErrorSeverity,
  createLogger,
  isServer,
  isDev,
} from '@nami/shared';

/** 错误上报器日志 */
const logger = createLogger('@nami/core:error-reporter');

/**
 * 错误上报的上下文信息
 */
export interface ReportContext {
  /** 发生错误的 URL */
  url?: string;
  /** 请求 ID */
  requestId?: string;
  /** 渲染模式 */
  renderMode?: string;
  /** 用户代理 */
  userAgent?: string;
  /** 组件调用栈（ErrorBoundary 捕获时提供） */
  componentStack?: string;
  /** 其他扩展信息 */
  [key: string]: unknown;
}

/**
 * 错误上报载荷
 * 发送给监控平台的完整错误数据
 */
interface ErrorReportPayload {
  /** 应用名称 */
  appName: string;
  /** 错误名称 */
  name: string;
  /** 错误消息 */
  message: string;
  /** 错误码 */
  code: number;
  /** 严重等级 */
  severity: string;
  /** 调用栈 */
  stack?: string;
  /** 错误发生时间 */
  timestamp: number;
  /** 运行环境 */
  environment: 'server' | 'client';
  /** 上下文信息 */
  context: ReportContext;
}

/**
 * 错误上报器
 *
 * @example
 * ```typescript
 * const reporter = new ErrorReporter({
 *   enabled: true,
 *   sampleRate: 0.1, // 10% 采样
 *   reportUrl: 'https://monitor.example.com/api/errors',
 * }, 'my-app');
 *
 * // 上报一般错误
 * reporter.report(error, { url: '/page', requestId: 'req-123' });
 *
 * // 上报 Hydration 不匹配错误
 * reporter.reportHydrationMismatch(error);
 * ```
 */
export class ErrorReporter {
  /** 监控配置 */
  private readonly config: MonitorConfig;

  /** 应用名称 */
  private readonly appName: string;

  /** 已上报错误的去重集合（基于错误消息的哈希） */
  private readonly reportedErrors: Set<string> = new Set();

  /** 去重集合的最大容量，超过后清空 */
  private readonly maxDedupeSize: number = 1000;

  /**
   * 构造函数
   *
   * @param config - 监控配置
   * @param appName - 应用名称
   */
  constructor(config: MonitorConfig, appName: string = 'nami-app') {
    this.config = config;
    this.appName = appName;
  }

  /**
   * 上报错误
   *
   * 执行流程：
   * 1. 检查上报是否启用
   * 2. 采样率检查
   * 3. 去重检查
   * 4. 构造上报载荷
   * 5. 发送到监控平台
   *
   * @param error - 要上报的错误
   * @param context - 错误上下文信息
   */
  report(error: Error | NamiError, context?: ReportContext): void {
    // 检查是否启用上报
    if (!this.shouldReport(error)) {
      return;
    }

    // 去重检查
    const dedupeKey = this.getDedupeKey(error);
    if (this.reportedErrors.has(dedupeKey)) {
      logger.debug('错误已上报过，跳过重复上报', { message: error.message });
      return;
    }

    // 标记已上报
    this.addToDedupeSet(dedupeKey);

    // 构造上报载荷
    const payload = this.buildPayload(error, context);

    // 发送上报
    this.send(payload);
  }

  /**
   * 上报 Hydration 不匹配错误
   *
   * Hydration mismatch 是 SSR 框架特有的问题，
   * 表示服务端渲染的 HTML 与客户端渲染结果不一致。
   * 此类错误需要特别关注，因此使用专门的上报方法。
   *
   * @param error - Hydration 错误
   */
  reportHydrationMismatch(error: Error): void {
    logger.warn('检测到 Hydration 不匹配', {
      message: error.message,
    });

    // Hydration 错误始终上报（不受采样率限制）
    const namiError = error instanceof NamiError
      ? error
      : new NamiError(
          error.message,
          ErrorCode.RENDER_HYDRATION_MISMATCH,
          ErrorSeverity.Warning,
          { stack: error.stack },
        );

    const payload = this.buildPayload(namiError, {
      type: 'hydration-mismatch',
    });

    this.send(payload);
  }

  /**
   * 判断是否应该上报此错误
   *
   * @param error - 错误实例
   * @returns 是否应该上报
   */
  private shouldReport(error: Error | NamiError): boolean {
    // 未启用监控，不上报
    if (!this.config.enabled) {
      return false;
    }

    // 开发环境默认不上报
    if (isDev()) {
      logger.debug('开发环境跳过错误上报', { message: error.message });
      return false;
    }

    // Fatal 和 Error 级别始终上报（不受采样率限制）
    if (error instanceof NamiError) {
      if (
        error.severity === ErrorSeverity.Fatal ||
        error.severity === ErrorSeverity.Error
      ) {
        return true;
      }
    }

    // 采样率检查
    return Math.random() < this.config.sampleRate;
  }

  /**
   * 生成错误去重 key
   *
   * 基于错误消息和错误码生成唯一标识，
   * 避免同一错误在短时间内被重复上报。
   */
  private getDedupeKey(error: Error | NamiError): string {
    const code = error instanceof NamiError ? error.code : 0;
    return `${code}:${error.message}`;
  }

  /**
   * 添加到去重集合
   * 当集合超过最大容量时清空，防止内存泄漏
   */
  private addToDedupeSet(key: string): void {
    if (this.reportedErrors.size >= this.maxDedupeSize) {
      this.reportedErrors.clear();
    }
    this.reportedErrors.add(key);
  }

  /**
   * 构造上报载荷
   */
  private buildPayload(
    error: Error | NamiError,
    context?: ReportContext,
  ): ErrorReportPayload {
    const isNamiError = error instanceof NamiError;

    return {
      appName: this.appName,
      name: error.name,
      message: error.message,
      code: isNamiError ? error.code : 0,
      severity: isNamiError ? error.severity : ErrorSeverity.Error,
      stack: error.stack,
      timestamp: isNamiError ? error.timestamp : Date.now(),
      environment: isServer() ? 'server' : 'client',
      context: context ?? {},
    };
  }

  /**
   * 发送错误上报
   *
   * 根据运行环境选择不同的发送方式：
   * - 服务端：使用 HTTP 请求发送（当前仅日志记录，实际项目可接入 SDK）
   * - 客户端：使用 navigator.sendBeacon 或 fetch
   *
   * @param payload - 上报载荷
   */
  private send(payload: ErrorReportPayload): void {
    const { reportUrl } = this.config;

    // 没有配置上报地址，仅记录日志
    if (!reportUrl) {
      logger.debug('未配置 reportUrl，错误仅记录日志', {
        name: payload.name,
        code: payload.code,
        message: payload.message,
      });
      return;
    }

    // 服务端环境
    if (isServer()) {
      this.sendFromServer(reportUrl, payload);
      return;
    }

    // 客户端环境
    this.sendFromClient(reportUrl, payload);
  }

  /**
   * 服务端发送错误上报
   * 使用异步方式发送，不阻塞主流程
   */
  private sendFromServer(reportUrl: string, payload: ErrorReportPayload): void {
    // 异步发送，不阻塞当前请求处理
    setImmediate(() => {
      try {
        // 使用 Node.js 内置的 fetch（Node 18+）或 http 模块
        // 这里使用 globalThis.fetch 作为简化实现
        const body = JSON.stringify(payload);

        if (typeof globalThis.fetch === 'function') {
          globalThis.fetch(reportUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }).catch((err: Error) => {
            logger.warn('服务端错误上报发送失败', { error: err.message });
          });
        } else {
          logger.debug('服务端 fetch 不可用，跳过错误上报');
        }
      } catch (err) {
        // 上报失败不应影响业务流程
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('服务端错误上报异常', { error: message });
      }
    });
  }

  /**
   * 客户端发送错误上报
   * 优先使用 sendBeacon（不阻塞页面卸载），降级使用 fetch
   */
  private sendFromClient(reportUrl: string, payload: ErrorReportPayload): void {
    try {
      const body = JSON.stringify(payload);

      // 优先使用 sendBeacon — 在页面卸载时也能可靠发送
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' });
        const sent = navigator.sendBeacon(reportUrl, blob);
        if (sent) return;
      }

      // 降级使用 fetch
      if (typeof globalThis.fetch === 'function') {
        globalThis.fetch(reportUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          // keepalive 确保页面卸载时请求不被取消
          keepalive: true,
        }).catch((err: Error) => {
          logger.warn('客户端错误上报发送失败', { error: err.message });
        });
      }
    } catch (err) {
      // 上报失败不应影响业务流程
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('客户端错误上报异常', { error: message });
    }
  }
}
