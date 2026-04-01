/**
 * @nami/plugin-error-boundary - 路由级错误边界组件
 *
 * RouteErrorBoundary 为每个路由页面提供独立的错误隔离。
 * 当某个页面组件发生渲染错误时，仅该路由展示错误 UI，
 * 不影响应用的其他部分（如导航栏、侧边栏等）。
 *
 * 与全局错误边界的区别：
 * - 全局错误边界：包裹整个应用，捕获所有未处理的错误
 * - 路由错误边界：仅包裹单个路由页面，粒度更细
 *
 * React 错误边界原理：
 * React 没有函数组件版本的错误边界，必须使用 class 组件。
 * 通过 static getDerivedStateFromError 和 componentDidCatch 捕获子组件的渲染错误。
 */

import React from 'react';
import { ErrorFallback } from './error-fallback';
import type { ErrorFallbackProps } from './error-fallback';

/**
 * 路由错误边界属性
 */
export interface RouteErrorBoundaryProps {
  /**
   * 自定义错误回退组件
   * 不提供时使用内置的 ErrorFallback
   */
  fallback?: React.ComponentType<ErrorFallbackProps>;

  /**
   * 错误发生时的回调
   * 可用于上报错误到监控系统
   */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;

  /**
   * 错误恢复时的回调
   */
  onReset?: () => void;

  /**
   * 路由路径标识
   * 当路由切换时自动清除错误状态
   */
  routePath?: string;

  /** 子组件 */
  children?: React.ReactNode;
}

/**
 * 路由错误边界状态
 */
interface RouteErrorBoundaryState {
  /** 是否存在错误 */
  hasError: boolean;
  /** 捕获的错误对象 */
  error: Error | null;
}

/**
 * 路由级错误边界组件
 *
 * 每个路由页面包裹一个独立的错误边界，实现：
 * - 单页面错误隔离（一个页面崩了不影响其他页面）
 * - 路由切换时自动恢复（切到新页面时清除错误状态）
 * - 支持自定义降级 UI
 *
 * @example
 * ```tsx
 * // 基础用法
 * <RouteErrorBoundary>
 *   <ProductPage />
 * </RouteErrorBoundary>
 *
 * // 自定义降级组件
 * <RouteErrorBoundary
 *   fallback={MyCustomError}
 *   onError={(error) => reportError(error)}
 * >
 *   <ProductPage />
 * </RouteErrorBoundary>
 *
 * // 路由切换时自动恢复
 * <RouteErrorBoundary routePath={location.pathname}>
 *   <Outlet />
 * </RouteErrorBoundary>
 * ```
 */
export class RouteErrorBoundary extends React.Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  constructor(props: RouteErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  /**
   * 从错误中派生状态
   *
   * React 在子组件树渲染过程中抛出错误时调用此静态方法。
   * 返回的对象将合并到 state 中。
   */
  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  /**
   * 当路由路径变化时，自动清除错误状态
   *
   * 用户通过导航切换到其他页面时，之前页面的错误不应该持续展示。
   */
  static getDerivedStateFromProps(
    props: RouteErrorBoundaryProps,
    state: RouteErrorBoundaryState,
  ): Partial<RouteErrorBoundaryState> | null {
    // 仅在有错误且 routePath 发生变化时重置
    // 利用 prevRoutePath 存储在 state 中会比较复杂，
    // 这里简化处理：如果 routePath 变了，直接重置
    if (state.hasError && props.routePath !== undefined) {
      // getDerivedStateFromProps 在每次渲染时都调用
      // 我们需要一种方式检测 routePath 是否变化
      // 通过比较存储在错误中的路径实现
      const errorRoutePath = (state.error as ErrorWithRoute)?.['__routePath'];
      if (errorRoutePath !== undefined && errorRoutePath !== props.routePath) {
        return { hasError: false, error: null };
      }
    }
    return null;
  }

  /**
   * 错误捕获回调
   *
   * 在子组件树渲染过程中抛出错误后调用。
   * 用于记录错误信息和上报。
   */
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // 在错误上附加路由路径信息
    if (this.props.routePath) {
      (error as ErrorWithRoute)['__routePath'] = this.props.routePath;
    }

    // 触发外部错误回调
    this.props.onError?.(error, errorInfo);
  }

  /**
   * 重置错误状态
   *
   * 清除错误，重新渲染子组件。
   * 如果子组件仍然有问题，会再次被捕获。
   */
  resetError = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback: FallbackComponent } = this.props;

    if (hasError && error) {
      // 使用自定义回退组件或默认的 ErrorFallback
      const Fallback = FallbackComponent ?? ErrorFallback;
      return React.createElement(Fallback, {
        error,
        resetError: this.resetError,
      });
    }

    return children;
  }
}

/**
 * 带路由路径标记的错误对象（内部类型）
 */
interface ErrorWithRoute extends Error {
  __routePath?: string;
}
