/**
 * @nami/client - useRouter Hook
 *
 * useRouter 是 Nami 框架提供的统一路由 Hook，
 * 对 react-router-dom v6 的多个 Hook 进行封装和整合。
 *
 * 设计目的：
 * 1. 统一 API — 将 useLocation、useNavigate、useParams、useSearchParams
 *    整合为一个 Hook，减少导入和记忆成本
 * 2. 类型安全 — 提供强类型的 query 和 params 访问
 * 3. 便捷方法 — 提供 push、replace、back、forward 等常用导航方法
 * 4. 框架一致 — 与 Next.js useRouter 等业界 API 保持一致的使用体验
 *
 * @module
 */

import { useMemo, useCallback } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * Nami 路由状态和操作接口
 *
 * 包含当前路由的所有状态信息和导航操作方法。
 */
export interface NamiRouterState {
  // ==================== 状态属性 ====================

  /**
   * 当前路径（不含查询参数和 hash）
   * @example '/user/123'
   */
  path: string;

  /**
   * 完整 URL（含路径、查询参数、hash）
   * @example '/user/123?tab=posts#section'
   */
  fullPath: string;

  /**
   * URL 查询参数对象
   *
   * 将 URLSearchParams 转换为普通对象，便于使用。
   * 对于同名多值参数，保留最后一个值。
   *
   * @example { tab: 'posts', page: '2' }
   */
  query: Record<string, string>;

  /**
   * 路由动态参数
   *
   * 从路由配置的动态段（如 /user/:id）中解析出的参数。
   *
   * @example 路由 /user/:id 匹配 /user/123 → { id: '123' }
   */
  params: Record<string, string>;

  /**
   * URL hash 值（含 # 前缀）
   * @example '#section'
   */
  hash: string;

  // ==================== 导航方法 ====================

  /**
   * 导航到指定路径（添加历史记录）
   *
   * 等同于浏览器前进，用户可以通过后退按钮回到上一个页面。
   *
   * @param path - 目标路径
   * @param options - 可选的导航选项
   *
   * @example
   * router.push('/dashboard');
   * router.push('/search?q=nami');
   */
  push: (path: string, options?: NavigateOptions) => void;

  /**
   * 替换当前路径（不添加历史记录）
   *
   * 当前历史记录条目被新路径替换，用户无法通过后退回到被替换的页面。
   * 适用场景：表单提交后的跳转、登录后的重定向。
   *
   * @param path - 目标路径
   * @param options - 可选的导航选项
   *
   * @example
   * router.replace('/login-success');
   */
  replace: (path: string, options?: NavigateOptions) => void;

  /**
   * 后退一步
   * 等同于浏览器后退按钮
   */
  back: () => void;

  /**
   * 前进一步
   * 等同于浏览器前进按钮
   */
  forward: () => void;

  /**
   * 跳转到历史记录中的指定位置
   *
   * @param delta - 相对于当前位置的偏移量。正数前进，负数后退。
   *
   * @example
   * router.go(-2); // 后退两步
   * router.go(1);  // 前进一步
   */
  go: (delta: number) => void;
}

/**
 * 导航选项
 */
export interface NavigateOptions {
  /**
   * 传递给目标页面的状态数据
   *
   * 这些数据不会出现在 URL 中，但可以在目标页面通过 location.state 读取。
   * 适合传递不适合放在 URL 中的临时数据。
   */
  state?: unknown;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:use-router');

/**
 * 将 URLSearchParams 转换为普通对象
 *
 * @param searchParams - URLSearchParams 实例
 * @returns 普通键值对象
 */
function searchParamsToObject(searchParams: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

// ==================== Hook 实现 ====================

/**
 * Nami 路由 Hook
 *
 * 整合 react-router-dom 的路由状态和导航能力为统一接口。
 *
 * @returns 路由状态和操作方法
 *
 * @example
 * ```tsx
 * function MyPage() {
 *   const router = useRouter();
 *
 *   // 读取路由状态
 *   console.log(router.path);      // '/user/123'
 *   console.log(router.params.id); // '123'
 *   console.log(router.query.tab); // 'posts'
 *
 *   // 导航操作
 *   const handleClick = () => {
 *     router.push('/dashboard');
 *   };
 *
 *   const handleReplace = () => {
 *     router.replace('/login');
 *   };
 *
 *   return (
 *     <div>
 *       <p>当前路径: {router.path}</p>
 *       <button onClick={handleClick}>去控制台</button>
 *       <button onClick={() => router.back()}>返回</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useRouter(): NamiRouterState {
  // 获取 react-router-dom 的路由原始数据
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();

  // ==================== 导航方法 ====================

  /**
   * push 导航 — 添加历史记录条目
   */
  const push = useCallback(
    (path: string, options?: NavigateOptions) => {
      logger.debug('push 导航', { path });
      navigate(path, { state: options?.state });
    },
    [navigate],
  );

  /**
   * replace 导航 — 替换当前历史记录
   */
  const replace = useCallback(
    (path: string, options?: NavigateOptions) => {
      logger.debug('replace 导航', { path });
      navigate(path, { replace: true, state: options?.state });
    },
    [navigate],
  );

  /**
   * 后退一步
   */
  const back = useCallback(() => {
    logger.debug('后退导航');
    navigate(-1);
  }, [navigate]);

  /**
   * 前进一步
   */
  const forward = useCallback(() => {
    logger.debug('前进导航');
    navigate(1);
  }, [navigate]);

  /**
   * 跳转到指定历史记录位置
   */
  const go = useCallback(
    (delta: number) => {
      logger.debug('go 导航', { delta });
      navigate(delta);
    },
    [navigate],
  );

  // ==================== 构造返回值 ====================

  /**
   * 使用 useMemo 缓存 query 对象
   *
   * URLSearchParams 每次 render 都会生成新实例，
   * 但只有当搜索参数的字符串表示变化时才需要重新计算 query 对象。
   */
  const query = useMemo(
    () => searchParamsToObject(searchParams),
    [searchParams],
  );

  /**
   * 使用 useMemo 缓存 params 对象
   *
   * useParams 返回的对象引用可能在每次 render 时变化，
   * 但实际内容通常只在路径变化时才改变。
   */
  const safeParams = useMemo(
    () => (params as Record<string, string>) ?? {},
    [params],
  );

  /**
   * 完整路径字符串
   */
  const fullPath = useMemo(
    () => `${location.pathname}${location.search}${location.hash}`,
    [location.pathname, location.search, location.hash],
  );

  return {
    path: location.pathname,
    fullPath,
    query,
    params: safeParams,
    hash: location.hash,
    push,
    replace,
    back,
    forward,
    go,
  };
}
