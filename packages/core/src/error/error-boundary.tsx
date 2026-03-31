/**
 * @nami/core - React 错误边界组件
 *
 * ErrorBoundary 是基于 React 类组件的错误捕获机制。
 * 当子组件树中抛出 JavaScript 错误时，ErrorBoundary 会：
 * 1. 捕获错误，阻止整个应用崩溃
 * 2. 显示降级 UI（fallback）
 * 3. 通过 ErrorHandler 记录和上报错误
 *
 * React 错误边界的限制（React 官方设计）：
 * - 只能捕获渲染期间、生命周期方法和构造函数中的错误
 * - 无法捕获事件处理函数中的错误
 * - 无法捕获异步代码中的错误（setTimeout、requestAnimationFrame）
 * - 无法捕获 SSR 中的错误
 *
 * 注意：React 18 的 Error Boundary 必须是类组件
 */

import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

import { createLogger } from '@nami/shared';
import { ErrorHandler } from './error-handler';

/** 错误边界内部日志 */
const logger = createLogger('@nami/core:error-boundary');

/**
 * 错误边界组件属性
 */
export interface ErrorBoundaryProps {
  /**
   * 降级 UI
   * 当子组件树发生错误时显示此 UI 替代崩溃的组件树。
   * 可以是 ReactNode 或一个接收 error 参数的渲染函数。
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);

  /**
   * 错误回调
   * 当错误被捕获时调用，可用于自定义错误处理（如上报、弹窗等）。
   *
   * @param error - 捕获到的错误
   * @param errorInfo - React 错误信息，包含组件调用栈
   */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;

  /** 子组件 */
  children: ReactNode;
}

/**
 * 错误边界组件状态
 */
interface ErrorBoundaryState {
  /** 是否已捕获错误 */
  hasError: boolean;
  /** 捕获到的错误实例 */
  error: Error | null;
}

/**
 * React 错误边界组件
 *
 * 包裹在需要错误隔离的组件树外层，防止子组件错误导致整个页面白屏。
 * 支持自定义降级 UI 和错误回调。
 *
 * @example
 * ```tsx
 * // 基础用法 — 静态降级 UI
 * <ErrorBoundary fallback={<div>页面出错了，请刷新重试</div>}>
 *   <PageContent />
 * </ErrorBoundary>
 *
 * // 高级用法 — 带重置按钮的降级 UI
 * <ErrorBoundary
 *   fallback={(error, reset) => (
 *     <div>
 *       <p>发生错误: {error.message}</p>
 *       <button onClick={reset}>重试</button>
 *     </div>
 *   )}
 *   onError={(error, info) => {
 *     // 自定义错误上报
 *     reportToSentry(error, info);
 *   }}
 * >
 *   <PageContent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** 错误处理器实例 */
  private readonly errorHandler: ErrorHandler;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
    this.errorHandler = new ErrorHandler();
  }

  /**
   * React 静态生命周期方法 — 从错误中派生状态
   *
   * 当子组件抛出错误时，React 调用此方法更新 state，
   * 触发重新渲染以显示降级 UI。
   *
   * @param error - 捕获到的错误
   * @returns 新的 state
   */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  /**
   * React 生命周期方法 — 错误捕获后执行副作用
   *
   * 在此方法中执行错误记录、上报等副作用操作。
   * 不应在此方法中调用 setState。
   *
   * @param error - 捕获到的错误
   * @param errorInfo - React 组件调用栈信息
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // 通过 ErrorHandler 记录错误
    this.errorHandler.handle(error, {
      componentStack: errorInfo.componentStack ?? undefined,
      source: 'ErrorBoundary',
    });

    logger.error('React 组件渲染错误被 ErrorBoundary 捕获', {
      message: error.message,
      componentStack: errorInfo.componentStack,
    });

    // 触发用户自定义的错误回调
    this.props.onError?.(error, errorInfo);
  }

  /**
   * 重置错误状态
   *
   * 允许用户通过交互（如点击"重试"按钮）清除错误状态，
   * 重新尝试渲染子组件树。
   */
  private resetError = (): void => {
    this.setState({
      hasError: false,
      error: null,
    });
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { fallback, children } = this.props;

    // 发生错误时显示降级 UI
    if (hasError && error) {
      // fallback 是渲染函数
      if (typeof fallback === 'function') {
        return fallback(error, this.resetError);
      }

      // fallback 是 ReactNode
      if (fallback !== undefined) {
        return fallback;
      }

      // 未提供 fallback，显示默认错误 UI
      return this.renderDefaultFallback(error);
    }

    // 正常渲染子组件
    return children;
  }

  /**
   * 渲染默认的降级 UI
   *
   * 当用户未提供 fallback 时使用。
   * 在生产环境显示友好的错误提示，开发环境显示错误详情。
   */
  private renderDefaultFallback(error: Error): ReactNode {
    const isDev = process.env.NODE_ENV !== 'production';

    return (
      <div
        style={{
          padding: '20px',
          margin: '20px',
          border: '1px solid #ff4d4f',
          borderRadius: '4px',
          backgroundColor: '#fff2f0',
          color: '#cf1322',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <h3 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>
          {'\u9875\u9762\u6E32\u67D3\u51FA\u9519'}
        </h3>
        <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#595959' }}>
          {'\u62B1\u6B49\uFF0C\u9875\u9762\u52A0\u8F7D\u65F6\u53D1\u751F\u4E86\u9519\u8BEF\u3002\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\u3002'}
        </p>
        {isDev && (
          <details style={{ marginTop: '8px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '12px', color: '#8c8c8c' }}>
              {'\u9519\u8BEF\u8BE6\u60C5'}
            </summary>
            <pre
              style={{
                marginTop: '8px',
                padding: '12px',
                backgroundColor: '#fafafa',
                borderRadius: '4px',
                fontSize: '12px',
                overflow: 'auto',
                maxHeight: '200px',
              }}
            >
              {error.message}
              {'\n\n'}
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    );
  }
}
