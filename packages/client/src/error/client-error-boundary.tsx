/**
 * @nami/client - ClientErrorBoundary 客户端错误边界
 *
 * React 的 Error Boundary 是唯一能捕获渲染阶段错误的机制。
 * 当子组件树中发生 JavaScript 错误时，Error Boundary 会：
 * 1. 捕获错误，防止整个应用崩溃
 * 2. 显示降级的 UI（fallback）
 * 3. 上报错误信息到监控系统
 *
 * ClientErrorBoundary 在 React 原生 Error Boundary 基础上增强了：
 * - 可自定义的降级 UI（通过 fallback prop）
 * - 错误上报集成（通过 onError 回调）
 * - 一键重试能力（通过 resetKeys 或 onReset 回调）
 * - 开发环境详细错误信息展示
 *
 * 注意事项：
 * - Error Boundary 只能用 class 组件实现（React 限制）
 * - 不能捕获事件处理函数中的错误（只捕获渲染、生命周期、constructor）
 * - 不能捕获异步错误（setTimeout、Promise）
 * - 不能捕获 SSR 错误（服务端需要单独的错误处理）
 *
 * @module
 */

import React from 'react';
import { createLogger, NamiError, ErrorCode, ErrorSeverity } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * 降级 UI 渲染函数的参数
 */
export interface FallbackRenderProps {
  /** 捕获到的错误 */
  error: Error;
  /** 重置错误边界（清除错误状态，重新尝试渲染子组件） */
  resetErrorBoundary: () => void;
}

/**
 * ClientErrorBoundary 组件 Props
 */
export interface ClientErrorBoundaryProps {
  /** 子组件 — 被保护的组件树 */
  children: React.ReactNode;

  /**
   * 降级 UI
   *
   * 支持三种形式：
   * 1. React 元素 — 静态降级内容
   * 2. 渲染函数 — 动态降级内容，接收 error 和 reset 方法
   * 3. React 组件 — 接收 FallbackRenderProps
   */
  fallback?:
    | React.ReactNode
    | ((props: FallbackRenderProps) => React.ReactNode);

  /**
   * 错误回调
   *
   * 当子组件发生错误时调用。
   * 可用于错误上报、日志记录等。
   *
   * @param error - 错误对象
   * @param errorInfo - React 提供的错误信息（含 componentStack）
   */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;

  /**
   * 重置回调
   *
   * 当用户点击重试按钮或 resetKeys 变化时调用。
   * 可用于在重试前清理状态。
   */
  onReset?: () => void;

  /**
   * 重置依赖键列表
   *
   * 当数组中的任何值发生变化时，自动重置错误边界。
   * 适用于路由切换等场景 — 切换到新路由时自动清除错误状态。
   *
   * @example [pathname, userId]
   */
  resetKeys?: unknown[];
}

/**
 * 错误边界内部状态
 */
interface ErrorBoundaryState {
  /** 是否处于错误状态 */
  hasError: boolean;
  /** 捕获到的错误 */
  error: Error | null;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:error-boundary');

// ==================== 组件实现 ====================

/**
 * 客户端错误边界组件
 *
 * 捕获子组件树中的渲染错误，防止整个应用崩溃。
 *
 * @example
 * ```tsx
 * // 基础用法
 * <ClientErrorBoundary
 *   fallback={<div>页面出错了，请刷新重试</div>}
 *   onError={(error, info) => errorReporter.report(error)}
 * >
 *   <App />
 * </ClientErrorBoundary>
 *
 * // 带重试按钮的降级 UI
 * <ClientErrorBoundary
 *   fallback={({ error, resetErrorBoundary }) => (
 *     <div>
 *       <h2>出错了: {error.message}</h2>
 *       <button onClick={resetErrorBoundary}>重试</button>
 *     </div>
 *   )}
 * >
 *   <Dashboard />
 * </ClientErrorBoundary>
 *
 * // 路由切换时自动重置
 * function App() {
 *   const { path } = useRouter();
 *   return (
 *     <ClientErrorBoundary resetKeys={[path]}>
 *       <PageContent />
 *     </ClientErrorBoundary>
 *   );
 * }
 * ```
 */
export class ClientErrorBoundary extends React.Component<
  ClientErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ClientErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  /**
   * 静态方法：从错误中派生状态
   *
   * React 在捕获到渲染错误时调用此方法。
   * 返回的对象将被合并到组件 state 中。
   */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  /**
   * 错误捕获生命周期方法
   *
   * 在子组件树中发生错误后调用。
   * 此处执行错误上报和日志记录。
   *
   * @param error     - 被抛出的错误
   * @param errorInfo - 包含 componentStack 的错误信息
   */
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.error('错误边界捕获到错误', {
      error: error.message,
      componentStack: errorInfo.componentStack,
    });

    // 调用外部错误回调
    this.props.onError?.(error, errorInfo);
  }

  /**
   * props 更新时检查 resetKeys 是否变化
   *
   * 如果 resetKeys 变化（如路由切换），自动清除错误状态。
   */
  componentDidUpdate(prevProps: ClientErrorBoundaryProps): void {
    if (!this.state.hasError) return;

    const { resetKeys } = this.props;
    const prevResetKeys = prevProps.resetKeys;

    // 检查 resetKeys 是否变化
    if (resetKeys && prevResetKeys) {
      const hasChanged = resetKeys.some(
        (key, index) => key !== prevResetKeys[index],
      );

      if (hasChanged) {
        logger.debug('resetKeys 变化，自动重置错误边界');
        this.resetErrorBoundary();
      }
    }
  }

  /**
   * 重置错误边界
   *
   * 清除错误状态，重新渲染子组件树。
   * 可由用户交互（点击重试按钮）或 resetKeys 变化触发。
   */
  resetErrorBoundary = (): void => {
    this.props.onReset?.();
    this.setState({
      hasError: false,
      error: null,
    });
    logger.info('错误边界已重置');
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    // 正常状态 — 渲染子组件
    if (!hasError || !error) {
      return children;
    }

    // 错误状态 — 渲染降级 UI
    if (fallback) {
      // 函数形式的 fallback — 传入 error 和 reset 方法
      if (typeof fallback === 'function') {
        return fallback({
          error,
          resetErrorBoundary: this.resetErrorBoundary,
        });
      }

      // React 元素形式的 fallback
      return fallback;
    }

    // 没有提供 fallback — 使用默认降级 UI
    return React.createElement(
      'div',
      {
        style: {
          padding: '20px',
          textAlign: 'center' as const,
          color: '#666',
        },
      },
      React.createElement('h2', null, '页面出现了问题'),
      React.createElement(
        'p',
        { style: { color: '#999' } },
        process.env.NODE_ENV !== 'production'
          ? error.message
          : '请刷新页面重试',
      ),
      React.createElement(
        'button',
        {
          onClick: this.resetErrorBoundary,
          style: {
            padding: '8px 16px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff',
            cursor: 'pointer',
            marginTop: '12px',
          },
        },
        '重试',
      ),
    );
  }
}
