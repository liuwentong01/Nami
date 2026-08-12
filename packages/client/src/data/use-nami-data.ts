/**
 * @nami/client - useNamiData Hook
 *
 * useNamiData 是 Nami 框架客户端获取服务端注入数据的核心 Hook。
 *
 * 数据流向：
 * 1. 服务端：getServerSideProps / getStaticProps 返回数据
 * 2. 服务端：数据被序列化为 JSON 并注入到 HTML 的 <script> 标签中
 *    → window.__NAMI_DATA__ = {
 *        version: 1,
 *        props: { "pageData": { ... } },
 *        degraded: false,
 *        renderMode: "ssr",
 *        routePath: "/current-url"
 *      }
 * 3. 客户端：useNamiData 通过 DataHydrator 恢复并缓存注水数据
 * 4. 客户端：数据作为 React 组件的初始 props 使用
 *
 * 这种模式确保了：
 * - SSR 页面在 Hydration 时不需要重复的数据请求
 * - 客户端渲染使用与服务端完全相同的数据，避免 Hydration 不匹配
 * - 开发者可以在组件中以 Hook 的方式便捷地访问预取数据
 *
 * @module
 */

import { createLogger } from '@nami/shared';
import { readServerData } from './data-hydrator';

/** 模块日志 */
const logger = createLogger('@nami/client:use-nami-data');

/** 空对象常量 — 作为默认返回值，保证引用稳定性 */
const EMPTY_OBJECT = Object.freeze({}) as Record<string, unknown>;

// ==================== Hook 实现 ====================

/**
 * 获取服务端注入数据的 Hook
 *
 * 从 DataHydrator 的快照中读取服务端预取的数据。
 * 支持通过泛型参数指定返回数据的类型。
 *
 * @typeParam T - 数据类型，默认为 Record<string, unknown>
 * @param key - 可选的数据键名。
 *              指定时返回对应字段；
 *              不指定时返回整个注水数据对象。
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
  // DataHydrator 自己维护稳定缓存与 routePath 作用域。这里每次 render 都读取，
  // 确保同一个动态路由组件从 /x/1 切到 /x/2 时不会被 useMemo 固化旧快照。
  const serverData = readServerData();
  const namiData = serverData.props;

  if (!namiData) {
    logger.debug('未检测到当前路由可用的服务端注水数据，可能是纯 CSR 或已发生导航');
    return EMPTY_OBJECT as T;
  }

  if (key) {
    const value = namiData[key];
    if (value === undefined) {
      logger.debug('数据中不包含指定的 key', { key });
      return undefined as unknown as T;
    }
    return value as T;
  }

  return namiData as T;
}
