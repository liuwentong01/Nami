/**
 * @nami/client - NamiApp 根组件
 *
 * NamiApp 是 Nami 框架客户端应用的最顶层组件，
 * 负责组装和集成以下核心模块：
 *
 * 1. 错误边界（ClientErrorBoundary）
 *    包裹整个应用，捕获任何未处理的渲染错误，防止白屏。
 *
 * 2. 路由系统（NamiRouter）
 *    基于 react-router-dom 的客户端路由，
 *    支持代码分割、嵌套路由和路由级数据加载。
 *
 * 3. 数据层
 *    通过 context 或 props 传递服务端预取的数据。
 *
 * 4. Head 管理
 *    默认的 document.head 配置（标题、描述等）。
 *
 * 组件树结构：
 * ```
 * <ClientErrorBoundary>          // 错误隔离
 *   <NamiHead />                 // 默认头部标签
 *   <NamiRouter>                 // 路由系统
 *     <Route path="/" ... />     // 各路由页面
 *   </NamiRouter>
 * </ClientErrorBoundary>
 * ```
 *
 * @module
 */

import React from 'react';
import type { NamiRoute, NamiConfig } from '@nami/shared';
import { createLogger } from '@nami/shared';
import { ClientErrorBoundary } from './error/client-error-boundary';
import { NamiRouter } from './router/nami-router';
import type { ComponentResolver } from './router/nami-router';
import { NamiHead } from './head/nami-head';

// ==================== 类型定义 ====================

/**
 * NamiApp 组件 Props
 */
export interface NamiAppProps {
  /** 路由配置列表 */
  routes: NamiRoute[];

  /** 框架配置 */
  config: NamiConfig;

  /**
   * 服务端注入的初始数据
   *
   * 从 window.__NAMI_DATA__ 读取后传入此处。
   * 数据将通过 props 或 context 传递给路由页面组件。
   */
  initialData?: Record<string, unknown>;

  /**
   * 组件解析器
   *
   * 负责将路由配置中的 component 路径字符串
   * 转换为实际的 React 组件。
   * 由框架构建阶段的 webpack 插件自动注入。
   */
  componentResolver?: ComponentResolver;

  /**
   * 路由变化回调
   *
   * 每次客户端路由切换时调用。
   * 通常由 entry-client 注入，用于触发插件的 onRouteChange 钩子。
   */
  onRouteChange?: (info: { from: string; to: string }) => void;

  /**
   * 错误回调
   *
   * 应用级错误边界捕获到错误时调用。
   * 通常用于错误上报。
   */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;

  /**
   * 路由加载中的 fallback 组件
   */
  loadingFallback?: React.ReactNode;

  /**
   * 错误降级 UI
   */
  errorFallback?:
    | React.ReactNode
    | ((props: { error: Error; resetErrorBoundary: () => void }) => React.ReactNode);
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:app');

// ==================== 组件实现 ====================

/**
 * Nami 应用根组件
 *
 * 将路由、错误处理、数据层等模块组装为完整的应用组件树。
 * 这是客户端 React 应用的最外层包裹组件。
 *
 * @example
 * ```tsx
 * // 基础用法（由 entry-client 自动调用）
 * <NamiApp
 *   routes={routes}
 *   config={config}
 *   initialData={window.__NAMI_DATA__}
 *   onRouteChange={handleRouteChange}
 *   onError={handleError}
 * />
 *
 * // 自定义错误降级
 * <NamiApp
 *   routes={routes}
 *   config={config}
 *   errorFallback={({ error, resetErrorBoundary }) => (
 *     <div>
 *       <h1>应用出错了</h1>
 *       <p>{error.message}</p>
 *       <button onClick={resetErrorBoundary}>重新加载</button>
 *     </div>
 *   )}
 * />
 * ```
 */
export const NamiApp: React.FC<NamiAppProps> = ({
  routes,
  config,
  initialData,
  componentResolver,
  onRouteChange,
  onError,
  loadingFallback,
  errorFallback,
}) => {
  logger.debug('NamiApp 渲染', {
    routeCount: routes.length,
    hasInitialData: !!initialData,
    appName: config.appName,
  });

  return (
    <ClientErrorBoundary
      fallback={errorFallback}
      onError={(error, errorInfo) => {
        logger.error('应用根错误边界捕获到错误', {
          error: error.message,
          componentStack: errorInfo.componentStack,
        });
        onError?.(error, errorInfo);
      }}
    >
      {/* 默认 Head 配置 — 可被页面级 NamiHead 覆盖 */}
      <NamiHead
        defaultTitle={config.title || config.appName}
        meta={
          config.description
            ? [
                {
                  key: 'description',
                  name: 'description',
                  content: config.description,
                },
              ]
            : undefined
        }
      />

      {/* 路由系统 */}
      <NamiRouter
        routes={routes}
        config={config}
        componentResolver={componentResolver}
        onRouteChange={onRouteChange}
        loadingFallback={loadingFallback}
      />
    </ClientErrorBoundary>
  );
};

NamiApp.displayName = 'NamiApp';
