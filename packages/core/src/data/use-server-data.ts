/**
 * @nami/core - useServerData 钩子
 *
 * 提供统一的服务端数据访问接口。
 * 此钩子是同构的（isomorphic），在服务端和客户端有不同的数据读取策略：
 *
 * - 服务端：从 NamiDataContext 中读取（由 NamiDataProvider 注入）
 * - 客户端：优先从 NamiDataContext 读取，降级时从 window.__NAMI_DATA__ 读取
 *
 * 设计目的：
 * 让业务组件无需关心数据来源，统一使用此 Hook 获取预取数据。
 */

import { isServer, hydrateData, NAMI_DATA_VARIABLE } from '@nami/shared';
import { useNamiContext } from './data-context';

/**
 * useServerData 钩子返回值
 */
interface UseServerDataResult<T> {
  /** 预取到的数据，可能为 null（数据不存在或未预取） */
  data: T | null;
  /** 数据是否处于降级状态 */
  degraded: boolean;
}

/**
 * 获取服务端预取数据的 Hook
 *
 * 支持通过 key 获取特定数据源的数据，不传 key 则返回所有数据。
 * 数据类型通过泛型参数 T 指定，提供完整的类型推导。
 *
 * @typeParam T - 期望的数据类型
 * @param key - 可选的数据键名，用于获取特定数据源的数据
 * @returns 包含 data 和 degraded 状态的对象
 *
 * @example
 * ```tsx
 * // 获取所有预取数据
 * function Page() {
 *   const { data } = useServerData<{ user: User; posts: Post[] }>();
 *   return <div>{data?.user.name}</div>;
 * }
 *
 * // 获取特定 key 的数据
 * function UserCard() {
 *   const { data: user } = useServerData<User>('user');
 *   if (!user) return <Skeleton />;
 *   return <div>{user.name}</div>;
 * }
 *
 * // 处理降级状态
 * function DataAwareComponent() {
 *   const { data, degraded } = useServerData<PageData>();
 *   if (degraded) {
 *     // 服务端数据预取失败，需要客户端重新获取
 *     return <ClientFetcher />;
 *   }
 *   return <Content data={data} />;
 * }
 * ```
 */
export function useServerData<T = Record<string, unknown>>(
  key?: string,
): UseServerDataResult<T> {
  // 优先从 React Context 读取数据
  const context = useNamiContext();

  // 如果 Context 中有数据，直接返回
  if (context.data && Object.keys(context.data).length > 0) {
    return extractData<T>(context.data, context.degraded, key);
  }

  // 客户端降级：从 window.__NAMI_DATA__ 读取
  // 这种情况发生在 Context 未正确传递时（如组件树外的组件）
  if (!isServer()) {
    const windowData = hydrateData<Record<string, unknown>>(NAMI_DATA_VARIABLE);
    if (windowData) {
      return extractData<T>(windowData, false, key);
    }
  }

  // 没有可用数据
  return {
    data: null,
    degraded: context.degraded,
  };
}

/**
 * 从数据对象中提取指定 key 的数据
 *
 * @param source - 完整的数据对象
 * @param degraded - 是否降级
 * @param key - 可选的数据键名
 * @returns 提取后的数据结果
 */
function extractData<T>(
  source: Record<string, unknown>,
  degraded: boolean,
  key?: string,
): UseServerDataResult<T> {
  if (key) {
    // 获取特定 key 的数据
    const value = source[key];
    return {
      data: (value !== undefined ? value : null) as T | null,
      degraded,
    };
  }

  // 返回所有数据
  return {
    data: source as unknown as T,
    degraded,
  };
}
