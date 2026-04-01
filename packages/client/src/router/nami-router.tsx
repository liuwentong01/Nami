/**
 * @nami/client - NamiRouter 路由组件
 *
 * NamiRouter 是 Nami 框架客户端路由的核心组件，基于 react-router-dom v6 封装。
 *
 * 功能：
 * 1. 包裹 BrowserRouter，提供客户端路由能力
 * 2. 将 NamiRoute 配置转换为 react-router-dom 的 Route 组件树
 * 3. 支持 React.lazy 代码分割 — 每个路由对应一个独立的 JS chunk
 * 4. 支持嵌套路由（通过 children 递归生成 Route 树）
 * 5. 提供路由变化监听（用于触发 onRouteChange 插件钩子）
 *
 * 路由懒加载机制：
 * - 使用 React.lazy() 包裹路由组件的动态 import
 * - 每个路由组件被 Suspense 包裹，加载期间显示 fallback
 * - 配合 route-prefetch 模块可实现 hover 或 viewport 预加载
 *
 * @module
 */

import React, { Suspense, useMemo, useEffect, useRef } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import type { NamiRoute, NamiConfig } from '@nami/shared';
import { createLogger } from '@nami/shared';
import { generatedComponentLoaders } from '@nami/generated-route-modules';

// ==================== 类型定义 ====================

/**
 * 路由组件解析器
 *
 * 将路由配置中的组件路径（字符串）解析为 React 组件。
 * 框架在构建阶段（webpack 插件）会将组件路径转换为实际的 import 函数。
 *
 * @param componentPath - 组件文件路径（如 './pages/home'）
 * @returns 返回 Promise 的动态 import 函数
 */
export type ComponentResolver = (
  componentPath: string,
) => () => Promise<{ default: React.ComponentType<unknown> }>;

/**
 * NamiRouter 组件的 Props
 */
export interface NamiRouterProps {
  /** 路由配置列表 */
  routes: NamiRoute[];

  /** 框架配置 */
  config: NamiConfig;

  /**
   * 组件解析器
   * 负责将路由配置中的 component 字符串路径解析为可动态导入的函数。
   * 默认使用内置的动态 import 解析器。
   */
  componentResolver?: ComponentResolver;

  /**
   * 路由变化回调
   * 每次路由切换时触发，传入 from 和 to 路径
   */
  onRouteChange?: (info: { from: string; to: string }) => void;

  /** 路由加载时的全局 fallback 组件 */
  loadingFallback?: React.ReactNode;

  /** 子组件 — 放置在 Routes 外部的全局内容 */
  children?: React.ReactNode;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:router');

/**
 * 默认的组件解析器
 *
 * 默认使用构建阶段生成的静态模块映射来加载路由组件。
 * 这样既保留页面级懒加载能力，也避免表达式 import 导致的 webpack
 * `Critical dependency` 告警。
 */
const defaultComponentResolver: ComponentResolver = (componentPath: string) => {
  return () => {
    const loadComponent = generatedComponentLoaders[componentPath];

    if (!loadComponent) {
      const error = new Error(
        `未找到路由组件加载器: ${componentPath}。请检查路由配置，或通过 initNamiClient({ componentResolver }) 传入自定义解析器。`,
      );

      logger.error('路由组件加载失败', {
        componentPath,
        error: error.message,
      });

      return Promise.reject(error);
    }

    return loadComponent().catch((error) => {
      logger.error('路由组件加载失败', {
        componentPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  };
};

/**
 * 已缓存的懒加载组件映射
 *
 * 使用 Map 缓存已创建的 React.lazy 组件，
 * 避免每次路由切换时重新创建 lazy 包装器。
 * key 为组件路径，value 为 React.lazy 返回的组件。
 */
const lazyComponentCache = new Map<string, React.LazyExoticComponent<React.ComponentType<unknown>>>();

/**
 * 获取或创建懒加载组件
 *
 * @param componentPath - 组件文件路径
 * @param resolver      - 组件解析器
 * @returns React.lazy 包装的组件
 */
function getLazyComponent(
  componentPath: string,
  resolver: ComponentResolver,
): React.LazyExoticComponent<React.ComponentType<unknown>> {
  // 命中缓存直接返回
  const cached = lazyComponentCache.get(componentPath);
  if (cached) return cached;

  // 创建新的 lazy 组件并缓存
  const LazyComponent = React.lazy(resolver(componentPath));
  lazyComponentCache.set(componentPath, LazyComponent);

  return LazyComponent;
}

// ==================== 内部组件 ====================

/**
 * 路由变化监听器组件
 *
 * 必须放在 BrowserRouter 内部才能使用 useLocation。
 * 监听 location 变化，触发外部回调。
 */
const RouteChangeListener: React.FC<{
  onRouteChange?: (info: { from: string; to: string }) => void;
}> = ({ onRouteChange }) => {
  const location = useLocation();
  /** 保存上一个路径，用于 from 参数 */
  const previousPathRef = useRef(location.pathname);

  useEffect(() => {
    const from = previousPathRef.current;
    const to = location.pathname;

    // 路径确实发生了变化
    if (from !== to) {
      logger.debug('路由变化', { from, to });
      onRouteChange?.({ from, to });
      previousPathRef.current = to;
    }
  }, [location.pathname, onRouteChange]);

  return null;
};

RouteChangeListener.displayName = 'RouteChangeListener';

// ==================== 主组件 ====================

/**
 * Nami 路由组件
 *
 * 将 NamiRoute 配置渲染为 react-router-dom 的路由树。
 *
 * @example
 * ```tsx
 * <NamiRouter
 *   routes={routes}
 *   config={config}
 *   onRouteChange={({ from, to }) => {
 *     analytics.trackPageView(to);
 *   }}
 *   loadingFallback={<PageSkeleton />}
 * />
 * ```
 */
export const NamiRouter: React.FC<NamiRouterProps> = ({
  routes,
  config,
  componentResolver = defaultComponentResolver,
  onRouteChange,
  loadingFallback = null,
  children,
}) => {
  /**
   * 递归渲染路由树
   *
   * 将 NamiRoute[] 转换为 <Route> 组件树。
   * 每个路由组件使用 React.lazy 进行代码分割。
   *
   * useMemo 缓存路由树，避免 routes 未变化时重复创建组件。
   */
  const routeElements = useMemo(() => {
    /**
     * 递归函数：将单个 NamiRoute 及其子路由转换为 Route 元素
     */
    function renderRoute(route: NamiRoute): React.ReactNode {
      const LazyComponent = getLazyComponent(route.component, componentResolver);

      /**
       * 每个路由组件被 Suspense 包裹：
       * - 组件 JS chunk 加载完成前显示 loadingFallback
       * - 加载完成后自动渲染目标组件
       */
      const element = (
        <Suspense fallback={loadingFallback}>
          <LazyComponent />
        </Suspense>
      );

      // 有子路由时递归生成嵌套 Route
      if (route.children && route.children.length > 0) {
        return (
          <Route key={route.path} path={route.path} element={element}>
            {route.children.map(renderRoute)}
          </Route>
        );
      }

      // 叶子路由
      return <Route key={route.path} path={route.path} element={element} />;
    }

    return routes.map(renderRoute);
  }, [routes, componentResolver, loadingFallback]);

  return (
    <BrowserRouter>
      {/* 路由变化监听器 — 必须在 BrowserRouter 内部 */}
      <RouteChangeListener onRouteChange={onRouteChange} />

      {/* 全局内容（如 Header、Footer） */}
      {children}

      {/* 路由出口 */}
      <Routes>{routeElements}</Routes>
    </BrowserRouter>
  );
};

NamiRouter.displayName = 'NamiRouter';
