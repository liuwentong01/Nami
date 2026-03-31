/**
 * @nami/client - 数据层导出入口
 *
 * 导出数据管理相关的所有公共 API：
 *
 * - useNamiData:       读取服务端注入的预取数据
 * - useClientFetch:    客户端数据请求 Hook（SWR 风格）
 * - DataHydrator:      服务端数据的读取与清理
 */

// 服务端数据 Hook
export { useNamiData } from './use-nami-data';

// 客户端请求 Hook
export { useClientFetch } from './use-client-fetch';
export type { ClientFetchOptions, ClientFetchResult } from './use-client-fetch';

// 数据注水器
export {
  readServerData,
  cleanupServerData,
  resetDataHydrator,
} from './data-hydrator';
export type { ServerInjectedData } from './data-hydrator';
