/**
 * @nami/plugin-request - usePagination 分页请求 Hook
 *
 * 基于 useRequest 构建的分页数据请求 Hook，支持：
 * - 偏移量分页（offset-based）：page + pageSize
 * - 游标分页（cursor-based）：cursor + limit
 * - 自动管理分页状态和数据
 * - 支持上一页/下一页导航
 * - 支持修改每页大小
 * - 支持跳转到指定页
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRequest, getGlobalAdapter } from '../use-request';
import type { UseRequestOptions } from '../use-request';
import type { RequestOptions } from '../adapters/server-adapter';
import { RequestError } from '../adapters/server-adapter';

// ==================== 偏移量分页 ====================

/**
 * 偏移量分页请求选项
 */
export interface UseOffsetPaginationOptions<T = unknown> extends Omit<UseRequestOptions<T>, 'params'> {
  /**
   * 初始页码
   * @default 1
   */
  initialPage?: number;

  /**
   * 每页数据量
   * @default 20
   */
  initialPageSize?: number;

  /**
   * 页码参数名
   * 发送到后端的查询参数名
   * @default 'page'
   */
  pageParamName?: string;

  /**
   * 每页大小参数名
   * @default 'pageSize'
   */
  pageSizeParamName?: string;

  /**
   * 从响应数据中提取列表数据的函数
   * @default (data) => data.list || data.data || data.items || data
   */
  getList?: (data: T) => unknown[];

  /**
   * 从响应数据中提取总数的函数
   * @default (data) => data.total || data.count || 0
   */
  getTotal?: (data: T) => number;

  /**
   * 额外的查询参数
   * 这些参数会与分页参数合并发送
   */
  extraParams?: Record<string, string | number | boolean>;
}

/**
 * 偏移量分页返回结果
 */
export interface UseOffsetPaginationResult<T, Item = unknown> {
  /** 当前页的列表数据 */
  data: Item[];
  /** 原始响应数据 */
  rawData: T | undefined;
  /** 是否正在加载 */
  loading: boolean;
  /** 请求错误 */
  error: RequestError | undefined;
  /** 当前页码 */
  page: number;
  /** 每页数据量 */
  pageSize: number;
  /** 数据总数 */
  total: number;
  /** 总页数 */
  totalPages: number;
  /** 是否有下一页 */
  hasNext: boolean;
  /** 是否有上一页 */
  hasPrev: boolean;
  /** 跳转到下一页 */
  next: () => void;
  /** 跳转到上一页 */
  prev: () => void;
  /** 跳转到指定页 */
  goTo: (page: number) => void;
  /** 修改每页大小（并重置到第一页） */
  setPageSize: (size: number) => void;
  /** 刷新当前页 */
  refresh: () => Promise<void>;
  /** 重置到第一页并刷新 */
  reset: () => void;
}

/**
 * usePagination - 偏移量分页请求 Hook
 *
 * 自动管理 page/pageSize 参数，向后端请求对应页的数据。
 *
 * @param url - 请求 URL
 * @param options - 分页配置
 * @returns 分页数据和控制方法
 *
 * @example
 * ```tsx
 * function UserList() {
 *   const {
 *     data: users,
 *     page,
 *     totalPages,
 *     loading,
 *     next,
 *     prev,
 *     hasNext,
 *     hasPrev,
 *   } = usePagination<UserListResponse, User>('/api/users', {
 *     initialPageSize: 10,
 *     getList: (data) => data.list,
 *     getTotal: (data) => data.total,
 *   });
 *
 *   return (
 *     <div>
 *       {loading ? <Skeleton /> : users.map(user => <UserCard key={user.id} user={user} />)}
 *       <div>
 *         <button onClick={prev} disabled={!hasPrev}>上一页</button>
 *         <span>{page} / {totalPages}</span>
 *         <button onClick={next} disabled={!hasNext}>下一页</button>
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 */
export function usePagination<T = unknown, Item = unknown>(
  url: string,
  options: UseOffsetPaginationOptions<T> = {},
): UseOffsetPaginationResult<T, Item> {
  const {
    initialPage = 1,
    initialPageSize = 20,
    pageParamName = 'page',
    pageSizeParamName = 'pageSize',
    getList = defaultGetList,
    getTotal = defaultGetTotal,
    extraParams,
    ...requestOptions
  } = options;

  // 分页状态
  const [page, setPage] = useState(initialPage);
  const [pageSize, setPageSizeState] = useState(initialPageSize);
  const [total, setTotal] = useState(0);
  const [list, setList] = useState<Item[]>([]);

  // 构建请求参数
  const params: Record<string, string | number | boolean> = {
    ...extraParams,
    [pageParamName]: page,
    [pageSizeParamName]: pageSize,
  };

  // 使用核心 useRequest
  const {
    data: rawData,
    loading,
    error,
    run,
    refresh: coreRefresh,
  } = useRequest<T>(url, {
    ...requestOptions,
    params,
    deps: [page, pageSize, ...(requestOptions.deps ?? [])],
    onSuccess: (data, response) => {
      // 提取列表和总数
      const newList = getList(data) as Item[];
      const newTotal = getTotal(data);
      setList(newList);
      setTotal(newTotal);
      requestOptions.onSuccess?.(data, response);
    },
  });

  // 计算派生状态
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  // 导航方法
  const next = useCallback(() => {
    if (hasNext) {
      setPage((p) => p + 1);
    }
  }, [hasNext]);

  const prev = useCallback(() => {
    if (hasPrev) {
      setPage((p) => p - 1);
    }
  }, [hasPrev]);

  const goTo = useCallback((targetPage: number) => {
    const validPage = Math.max(1, Math.min(targetPage, totalPages));
    setPage(validPage);
  }, [totalPages]);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1); // 修改每页大小时重置到第一页
  }, []);

  const refresh = useCallback(async () => {
    await coreRefresh();
  }, [coreRefresh]);

  const reset = useCallback(() => {
    setPage(initialPage);
    setTotal(0);
    setList([]);
  }, [initialPage]);

  return {
    data: list,
    rawData,
    loading,
    error,
    page,
    pageSize,
    total,
    totalPages,
    hasNext,
    hasPrev,
    next,
    prev,
    goTo,
    setPageSize,
    refresh,
    reset,
  };
}

// ==================== 游标分页 ====================

/**
 * 游标分页请求选项
 */
export interface UseCursorPaginationOptions<T = unknown> extends Omit<UseRequestOptions<T>, 'params'> {
  /**
   * 每页数据量
   * @default 20
   */
  limit?: number;

  /**
   * 游标参数名
   * @default 'cursor'
   */
  cursorParamName?: string;

  /**
   * 每页大小参数名
   * @default 'limit'
   */
  limitParamName?: string;

  /**
   * 从响应数据中提取列表数据
   */
  getList?: (data: T) => unknown[];

  /**
   * 从响应数据中提取下一页游标
   * 返回 null/undefined 表示没有下一页
   */
  getNextCursor?: (data: T) => string | null | undefined;

  /**
   * 额外的查询参数
   */
  extraParams?: Record<string, string | number | boolean>;
}

/**
 * 游标分页返回结果
 */
export interface UseCursorPaginationResult<T, Item = unknown> {
  /** 当前已加载的所有数据 */
  data: Item[];
  /** 原始响应数据（最后一次请求的） */
  rawData: T | undefined;
  /** 是否正在加载 */
  loading: boolean;
  /** 请求错误 */
  error: RequestError | undefined;
  /** 是否有更多数据 */
  hasMore: boolean;
  /** 加载下一页 */
  loadMore: () => Promise<void>;
  /** 重置并重新加载第一页 */
  reset: () => void;
  /** 刷新（重置并重新加载） */
  refresh: () => Promise<void>;
}

/**
 * useCursorPagination - 游标分页请求 Hook
 *
 * 适用于无限滚动、瀑布流等场景。
 * 每次加载下一页时传递上次返回的游标值。
 *
 * @param url - 请求 URL
 * @param options - 游标分页配置
 * @returns 分页数据和控制方法
 *
 * @example
 * ```tsx
 * function Feed() {
 *   const {
 *     data: posts,
 *     loading,
 *     hasMore,
 *     loadMore,
 *   } = useCursorPagination<FeedResponse, Post>('/api/feed', {
 *     limit: 10,
 *     getList: (data) => data.items,
 *     getNextCursor: (data) => data.nextCursor,
 *   });
 *
 *   return (
 *     <div>
 *       {posts.map(post => <PostCard key={post.id} post={post} />)}
 *       {hasMore && (
 *         <button onClick={loadMore} disabled={loading}>
 *           {loading ? '加载中...' : '加载更多'}
 *         </button>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useCursorPagination<T = unknown, Item = unknown>(
  url: string,
  options: UseCursorPaginationOptions<T> = {},
): UseCursorPaginationResult<T, Item> {
  const {
    limit = 20,
    cursorParamName = 'cursor',
    limitParamName = 'limit',
    getList = defaultGetList,
    getNextCursor = defaultGetNextCursor,
    extraParams,
    ...requestOptions
  } = options;

  // 累积的数据列表
  const [allData, setAllData] = useState<Item[]>([]);
  // 当前游标
  const cursorRef = useRef<string | null | undefined>(undefined);
  // 是否有更多数据
  const [hasMore, setHasMore] = useState(true);

  // 构建请求参数（首次请求不带游标）
  const buildParams = useCallback((): Record<string, string | number | boolean> => {
    const params: Record<string, string | number | boolean> = {
      ...extraParams,
      [limitParamName]: limit,
    };
    if (cursorRef.current) {
      params[cursorParamName] = cursorRef.current;
    }
    return params;
  }, [extraParams, limit, limitParamName, cursorParamName]);

  // 使用手动模式的 useRequest
  const {
    data: rawData,
    loading,
    error,
    run,
  } = useRequest<T>(url, {
    ...requestOptions,
    manual: true,
    onSuccess: (data, response) => {
      const newItems = getList(data) as Item[];
      const nextCursor = getNextCursor(data);

      // 追加数据
      setAllData((prev) => [...prev, ...newItems]);

      // 更新游标
      cursorRef.current = nextCursor;

      // 判断是否有更多数据
      setHasMore(nextCursor !== null && nextCursor !== undefined && newItems.length > 0);

      requestOptions.onSuccess?.(data, response);
    },
  });

  // 自动加载第一页
  useEffect(() => {
    if (!requestOptions.manual) {
      run({ params: buildParams() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载下一页
  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await run({ params: buildParams() });
  }, [hasMore, loading, run, buildParams]);

  // 重置
  const reset = useCallback(() => {
    setAllData([]);
    cursorRef.current = undefined;
    setHasMore(true);
  }, []);

  // 刷新（重置后重新加载第一页）
  const refresh = useCallback(async () => {
    reset();
    // 需要在下一个 tick 执行，确保状态已重置
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    cursorRef.current = undefined;
    await run({ params: { ...extraParams, [limitParamName]: limit } });
  }, [reset, run, extraParams, limitParamName, limit]);

  return {
    data: allData,
    rawData,
    loading,
    error,
    hasMore,
    loadMore,
    reset,
    refresh,
  };
}

// ==================== 默认提取函数 ====================

/**
 * 默认的列表数据提取函数
 * 尝试从常见的字段名中提取列表
 */
function defaultGetList<T>(data: T): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj['list'])) return obj['list'];
    if (Array.isArray(obj['data'])) return obj['data'];
    if (Array.isArray(obj['items'])) return obj['items'];
    if (Array.isArray(obj['records'])) return obj['records'];
    if (Array.isArray(obj['results'])) return obj['results'];
  }
  return [];
}

/**
 * 默认的总数提取函数
 */
function defaultGetTotal<T>(data: T): number {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj['total'] === 'number') return obj['total'];
    if (typeof obj['count'] === 'number') return obj['count'];
    if (typeof obj['totalCount'] === 'number') return obj['totalCount'];
  }
  return 0;
}

/**
 * 默认的游标提取函数
 */
function defaultGetNextCursor<T>(data: T): string | null | undefined {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj['nextCursor'] === 'string') return obj['nextCursor'];
    if (typeof obj['next_cursor'] === 'string') return obj['next_cursor'];
    if (typeof obj['cursor'] === 'string') return obj['cursor'];
    if (obj['nextCursor'] === null) return null;
  }
  return null;
}
