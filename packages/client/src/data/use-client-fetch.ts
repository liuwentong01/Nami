/**
 * @nami/client - useClientFetch Hook
 *
 * useClientFetch 是一个用于客户端数据请求的 React Hook，
 * 提供类似 SWR / React Query 的开发体验。
 *
 * 核心特性：
 * 1. 自动管理请求状态（loading、error、data 三态）
 * 2. SWR 风格缓存 — 先返回缓存数据，同时后台重新请求
 * 3. 依赖变化自动重新请求 — deps 数组变化时自动触发新请求
 * 4. 组件卸载自动取消请求 — 使用 AbortController 防止内存泄漏
 * 5. 手动刷新能力 — 通过 refetch 方法触发手动重新请求
 *
 * 与 useNamiData 的区别：
 * - useNamiData: 读取服务端在 SSR 阶段注入的静态数据（一次性）
 * - useClientFetch: 在客户端发起 HTTP 请求获取动态数据（可重复）
 *
 * @module
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * useClientFetch 的请求选项
 */
export interface ClientFetchOptions<T> {
  /**
   * HTTP 请求方法
   * @default 'GET'
   */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

  /**
   * 请求头
   */
  headers?: Record<string, string>;

  /**
   * 请求体（POST/PUT/PATCH 时使用）
   */
  body?: unknown;

  /**
   * 依赖列表
   *
   * 当数组中的任何值发生变化时，自动重新发起请求。
   * 类似 useEffect 的依赖数组。
   *
   * @example [userId, page, pageSize]
   */
  deps?: unknown[];

  /**
   * 是否在挂载时立即发起请求
   * 设为 false 时需要手动调用 refetch
   * @default true
   */
  immediate?: boolean;

  /**
   * 缓存时间（毫秒）
   *
   * 在此时间内的重复请求会直接使用缓存结果。
   * 设为 0 禁用缓存。
   * @default 0
   */
  cacheTime?: number;

  /**
   * SWR（Stale-While-Revalidate）模式
   *
   * 启用后：先返回缓存数据（即使已过期），同时在后台重新请求。
   * 新数据返回后自动更新。
   * @default false
   */
  staleWhileRevalidate?: boolean;

  /**
   * 响应数据转换器
   *
   * 对 fetch 返回的 Response 进行自定义解析。
   * 默认使用 response.json()。
   */
  transform?: (response: Response) => Promise<T>;

  /**
   * 请求成功回调
   */
  onSuccess?: (data: T) => void;

  /**
   * 请求失败回调
   */
  onError?: (error: Error) => void;
}

/**
 * useClientFetch 的返回值
 */
export interface ClientFetchResult<T> {
  /** 响应数据（请求成功后填充） */
  data: T | undefined;

  /** 是否正在请求中 */
  loading: boolean;

  /** 请求错误（如果有） */
  error: Error | undefined;

  /**
   * 手动重新请求
   *
   * 调用后立即发起新的请求，忽略缓存。
   */
  refetch: () => Promise<void>;

  /**
   * 手动设置数据
   *
   * 用于乐观更新（Optimistic Update）场景：
   * 先更新 UI，再发送请求，请求失败时回滚。
   */
  mutate: (data: T | ((prev: T | undefined) => T)) => void;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:use-client-fetch');

/**
 * 全局请求缓存
 *
 * key 为 URL + method 组合，value 为 { data, timestamp } 结构。
 * 用于 SWR 模式的缓存复用。
 */
const fetchCache = new Map<string, { data: unknown; timestamp: number }>();

/**
 * 生成缓存键
 */
function getCacheKey(url: string, method: string): string {
  return `${method}:${url}`;
}

// ==================== Hook 实现 ====================

/**
 * 客户端数据请求 Hook
 *
 * @typeParam T - 响应数据类型
 * @param url     - 请求 URL
 * @param options - 请求选项
 * @returns 请求状态和操作方法
 *
 * @example
 * ```tsx
 * // 基础用法 — GET 请求
 * function UserList() {
 *   const { data, loading, error } = useClientFetch<User[]>('/api/users');
 *
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorMessage error={error} />;
 *   return <ul>{data?.map(user => <li key={user.id}>{user.name}</li>)}</ul>;
 * }
 *
 * // 依赖变化自动重新请求
 * function UserPosts({ userId }: { userId: string }) {
 *   const { data, loading } = useClientFetch<Post[]>(
 *     `/api/users/${userId}/posts`,
 *     { deps: [userId] },
 *   );
 *   // userId 变化时自动重新请求
 * }
 *
 * // 手动触发 + SWR 缓存
 * function Dashboard() {
 *   const { data, refetch, mutate } = useClientFetch<Stats>(
 *     '/api/stats',
 *     { staleWhileRevalidate: true, cacheTime: 30000 },
 *   );
 *
 *   return (
 *     <div>
 *       <Stats data={data} />
 *       <button onClick={refetch}>刷新数据</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useClientFetch<T = unknown>(
  url: string,
  options: ClientFetchOptions<T> = {},
): ClientFetchResult<T> {
  const {
    method = 'GET',
    headers,
    body,
    deps = [],
    immediate = true,
    cacheTime = 0,
    staleWhileRevalidate = false,
    transform,
    onSuccess,
    onError,
  } = options;

  // ==================== 状态 ====================

  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(immediate);
  const [error, setError] = useState<Error | undefined>(undefined);

  /**
   * AbortController 引用
   *
   * 用于在组件卸载或依赖变化时取消正在进行的请求。
   * 每次新的请求都会创建新的 AbortController。
   */
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * 组件是否已挂载的标记
   *
   * 用于防止在组件卸载后更新状态（避免 React 警告）。
   */
  const mountedRef = useRef(true);

  /**
   * 缓存键
   */
  const cacheKey = useMemo(() => getCacheKey(url, method), [url, method]);

  // ==================== 请求执行 ====================

  /**
   * 执行请求的核心函数
   *
   * @param ignoreCache - 是否忽略缓存（手动 refetch 时为 true）
   */
  const executeRequest = useCallback(
    async (ignoreCache: boolean = false) => {
      // ---------- SWR 缓存检查 ----------

      if (!ignoreCache && (cacheTime > 0 || staleWhileRevalidate)) {
        const cached = fetchCache.get(cacheKey);

        if (cached) {
          const isStale = Date.now() - cached.timestamp > cacheTime;

          if (!isStale || staleWhileRevalidate) {
            // 缓存有效或 SWR 模式：先使用缓存数据
            if (mountedRef.current) {
              setData(cached.data as T);
              logger.debug('使用缓存数据', { url, isStale });

              if (!isStale) {
                // 缓存未过期，不需要重新请求
                setLoading(false);
                return;
              }
              // SWR 模式：缓存已过期但先展示，继续请求新数据
            }
          }
        }
      }

      // ---------- 取消上一个请求 ----------

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // ---------- 发起请求 ----------

      if (mountedRef.current) {
        setLoading(true);
        setError(undefined);
      }

      try {
        const fetchOptions: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          signal: controller.signal,
        };

        // 添加请求体（非 GET 请求）
        if (body && method !== 'GET') {
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);

        // 检查 HTTP 状态码
        if (!response.ok) {
          throw new Error(
            `请求失败: ${response.status} ${response.statusText}`,
          );
        }

        // 解析响应数据
        const result: T = transform
          ? await transform(response)
          : await response.json();

        // 更新缓存
        if (cacheTime > 0 || staleWhileRevalidate) {
          fetchCache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        // 检查组件是否仍然挂载
        if (mountedRef.current && !controller.signal.aborted) {
          setData(result);
          setLoading(false);
          setError(undefined);
          onSuccess?.(result);
          logger.debug('请求成功', { url });
        }
      } catch (err) {
        // AbortError 表示请求被主动取消，不视为错误
        if (err instanceof DOMException && err.name === 'AbortError') {
          logger.debug('请求被取消', { url });
          return;
        }

        const fetchError =
          err instanceof Error
            ? err
            : new Error(`请求异常: ${String(err)}`);

        if (mountedRef.current && !controller.signal.aborted) {
          setError(fetchError);
          setLoading(false);
          onError?.(fetchError);
          logger.warn('请求失败', { url, error: fetchError.message });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url, method, cacheKey, cacheTime, staleWhileRevalidate],
  );

  // ==================== 副作用 ====================

  /**
   * 组件挂载/依赖变化时自动请求
   */
  useEffect(() => {
    mountedRef.current = true;

    if (immediate) {
      void executeRequest();
    }

    return () => {
      // 组件卸载时取消请求，防止内存泄漏
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immediate, executeRequest, ...deps]);

  // ==================== 返回方法 ====================

  /**
   * 手动重新请求（忽略缓存）
   */
  const refetch = useCallback(async () => {
    await executeRequest(true);
  }, [executeRequest]);

  /**
   * 手动设置数据（乐观更新）
   */
  const mutate = useCallback(
    (newData: T | ((prev: T | undefined) => T)) => {
      if (typeof newData === 'function') {
        setData((prev) => (newData as (prev: T | undefined) => T)(prev));
      } else {
        setData(newData);
      }
    },
    [],
  );

  return {
    data,
    loading,
    error,
    refetch,
    mutate,
  };
}
