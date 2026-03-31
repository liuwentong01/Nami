/**
 * @nami/core - 数据层导出入口
 *
 * 数据层负责 SSR/SSG/ISR 场景下的数据预取、传递和序列化。
 *
 * 核心模块：
 * - PrefetchManager: 数据预取管理器（超时保护、并行预取、错误降级）
 * - NamiDataContext / NamiDataProvider: React Context 数据传递
 * - useServerData: 同构数据读取 Hook
 * - DataSerializer: 数据序列化/反序列化（服务端 → HTML → 客户端）
 */

// 预取管理器
export { PrefetchManager } from './prefetch-manager';
export type { PrefetchContext } from './prefetch-manager';

// React 数据上下文
export {
  NamiDataContext,
  NamiDataProvider,
  useNamiContext,
} from './data-context';
export type {
  NamiDataContextValue,
  NamiDataProviderProps,
} from './data-context';

// 服务端数据 Hook
export { useServerData } from './use-server-data';

// 数据序列化器
export { DataSerializer } from './serializer';
