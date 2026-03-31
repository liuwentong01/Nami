/**
 * @nami/plugin-request - useRequest React Hook
 *
 * 同构请求 Hook，在服务端和客户端都可使用。
 * 提供声明式的数据请求能力，自动管理 loading/error/data 状态。
 *
 * 核心特性：
 * - 自动发起请求并管理生命周期
 * - 组件卸载时自动取消未完成的请求（防止内存泄漏）
 * - 支持手动触发（manual 模式）
 * - 支持请求依赖（deps 变化时自动重新请求）
 * - 支持轮询（refreshInterval）
 * - TypeScript 泛型支持，自动推导数据类型
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { RequestAdapter, RequestOptions, RequestResponse } from './adapters/server-adapter';
import { RequestError } from './adapters/server-adapter';

/**
 * useRequest 配置选项
 */
export interface UseRequestOptions<T = unknown> extends Omit<RequestOptions, 'signal'> {
  /**
   * 是否手动触发请求
   * true 时不会自动发起请求，需调用返回的 run() 方法
   * @default false
   */
  manual?: boolean;

  /**
   * 依赖项数组
   * 当依赖项变化时自动重新发起请求
   * 类似 useEffect 的 deps
   */
  deps?: unknown[];

  /**
   * 初始数据
   * 在请求完成前使用的默认数据
   */
  initialData?: T;

  /**
   * 轮询间隔（毫秒）
   * 设置后会定期重新发起请求
   * 设为 0 或不设置表示不轮询
   */
  refreshInterval?: number;

  /**
   * 请求成功回调
   */
  onSuccess?: (data: T, response: RequestResponse<T>) => void;

  /**
   * 请求失败回调
   */
  onError?: (error: RequestError) => void;

  /**
   * 数据转换函数
   * 将原始响应数据转换为目标格式
   */
  transformResponse?: (data: unknown) => T;

  /**
   * 是否在窗口获得焦点时重新请求
   * @default false
   */
  refreshOnFocus?: boolean;

  /**
   * 防抖延迟（毫秒）
   * 在连续触发 run() 时，仅在最后一次调用后延迟指定时间才实际发起请求
   */
  debounceInterval?: number;
}

/**
 * useRequest 返回值
 */
export interface UseRequestResult<T> {
  /** 响应数据 */
  data: T | undefined;

  /** 是否正在加载 */
  loading: boolean;

  /** 请求错误 */
  error: RequestError | undefined;

  /**
   * 手动触发请求
   * 可传入覆盖参数
   */
  run: (overrideOptions?: Partial<RequestOptions>) => Promise<T | undefined>;

  /**
   * 手动刷新（使用上次的参数重新请求）
   */
  refresh: () => Promise<T | undefined>;

  /**
   * 手动修改数据
   * 用于乐观更新等场景
   */
  mutate: (data: T | ((prev: T | undefined) => T)) => void;

  /**
   * 取消当前请求
   */
  cancel: () => void;
}

/**
 * 全局请求适配器引用
 * 由插件在初始化时设置
 */
let globalAdapter: RequestAdapter | null = null;

/**
 * 设置全局请求适配器
 * 由 NamiRequestPlugin 在初始化时调用
 *
 * @internal
 */
export function setGlobalAdapter(adapter: RequestAdapter): void {
  globalAdapter = adapter;
}

/**
 * 获取全局请求适配器
 *
 * @internal
 */
export function getGlobalAdapter(): RequestAdapter | null {
  return globalAdapter;
}

/**
 * useRequest - 同构数据请求 Hook
 *
 * 声明式地发起 HTTP 请求，自动管理 loading/error/data 状态。
 * 组件卸载时自动取消未完成的请求。
 *
 * @param url - 请求 URL
 * @param options - 请求选项
 * @returns 包含 data, loading, error, run 等的结果对象
 *
 * @example
 * ```tsx
 * // 基础用法：自动请求
 * function UserProfile({ userId }: { userId: string }) {
 *   const { data, loading, error } = useRequest<User>(
 *     `/api/users/${userId}`,
 *     { deps: [userId] }
 *   );
 *
 *   if (loading) return <Skeleton />;
 *   if (error) return <Error message={error.message} />;
 *   return <div>{data?.name}</div>;
 * }
 *
 * // 手动触发：表单提交
 * function CreateUser() {
 *   const { run, loading } = useRequest<User>('/api/users', {
 *     method: 'POST',
 *     manual: true,
 *   });
 *
 *   const handleSubmit = async (formData: UserForm) => {
 *     await run({ body: formData });
 *   };
 *
 *   return <button disabled={loading} onClick={() => handleSubmit(data)}>提交</button>;
 * }
 * ```
 */
export function useRequest<T = unknown>(
  url: string,
  options: UseRequestOptions<T> = {},
): UseRequestResult<T> {
  const {
    manual = false,
    deps = [],
    initialData,
    refreshInterval,
    onSuccess,
    onError,
    transformResponse,
    refreshOnFocus = false,
    debounceInterval,
    ...requestOptions
  } = options;

  // ==================== 状态管理 ====================

  const [data, setData] = useState<T | undefined>(initialData);
  const [loading, setLoading] = useState<boolean>(!manual);
  const [error, setError] = useState<RequestError | undefined>(undefined);

  // ==================== Refs ====================

  /** AbortController 引用，用于取消请求 */
  const abortControllerRef = useRef<AbortController | null>(null);

  /** 最新的请求选项引用（避免闭包陷阱） */
  const optionsRef = useRef(requestOptions);
  optionsRef.current = requestOptions;

  /** 防抖定时器 */
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 组件是否已卸载 */
  const unmountedRef = useRef(false);

  /** 请求计数器（用于丢弃过时的响应） */
  const requestCountRef = useRef(0);

  // ==================== 核心请求函数 ====================

  /**
   * 执行请求的核心函数
   */
  const fetchData = useCallback(
    async (overrideOptions?: Partial<RequestOptions>): Promise<T | undefined> => {
      const adapter = globalAdapter;
      if (!adapter) {
        const err = new RequestError(
          '[useRequest] 请求适配器未初始化。请确保 NamiRequestPlugin 已正确安装。'
        );
        if (!unmountedRef.current) {
          setError(err);
          setLoading(false);
        }
        onError?.(err);
        return undefined;
      }

      // 取消上一个未完成的请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // 创建新的 AbortController
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // 递增请求计数器
      const currentRequestCount = ++requestCountRef.current;

      if (!unmountedRef.current) {
        setLoading(true);
        setError(undefined);
      }

      try {
        const mergedOptions: RequestOptions = {
          ...optionsRef.current,
          ...overrideOptions,
          signal: controller.signal,
        };

        const response = await adapter.request<T>(url, mergedOptions);

        // 检查响应是否过时（有更新的请求发出了）
        if (currentRequestCount !== requestCountRef.current) {
          return undefined;
        }

        // 检查组件是否已卸载
        if (unmountedRef.current) {
          return undefined;
        }

        // 转换响应数据
        const resultData = transformResponse
          ? transformResponse(response.data)
          : response.data;

        setData(resultData);
        setLoading(false);
        setError(undefined);

        onSuccess?.(resultData, response);
        return resultData;
      } catch (err) {
        // 检查响应是否过时
        if (currentRequestCount !== requestCountRef.current) {
          return undefined;
        }

        // 检查组件是否已卸载
        if (unmountedRef.current) {
          return undefined;
        }

        const requestError =
          err instanceof RequestError
            ? err
            : new RequestError(err instanceof Error ? err.message : String(err));

        // 取消的请求不更新 error 状态
        if (!requestError.isCancelled) {
          setError(requestError);
          setLoading(false);
          onError?.(requestError);
        }

        return undefined;
      }
    },
    [url, onSuccess, onError, transformResponse],
  );

  // ==================== 对外方法 ====================

  /**
   * 手动触发请求（支持防抖）
   */
  const run = useCallback(
    async (overrideOptions?: Partial<RequestOptions>): Promise<T | undefined> => {
      if (debounceInterval && debounceInterval > 0) {
        // 防抖模式
        return new Promise<T | undefined>((resolve) => {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = setTimeout(async () => {
            const result = await fetchData(overrideOptions);
            resolve(result);
          }, debounceInterval);
        });
      }
      return fetchData(overrideOptions);
    },
    [fetchData, debounceInterval],
  );

  /**
   * 刷新请求（使用原始参数）
   */
  const refresh = useCallback(async (): Promise<T | undefined> => {
    return fetchData();
  }, [fetchData]);

  /**
   * 手动修改数据
   */
  const mutate = useCallback(
    (newData: T | ((prev: T | undefined) => T)): void => {
      if (typeof newData === 'function') {
        setData((prev) => (newData as (prev: T | undefined) => T)(prev));
      } else {
        setData(newData);
      }
    },
    [],
  );

  /**
   * 取消当前请求
   */
  const cancel = useCallback((): void => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading(false);
  }, []);

  // ==================== 副作用 ====================

  /**
   * 自动请求（非 manual 模式）
   * 依赖项变化时重新请求
   */
  useEffect(() => {
    if (!manual) {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, ...deps]);

  /**
   * 轮询
   */
  useEffect(() => {
    if (!refreshInterval || refreshInterval <= 0) return;

    const timer = setInterval(() => {
      fetchData();
    }, refreshInterval);

    return () => clearInterval(timer);
  }, [fetchData, refreshInterval]);

  /**
   * 窗口焦点刷新
   */
  useEffect(() => {
    if (!refreshOnFocus || typeof window === 'undefined') return;

    const handleFocus = () => {
      fetchData();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [fetchData, refreshOnFocus]);

  /**
   * 组件卸载清理
   */
  useEffect(() => {
    return () => {
      unmountedRef.current = true;

      // 取消进行中的请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // 清理防抖定时器
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    data,
    loading,
    error,
    run,
    refresh,
    mutate,
    cancel,
  };
}
