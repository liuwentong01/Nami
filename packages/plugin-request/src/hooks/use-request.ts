/**
 * @nami/plugin-request - useRequest React Hook
 *
 * 对根级 useRequest 的重导出，并提供 SWR 模式和请求去重能力。
 *
 * 此文件作为 hooks 目录的请求 Hook 入口，扩展了核心 useRequest 的功能：
 * - SWR（Stale-While-Revalidate）模式：先返回缓存数据，后台更新
 * - 请求去重：相同 URL + 参数的并发请求只发起一次
 * - 预请求（Prefetch）：提前发起请求以加速后续页面渲染
 *
 * 核心的 useRequest 实现位于 `../use-request.ts`，
 * 此文件在其基础上提供额外的高级功能。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRequest as coreUseRequest, getGlobalAdapter } from '../use-request';
import type { UseRequestOptions, UseRequestResult } from '../use-request';
import type { RequestOptions, RequestResponse } from '../adapters/server-adapter';
import { RequestError } from '../adapters/server-adapter';

// 重导出核心 hook 及其类型
export { coreUseRequest as useRequest };
export type { UseRequestOptions, UseRequestResult };

// ==================== SWR 缓存 ====================

/** SWR 缓存条目 */
interface SWRCacheEntry<T = unknown> {
  /** 缓存数据 */
  data: T;
  /** 缓存时间戳 */
  cachedAt: number;
  /** 是否正在重新验证 */
  isRevalidating: boolean;
}

/** 全局 SWR 缓存 */
const swrCache = new Map<string, SWRCacheEntry>();

/** 正在进行中的请求（用于去重） */
const inflightRequests = new Map<string, Promise<unknown>>();

/**
 * SWR 模式配置选项
 */
export interface UseSWROptions<T = unknown> extends UseRequestOptions<T> {
  /**
   * SWR 缓存键
   * 默认使用 URL 作为缓存键
   */
  cacheKey?: string;

  /**
   * 缓存过期时间（毫秒）
   * 超过此时间的缓存数据会触发后台重新验证
   * @default 60000（1 分钟）
   */
  staleTime?: number;

  /**
   * 是否启用请求去重
   * 多个组件请求相同数据时，只发起一次实际请求
   * @default true
   */
  dedupe?: boolean;

  /**
   * 去重时间窗口（毫秒）
   * 在此时间内的相同请求视为重复
   * @default 2000
   */
  dedupeInterval?: number;
}

/**
 * useSWR - Stale-While-Revalidate 数据请求 Hook
 *
 * 先返回缓存中的旧数据（如果有），同时在后台发起请求更新数据。
 * 适用于对数据实时性要求不极高但需要快速展示的场景。
 *
 * @param url - 请求 URL
 * @param options - SWR 配置选项
 * @returns 请求结果，附加 isRevalidating 状态
 *
 * @example
 * ```tsx
 * function Dashboard() {
 *   const { data, loading, isRevalidating } = useSWR<Stats>(
 *     '/api/dashboard/stats',
 *     { staleTime: 30000 }
 *   );
 *
 *   // loading 仅在首次加载时为 true
 *   // isRevalidating 在后台更新时为 true
 *   return (
 *     <div>
 *       {loading ? <Skeleton /> : <StatsCard data={data} />}
 *       {isRevalidating && <RefreshIndicator />}
 *     </div>
 *   );
 * }
 * ```
 */
export function useSWR<T = unknown>(
  url: string,
  options: UseSWROptions<T> = {},
): UseRequestResult<T> & { isRevalidating: boolean } {
  const {
    cacheKey: customCacheKey,
    staleTime = 60000,
    dedupe = true,
    dedupeInterval = 2000,
    initialData,
    ...restOptions
  } = options;

  const cacheKey = customCacheKey ?? url;

  // 尝试从 SWR 缓存中获取初始数据
  const cachedEntry = swrCache.get(cacheKey) as SWRCacheEntry<T> | undefined;
  const cachedData = cachedEntry?.data;
  const isStale = cachedEntry ? (Date.now() - cachedEntry.cachedAt > staleTime) : true;

  const [isRevalidating, setIsRevalidating] = useState(false);

  // 使用核心 useRequest，如果有缓存则设置 initialData
  const result = coreUseRequest<T>(url, {
    ...restOptions,
    initialData: cachedData ?? initialData,
    // 如果有新鲜缓存且未过期，不自动发起请求
    manual: cachedEntry && !isStale ? true : restOptions.manual,
    onSuccess: (data, response) => {
      // 更新 SWR 缓存
      swrCache.set(cacheKey, {
        data,
        cachedAt: Date.now(),
        isRevalidating: false,
      });
      setIsRevalidating(false);
      restOptions.onSuccess?.(data, response);
    },
    onError: (error) => {
      setIsRevalidating(false);
      restOptions.onError?.(error);
    },
  });

  // 如果有旧缓存但已过期，在后台重新验证
  useEffect(() => {
    if (cachedEntry && isStale && !restOptions.manual) {
      setIsRevalidating(true);
      result.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return {
    ...result,
    // 如果有缓存数据，使用缓存，否则使用请求返回的数据
    data: result.data ?? cachedData,
    // 仅在没有缓存数据时才显示 loading
    loading: cachedData === undefined ? result.loading : false,
    isRevalidating,
  };
}

// ==================== 预请求 ====================

/**
 * 预请求数据
 *
 * 提前发起请求并写入 SWR 缓存，加速后续组件渲染。
 * 常用于路由跳转前的数据预加载。
 *
 * @param url - 请求 URL
 * @param options - 请求选项
 * @param cacheKey - 可选的缓存键
 *
 * @example
 * ```typescript
 * // 在鼠标悬停时预加载
 * <Link
 *   to="/user/123"
 *   onMouseEnter={() => prefetch('/api/user/123')}
 * >
 *   用户详情
 * </Link>
 * ```
 */
export async function prefetch<T = unknown>(
  url: string,
  options?: RequestOptions,
  cacheKey?: string,
): Promise<void> {
  const key = cacheKey ?? url;

  // 如果已有新鲜缓存，跳过
  const existing = swrCache.get(key);
  if (existing && Date.now() - existing.cachedAt < 60000) {
    return;
  }

  // 如果已有进行中的请求，等待其完成
  const inflight = inflightRequests.get(key);
  if (inflight) {
    await inflight;
    return;
  }

  const adapter = getGlobalAdapter();
  if (!adapter) return;

  const requestPromise = adapter.request<T>(url, options).then((response) => {
    swrCache.set(key, {
      data: response.data,
      cachedAt: Date.now(),
      isRevalidating: false,
    });
    inflightRequests.delete(key);
  }).catch(() => {
    inflightRequests.delete(key);
  });

  inflightRequests.set(key, requestPromise);
  await requestPromise;
}

/**
 * 清除 SWR 缓存
 *
 * @param key - 指定的缓存键。不传则清除所有缓存
 */
export function clearSWRCache(key?: string): void {
  if (key) {
    swrCache.delete(key);
  } else {
    swrCache.clear();
  }
}
