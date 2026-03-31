/**
 * @nami/client - useNamiData Hook
 *
 * useNamiData 是 Nami 框架客户端获取服务端注入数据的核心 Hook。
 *
 * 数据流向：
 * 1. 服务端：getServerSideProps / getStaticProps 返回数据
 * 2. 服务端：数据被序列化为 JSON 并注入到 HTML 的 <script> 标签中
 *    → window.__NAMI_DATA__ = { "pageData": { ... } }
 * 3. 客户端：useNamiData 读取 window.__NAMI_DATA__ 获取数据
 * 4. 客户端：数据作为 React 组件的初始 props 使用
 *
 * 这种模式确保了：
 * - SSR 页面在 Hydration 时不需要重复的数据请求
 * - 客户端渲染使用与服务端完全相同的数据，避免 Hydration 不匹配
 * - 开发者可以在组件中以 Hook 的方式便捷地访问预取数据
 *
 * @module
 */

import { useMemo } from 'react';
import { NAMI_DATA_VARIABLE, createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * 声明 window 上的 Nami 数据全局变量
 *
 * 服务端在渲染 HTML 时通过 <script> 标签注入此变量。
 * TypeScript 中需要显式声明才能安全访问。
 */
declare global {
  interface Window {
    /** Nami 框架注入的服务端预取数据 */
    __NAMI_DATA__?: Record<string, unknown>;
  }
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:use-nami-data');

/** 空对象常量 — 作为默认返回值，保证引用稳定性 */
const EMPTY_OBJECT = Object.freeze({}) as Record<string, unknown>;

// ==================== Hook 实现 ====================

/**
 * 获取服务端注入数据的 Hook
 *
 * 从 window.__NAMI_DATA__ 中读取服务端预取的数据。
 * 支持通过泛型参数指定返回数据的类型。
 *
 * @typeParam T - 数据类型，默认为 Record<string, unknown>
 * @param key - 可选的数据键名。
 *              指定时返回 window.__NAMI_DATA__[key] 的值；
 *              不指定时返回整个 window.__NAMI_DATA__ 对象。
 * @returns 服务端注入的数据，如果不存在则返回空对象或 undefined
 *
 * @example
 * ```tsx
 * // 获取整个数据对象
 * interface PageData {
 *   user: { name: string; avatar: string };
 *   posts: Array<{ id: number; title: string }>;
 * }
 * function MyPage() {
 *   const data = useNamiData<PageData>();
 *   return <h1>{data.user?.name}</h1>;
 * }
 *
 * // 按 key 获取特定数据
 * interface UserInfo {
 *   name: string;
 *   avatar: string;
 * }
 * function UserProfile() {
 *   const user = useNamiData<UserInfo>('user');
 *   return <span>{user?.name}</span>;
 * }
 *
 * // SSG/ISR 模式下的使用
 * function StaticPage() {
 *   const { title, content } = useNamiData<{ title: string; content: string }>();
 *   return (
 *     <article>
 *       <h1>{title}</h1>
 *       <div dangerouslySetInnerHTML={{ __html: content }} />
 *     </article>
 *   );
 * }
 * ```
 */
export function useNamiData<T = Record<string, unknown>>(key?: string): T {
  /**
   * 使用 useMemo 缓存数据读取结果
   *
   * window.__NAMI_DATA__ 在页面生命周期内不会变化（它是一次性注入的），
   * 因此以空依赖数组缓存即可。
   *
   * 注意：这里的依赖数组为 [key]，因为同一个组件可能在不同渲染中传入不同的 key。
   */
  const data = useMemo(() => {
    // 服务端环境安全检查 — 虽然此 Hook 主要用于客户端，
    // 但同构代码中可能在服务端 render 阶段被调用
    if (typeof window === 'undefined') {
      logger.debug('服务端环境，返回空数据');
      return EMPTY_OBJECT as T;
    }

    // 读取全局数据对象
    const namiData = window[NAMI_DATA_VARIABLE as keyof Window] as
      | Record<string, unknown>
      | undefined;

    if (!namiData) {
      logger.debug('window.__NAMI_DATA__ 不存在，可能是纯 CSR 模式');
      return EMPTY_OBJECT as T;
    }

    // 如果指定了 key，返回特定字段
    if (key) {
      const value = namiData[key];
      if (value === undefined) {
        logger.debug('数据中不包含指定的 key', { key });
        return undefined as unknown as T;
      }
      return value as T;
    }

    // 未指定 key，返回整个数据对象
    return namiData as T;
  }, [key]);

  return data;
}
