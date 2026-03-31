/**
 * @nami/core - 数据上下文
 *
 * 基于 React Context 实现的服务端数据传递机制。
 * 在 SSR 场景中，服务端预取的数据通过 NamiDataProvider 注入到组件树，
 * 子组件通过 useNamiContext() 钩子读取数据。
 *
 * 数据流：
 * 1. 服务端：PrefetchManager 执行数据预取 → 结果注入 NamiDataProvider
 * 2. 客户端：从 window.__NAMI_DATA__ 读取数据 → 注入 NamiDataProvider
 * 3. 组件：通过 useNamiContext() 读取 Context 中的数据
 */

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Nami 数据上下文的值类型
 *
 * 包含服务端预取的数据和请求级元信息，
 * 通过 Provider 传递给整个组件树。
 */
export interface NamiDataContextValue {
  /** 服务端预取的页面数据 */
  data: Record<string, unknown>;
  /** 数据是否处于降级状态（部分数据缺失） */
  degraded: boolean;
  /** 当前请求的唯一标识（用于日志追踪） */
  requestId?: string;
}

/**
 * Nami 数据上下文
 *
 * 默认值为空数据、非降级状态。
 * 在客户端如果没有 Provider 包裹，组件会读取到默认值，
 * 此时应该触发客户端数据获取逻辑。
 */
export const NamiDataContext = createContext<NamiDataContextValue>({
  data: {},
  degraded: false,
});

// 设置 displayName 以便在 React DevTools 中识别
NamiDataContext.displayName = 'NamiDataContext';

/**
 * NamiDataProvider 组件属性
 */
export interface NamiDataProviderProps {
  /** 服务端预取的初始数据 */
  initialData: Record<string, unknown>;
  /** 数据是否降级 */
  degraded?: boolean;
  /** 请求 ID */
  requestId?: string;
  /** 子组件 */
  children: ReactNode;
}

/**
 * Nami 数据提供者组件
 *
 * 将服务端预取的数据注入 React 组件树。
 * 在 SSR 和客户端 hydrate 时都需要使用此组件包裹应用根组件。
 *
 * @example
 * ```tsx
 * // 服务端渲染入口
 * const html = renderToString(
 *   <NamiDataProvider
 *     initialData={prefetchResult.data}
 *     degraded={prefetchResult.degraded}
 *     requestId={context.requestId}
 *   >
 *     <App />
 *   </NamiDataProvider>
 * );
 *
 * // 客户端 hydrate 入口
 * const initialData = window.__NAMI_DATA__ || {};
 * hydrateRoot(
 *   container,
 *   <NamiDataProvider initialData={initialData}>
 *     <App />
 *   </NamiDataProvider>
 * );
 * ```
 */
export function NamiDataProvider({
  initialData,
  degraded = false,
  requestId,
  children,
}: NamiDataProviderProps): JSX.Element {
  const contextValue: NamiDataContextValue = {
    data: initialData,
    degraded,
    requestId,
  };

  return (
    <NamiDataContext.Provider value={contextValue}>
      {children}
    </NamiDataContext.Provider>
  );
}

/**
 * 读取 Nami 数据上下文
 *
 * 在任意子组件中调用此 Hook 获取服务端预取的数据。
 * 如果组件未被 NamiDataProvider 包裹，将返回默认空值。
 *
 * @returns NamiDataContextValue — 包含 data、degraded、requestId
 *
 * @example
 * ```tsx
 * function UserProfile() {
 *   const { data, degraded } = useNamiContext();
 *   const user = data.user as UserType;
 *
 *   if (degraded) {
 *     return <div>数据加载中...</div>;
 *   }
 *
 *   return <div>{user.name}</div>;
 * }
 * ```
 */
export function useNamiContext(): NamiDataContextValue {
  return useContext(NamiDataContext);
}
