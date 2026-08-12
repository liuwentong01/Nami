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
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { NamiRoute, NamiConfig, RenderMode } from '@nami/shared';
import { createLogger, RenderMode as RenderModeEnum } from '@nami/shared';
import { NamiDataProvider } from '@nami/core-client-shim';
import { generatedComponentLoaders } from '@nami/generated-route-modules';
import { invalidateServerData } from '../data/data-hydrator';
import { RouteLoadingFallback } from './route-loading-fallback';

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
) => () => Promise<{ default: React.ComponentType<any> }>;

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

  /**
   * 路由加载时的全局 fallback 组件。
   * 未传（undefined）时使用框架默认骨架，显式传 null 可关闭加载 UI。
   */
  loadingFallback?: React.ReactNode;

  /** 当前首屏路由的服务端预取 props。 */
  initialData?: Record<string, unknown>;

  /** 服务端数据预取是否发生了可恢复降级。 */
  initialDataDegraded?: boolean;

  /** initialData 对应的服务端 URL；SSG 仅记录 pathname。 */
  initialRoutePath?: string;

  /** 首屏数据的渲染模式；SSG 按 pathname 复用，SSR/ISR 精确匹配 query。 */
  initialRenderMode?: RenderMode;

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
const lazyComponentCache = new WeakMap<
  ComponentResolver,
  Map<string, React.LazyExoticComponent<React.ComponentType<any>>>
>();

/**
 * 清除指定解析器创建的路由懒加载组件缓存。
 *
 * 路由 chunk 加载失败时，React.lazy 会保留 rejected Promise。错误边界重试前
 * 清除此缓存，下一次挂载才会创建新的 lazy 包装器并重新调用动态 import。
 *
 * @param componentResolver - 要清理的组件解析器；省略时清理框架默认解析器。
 */
export function clearRouteComponentCache(
  componentResolver: ComponentResolver = defaultComponentResolver,
): void {
  lazyComponentCache.get(componentResolver)?.clear();
}

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
): React.LazyExoticComponent<React.ComponentType<any>> {
  let resolverCache = lazyComponentCache.get(resolver);
  if (!resolverCache) {
    resolverCache = new Map();
    lazyComponentCache.set(resolver, resolverCache);
  }

  // 命中缓存直接返回
  const cached = resolverCache.get(componentPath);
  if (cached) return cached;

  // 创建新的 lazy 组件并缓存
  const LazyComponent = React.lazy(resolver(componentPath));
  resolverCache.set(componentPath, LazyComponent);

  return LazyComponent;
}

function formatLocation(location: ReturnType<typeof useLocation>): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function formatDataLocation(location: ReturnType<typeof useLocation>): string {
  return `${location.pathname}${location.search}`;
}

function matchesInitialDataLocation(
  location: ReturnType<typeof useLocation>,
  initialRoutePath: string | undefined,
  initialRenderMode: RenderMode | undefined,
): boolean {
  if (typeof initialRoutePath !== 'string') return false;
  if (initialRenderMode === RenderModeEnum.SSG) {
    return location.pathname === initialRoutePath;
  }
  return formatDataLocation(location) === initialRoutePath;
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
  const previousPathRef = useRef(formatLocation(location));

  useEffect(() => {
    const from = previousPathRef.current;
    const to = formatLocation(location);

    // 路径、查询参数或 hash 确实发生了变化
    if (from !== to) {
      logger.debug('路由变化', { from, to });
      onRouteChange?.({ from, to });
      previousPathRef.current = to;
    }
  }, [location, onRouteChange]);

  return null;
};

RouteChangeListener.displayName = 'RouteChangeListener';

/**
 * 位于 BrowserRouter 内部的路由树。
 *
 * 首屏 props 只允许交给产生它们的初始 URL；一旦发生客户端导航便永久停用，
 * 避免返回初始地址时把旧快照再次注入页面。
 */
const NamiRouteTree: React.FC<NamiRouterProps> = ({
  routes,
  componentResolver = defaultComponentResolver,
  onRouteChange,
  loadingFallback,
  initialData,
  initialDataDegraded,
  initialRoutePath,
  initialRenderMode,
  children,
}) => {
  const location = useLocation();
  const hasLeftInitialRouteRef = useRef(false);
  const currentDataLocation = formatDataLocation(location);
  const canUseInitialData =
    !hasLeftInitialRouteRef.current &&
    matchesInitialDataLocation(location, initialRoutePath, initialRenderMode);
  const isInitialServerRenderedRoute =
    canUseInitialData &&
    initialRenderMode !== undefined &&
    initialRenderMode !== RenderModeEnum.CSR;
  const resolvedLoadingFallback = useMemo(
    () =>
      loadingFallback === undefined ? (
        isInitialServerRenderedRoute ? null : (
          <RouteLoadingFallback />
        )
      ) : (
        loadingFallback
      ),
    [isInitialServerRenderedRoute, loadingFallback],
  );

  useEffect(() => {
    if (
      initialRoutePath &&
      !matchesInitialDataLocation(location, initialRoutePath, initialRenderMode)
    ) {
      hasLeftInitialRouteRef.current = true;
      invalidateServerData();
    }
  }, [currentDataLocation, initialRoutePath, initialRenderMode, location]);

  const routeElements = useMemo(() => {
    function renderRoute(route: NamiRoute): React.ReactNode {
      const LazyComponent = getLazyComponent(route.component, componentResolver);
      const element = (
        <Suspense fallback={resolvedLoadingFallback}>
          <LazyComponent {...(canUseInitialData ? initialData : {})} />
        </Suspense>
      );

      if (route.children && route.children.length > 0) {
        return (
          <Route key={route.path} path={route.path} element={element}>
            {route.children.map(renderRoute)}
          </Route>
        );
      }

      return <Route key={route.path} path={route.path} element={element} />;
    }

    return routes.map(renderRoute);
  }, [routes, componentResolver, resolvedLoadingFallback, initialData, canUseInitialData]);

  return (
    <NamiDataProvider
      initialData={canUseInitialData ? (initialData ?? {}) : {}}
      degraded={canUseInitialData && initialDataDegraded === true}
    >
      <RouteChangeListener onRouteChange={onRouteChange} />
      {children}
      <Routes>{routeElements}</Routes>
    </NamiDataProvider>
  );
};

NamiRouteTree.displayName = 'NamiRouteTree';

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
  loadingFallback,
  initialData,
  initialDataDegraded,
  initialRoutePath,
  initialRenderMode,
  children,
}) => {
  return (
    <BrowserRouter>
      <NamiRouteTree
        routes={routes}
        config={config}
        componentResolver={componentResolver}
        onRouteChange={onRouteChange}
        loadingFallback={loadingFallback}
        initialData={initialData}
        initialDataDegraded={initialDataDegraded}
        initialRoutePath={initialRoutePath}
        initialRenderMode={initialRenderMode}
      >
        {children}
      </NamiRouteTree>
    </BrowserRouter>
  );
};

NamiRouter.displayName = 'NamiRouter';
