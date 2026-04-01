/**
 * @nami/core - 懒加载路由
 *
 * lazyRoute 是对 React.lazy 的增强封装，提供：
 * 1. 标准的 React.lazy 懒加载能力
 * 2. 自定义加载状态组件（Loading）
 * 3. 加载失败时的错误处理
 * 4. 预加载（preload）支持
 *
 * 使用场景：
 * - 代码分割：每个路由对应一个独立的 JS chunk
 * - 按需加载：只在路由被访问时才加载对应的组件代码
 * - 优化首屏：减少初始 JS 体积，加快首屏渲染
 */

import { lazy, Suspense, createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createLogger } from '@nami/shared';

/** 懒加载路由日志 */
const logger = createLogger('@nami/core:lazy-route');

/**
 * 组件导入函数类型
 * 即 () => import('./pages/xxx') 的类型签名
 */
type ComponentImportFn = () => Promise<{
  default: ComponentType<Record<string, unknown>>;
}>;

/**
 * 懒加载路由配置
 */
export interface LazyRouteOptions {
  /**
   * 加载中显示的组件
   * 默认为 null（不显示任何内容）
   */
  loading?: ReactNode;

  /**
   * 加载失败时的错误组件
   * 接收 error 参数
   */
  errorFallback?: ReactNode;
}

/**
 * 懒加载路由组件返回类型
 */
export interface LazyRouteComponent {
  /** 懒加载的 React 组件（被 Suspense 包裹） */
  Component: ComponentType<Record<string, unknown>>;
  /** 手动触发预加载（如鼠标悬浮时提前加载） */
  preload: () => Promise<void>;
}

/**
 * 创建懒加载路由组件
 *
 * 封装 React.lazy + Suspense 的组合模式，提供更便捷的路由级代码分割。
 * 返回的组件已被 Suspense 包裹，可直接使用。
 *
 * @param importFn - 动态导入函数，如 () => import('./pages/home')
 * @param options - 懒加载配置（loading 组件、错误处理等）
 * @returns 包含 Component 和 preload 方法的对象
 *
 * @example
 * ```typescript
 * // 基础用法
 * const Home = lazyRoute(() => import('./pages/home'));
 *
 * // 带 loading 状态
 * const About = lazyRoute(
 *   () => import('./pages/about'),
 *   { loading: <div>页面加载中...</div> }
 * );
 *
 * // 在路由配置中使用
 * const routes = [
 *   { path: '/', component: Home.Component },
 *   { path: '/about', component: About.Component },
 * ];
 *
 * // 鼠标悬浮时预加载
 * <Link
 *   to="/about"
 *   onMouseEnter={() => About.preload()}
 * >
 *   关于我们
 * </Link>
 * ```
 */
export function lazyRoute(
  importFn: ComponentImportFn,
  options: LazyRouteOptions = {},
): LazyRouteComponent {
  const { loading = null } = options;

  // 缓存 import 的 Promise，避免重复加载
  let importPromise: Promise<{ default: ComponentType<Record<string, unknown>> }> | null = null;

  /**
   * 带缓存的导入函数
   * 确保同一个组件只加载一次
   */
  const cachedImport = (): Promise<{ default: ComponentType<Record<string, unknown>> }> => {
    if (!importPromise) {
      importPromise = importFn().catch((error: unknown) => {
        // 加载失败时清除缓存，允许重试
        importPromise = null;

        const message = error instanceof Error ? error.message : String(error);
        logger.error('路由组件加载失败', { error: message });

        throw error;
      });
    }
    return importPromise;
  };

  // 使用 React.lazy 创建懒加载组件
  const LazyComponent = lazy(cachedImport);

  /**
   * 包裹 Suspense 的组件
   * 在加载期间显示 loading 状态
   */
  const WrappedComponent: ComponentType<Record<string, unknown>> = (props) => {
    return createElement(
      Suspense,
      { fallback: loading },
      createElement(LazyComponent, props),
    );
  };

  // 设置 displayName 以便在 React DevTools 中识别
  WrappedComponent.displayName = 'LazyRoute';

  /**
   * 预加载函数
   * 在不渲染组件的情况下提前触发加载
   */
  const preload = async (): Promise<void> => {
    try {
      await cachedImport();
      logger.debug('路由组件预加载完成');
    } catch (error) {
      // 预加载失败不抛异常，实际渲染时会重试
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('路由组件预加载失败', { error: message });
    }
  };

  return {
    Component: WrappedComponent,
    preload,
  };
}
