/**
 * @nami/plugin-error-boundary - 错误边界插件主体
 *
 * NamiErrorBoundaryPlugin 为 Nami 框架提供全方位的错误处理能力：
 *
 * 1. wrapApp: 用全局错误边界包裹应用根组件
 *    - 捕获所有未被局部错误边界处理的渲染错误
 *    - 展示友好的错误 UI，避免白屏
 *
 * 2. onRenderError: 应用渐进降级策略
 *    - 根据错误类型和严重程度决定降级等级
 *    - 从 CSR 降级 → 骨架屏 → 静态页面 → 503 逐级降级
 *    - 记录完整的降级链路，便于事后分析
 *
 * 错误处理哲学：
 * - 永远不要给用户看白屏（即使后端完全不可用也有静态兜底）
 * - 尽可能保留功能（能 CSR 就不降级到骨架屏）
 * - 错误信息对开发者友好，对用户友善
 */

import React from 'react';
import type { NamiPlugin, PluginAPI, RenderContext } from '@nami/shared';
import { DegradationLevel } from '@nami/shared';
import { RouteErrorBoundary } from './components/route-error-boundary';
import { ErrorFallback } from './components/error-fallback';
import type { ErrorFallbackProps } from './components/error-fallback';
import { RetryStrategy, type RetryStrategyOptions } from './strategies/retry-strategy';
import { DegradeStrategy, type DegradeStrategyOptions } from './strategies/degrade-strategy';

/**
 * 错误边界插件配置选项
 */
export interface ErrorBoundaryPluginOptions {
  /**
   * 自定义全局错误回退组件
   * 不提供时使用内置的 ErrorFallback
   */
  fallback?: React.ComponentType<ErrorFallbackProps>;

  /**
   * 重试策略配置
   * 设为 false 禁用自动重试
   * @default { maxRetries: 2 }
   */
  retry?: RetryStrategyOptions | false;

  /**
   * 降级策略配置
   */
  degrade?: DegradeStrategyOptions;

  /**
   * 是否在 wrapApp 中添加全局错误边界
   * @default true
   */
  enableGlobalBoundary?: boolean;

  /**
   * 是否在 onRenderError 中应用降级策略
   * @default true
   */
  enableDegradation?: boolean;

  /**
   * 错误上报回调
   * 在每次错误捕获时调用
   */
  onError?: (error: Error, context?: Record<string, unknown>) => void;

  /**
   * 日志前缀
   * @default '[NamiErrorBoundary]'
   */
  logPrefix?: string;
}

/**
 * Nami 错误边界插件
 *
 * @example
 * ```typescript
 * import { NamiErrorBoundaryPlugin } from '@nami/plugin-error-boundary';
 *
 * export default {
 *   plugins: [
 *     new NamiErrorBoundaryPlugin({
 *       retry: { maxRetries: 2 },
 *       degrade: {
 *         maxDegradationLevel: DegradationLevel.StaticHTML,
 *       },
 *       onError: (error) => {
 *         // 上报到监控系统
 *         monitor.captureException(error);
 *       },
 *     }),
 *   ],
 * };
 * ```
 *
 * @example
 * ```tsx
 * // 使用自定义错误 UI
 * import { NamiErrorBoundaryPlugin } from '@nami/plugin-error-boundary';
 * import { MyErrorPage } from './components/MyErrorPage';
 *
 * new NamiErrorBoundaryPlugin({
 *   fallback: MyErrorPage,
 * });
 * ```
 */
export class NamiErrorBoundaryPlugin implements NamiPlugin {
  /** 插件唯一名称 */
  readonly name = 'nami:error-boundary';

  /** 插件版本号 */
  readonly version = '0.1.0';

  /**
   * 执行顺序：post
   * 错误边界应在所有其他插件的 wrapApp 之外（最外层），
   * 确保能捕获所有插件引入的组件的错误。
   */
  readonly enforce = 'post' as const;

  /** 重试策略 */
  private readonly retryStrategy?: RetryStrategy;

  /** 降级策略 */
  private readonly degradeStrategy: DegradeStrategy;

  /** 插件配置 */
  private readonly options: ErrorBoundaryPluginOptions;

  /** 日志前缀 */
  private readonly logPrefix: string;

  constructor(options: ErrorBoundaryPluginOptions = {}) {
    this.options = options;
    this.logPrefix = options.logPrefix ?? '[NamiErrorBoundary]';

    // 初始化重试策略
    if (options.retry !== false) {
      this.retryStrategy = new RetryStrategy(options.retry ?? { maxRetries: 2 });
    }

    // 初始化降级策略
    this.degradeStrategy = new DegradeStrategy(options.degrade);
  }

  /**
   * 插件初始化
   *
   * @param api - 插件 API
   */
  async setup(api: PluginAPI): Promise<void> {
    const logger = api.getLogger();

    logger.info(`${this.logPrefix} 错误边界插件初始化`);

    // ==================== wrapApp: 全局错误边界 ====================
    if (this.options.enableGlobalBoundary !== false) {
      api.wrapApp((app: React.ReactElement): React.ReactElement => {
        const FallbackComponent = this.options.fallback ?? ErrorFallback;

        // 用 RouteErrorBoundary 包裹应用根组件
        return React.createElement(
          RouteErrorBoundary,
          {
            fallback: FallbackComponent,
            onError: (error: Error, errorInfo: React.ErrorInfo) => {
              // 记录错误日志
              logger.error(`${this.logPrefix} 全局错误边界捕获到渲染错误`, {
                error: error.message,
                componentStack: errorInfo.componentStack,
              });

              // 触发外部错误回调
              this.options.onError?.(error, {
                componentStack: errorInfo.componentStack,
                source: 'global-error-boundary',
              });
            },
          },
          app,
        );
      });

      logger.debug(`${this.logPrefix} 已注册全局错误边界`);
    }

    // ==================== onRenderError: 渐进降级 ====================
    if (this.options.enableDegradation !== false) {
      api.onRenderError(async (context: RenderContext, error: Error) => {
        try {
          // 获取当前降级等级（可能已经被其他插件触发了降级）
          const currentLevel = (context.extra['__degradation_level'] as DegradationLevel) ??
            DegradationLevel.None;

          // 先尝试重试（如果启用了重试策略且错误是可恢复的）
          if (this.retryStrategy && this.retryStrategy.shouldRetry(error)) {
            context.extra['__retry_attempted'] = true;
            logger.info(`${this.logPrefix} 尝试重试渲染`, {
              url: context.url,
              error: error.message,
            });
            // 重试结果将由框架核心处理
            // 插件仅标记重试意图，实际重试由渲染引擎执行
          }

          // 执行降级
          const result = this.degradeStrategy.degrade(error, currentLevel);

          // 将降级结果写入 context.extra
          // 渲染引擎会读取这些信息来决定最终返回给客户端的内容
          context.extra['__degradation_level'] = result.level;
          context.extra['__degradation_html'] = result.html;
          context.extra['__degradation_status'] = result.statusCode;
          context.extra['__degradation_reason'] = result.reason;
          context.extra['__degradation_path'] = result.degradationPath;

          logger.warn(`${this.logPrefix} 渲染降级`, {
            url: context.url,
            error: error.message,
            level: result.level,
            levelName: result.levelName,
            reason: result.reason,
            path: result.degradationPath,
          });

          // 触发外部错误回调
          this.options.onError?.(error, {
            url: context.url,
            degradationLevel: result.level,
            degradationLevelName: result.levelName,
            source: 'render-error-degradation',
          });
        } catch (degradeError) {
          // 降级过程本身出错（极端情况）
          // 此时设置最高级别的降级（503）
          context.extra['__degradation_level'] = DegradationLevel.ServiceUnavailable;
          context.extra['__degradation_status'] = 503;

          logger.error(`${this.logPrefix} 降级过程出错，返回 503`, {
            url: context.url,
            originalError: error.message,
            degradeError: degradeError instanceof Error ? degradeError.message : String(degradeError),
          });
        }
      });

      logger.debug(`${this.logPrefix} 已注册渲染错误降级钩子`);
    }

    // ==================== 通用错误处理 ====================
    api.onError(async (error: Error, errorContext?: Record<string, unknown>) => {
      logger.error(`${this.logPrefix} 未处理的错误`, {
        error: error.message,
        context: errorContext,
      });

      // 触发外部错误回调
      this.options.onError?.(error, {
        ...errorContext,
        source: 'uncaught-error',
      });
    });

    // ==================== 插件销毁 ====================
    api.onDispose(async () => {
      logger.info(`${this.logPrefix} 错误边界插件已销毁`);
    });
  }

  /**
   * 获取重试策略实例
   */
  getRetryStrategy(): RetryStrategy | undefined {
    return this.retryStrategy;
  }

  /**
   * 获取降级策略实例
   */
  getDegradeStrategy(): DegradeStrategy {
    return this.degradeStrategy;
  }
}
