/**
 * @nami/plugin-request - 请求插件
 *
 * Nami 框架官方请求插件，提供同构的 HTTP 请求能力：
 * - 同构请求客户端（RequestClient）：自动适配 Node.js 和浏览器
 * - useRequest React Hook：声明式数据请求
 * - usePagination Hook：偏移量 / 游标分页
 * - 请求/响应拦截器：Token 注入、日志、错误标准化、缓存
 * - 重试、超时、请求去重等高级功能
 *
 * @example
 * ```typescript
 * import { NamiRequestPlugin, useRequest } from '@nami/plugin-request';
 *
 * // 插件注册
 * export default {
 *   plugins: [
 *     new NamiRequestPlugin({
 *       serverOptions: { baseURL: 'https://api.example.com' },
 *       clientOptions: { baseURL: '/api' },
 *     }),
 *   ],
 * };
 *
 * // 在组件中使用
 * function MyComponent() {
 *   const { data, loading } = useRequest<User>('/user/profile');
 *   return loading ? <Skeleton /> : <div>{data?.name}</div>;
 * }
 * ```
 *
 * @packageDocumentation
 */

// 导出插件主体
import { NamiRequestPlugin } from './request-plugin';
export type { RequestPluginOptions } from './request-plugin';

// 导出同构请求客户端
export { RequestClient } from './request-client';
export type {
  RequestClientOptions,
  RequestInterceptor,
  ResponseInterceptor,
} from './request-client';

// 导出核心 useRequest Hook
export { useRequest, setGlobalAdapter, getGlobalAdapter } from './use-request';
export type { UseRequestOptions, UseRequestResult } from './use-request';

// 导出 SWR 模式和预请求
export { useSWR, prefetch, clearSWRCache } from './hooks/use-request';
export type { UseSWROptions } from './hooks/use-request';

// 导出分页 Hook
export { usePagination, useCursorPagination } from './hooks/use-pagination';
export type {
  UseOffsetPaginationOptions,
  UseOffsetPaginationResult,
  UseCursorPaginationOptions,
  UseCursorPaginationResult,
} from './hooks/use-pagination';

// 导出适配器
export { ServerRequestAdapter, RequestError } from './adapters/server-adapter';
export type {
  RequestAdapter,
  RequestOptions,
  RequestResponse,
  ServerAdapterOptions,
} from './adapters/server-adapter';

export { ClientRequestAdapter } from './adapters/client-adapter';
export type { ClientAdapterOptions } from './adapters/client-adapter';

// 导出内置拦截器
export {
  createAuthTokenInterceptor,
  createRequestLoggingInterceptor,
  createErrorNormalizationInterceptor,
  createResponseTransformInterceptor,
  createCacheReadThroughInterceptor,
} from './interceptors';
export type {
  AuthTokenInterceptorOptions,
  RequestLoggingInterceptorOptions,
  ErrorNormalizationOptions,
  ResponseTransformOptions,
  CacheReadThroughOptions,
} from './interceptors';

// 导出底层拦截器类
export { RetryInterceptor } from './interceptors/retry';
export type { RetryInterceptorOptions } from './interceptors/retry';

export { TimeoutInterceptor } from './interceptors/timeout';
export type { TimeoutInterceptorOptions } from './interceptors/timeout';

export { CacheInterceptor } from './interceptors/cache';
export type { CacheInterceptorOptions } from './interceptors/cache';

type LegacyRequestPluginOptions = {
  baseURL?: string;
  timeout?: number;
} & import('./request-plugin').RequestPluginOptions;

function normalizeRequestPluginOptions(
  options: LegacyRequestPluginOptions = {},
): import('./request-plugin').RequestPluginOptions {
  const normalizedTimeout = typeof options.timeout === 'number'
    ? { defaultTimeout: options.timeout }
    : options.timeout;

  return {
    ...options,
    serverOptions: options.serverOptions ?? (options.baseURL ? { baseURL: options.baseURL } : undefined),
    clientOptions: options.clientOptions ?? (options.baseURL ? { baseURL: options.baseURL } : undefined),
    timeout: normalizedTimeout,
  };
}

/**
 * 兼容历史 `pluginRequest({...})` 调用方式的默认导出工厂。
 */
export default function pluginRequest(options: LegacyRequestPluginOptions = {}): NamiRequestPlugin {
  return new NamiRequestPlugin(normalizeRequestPluginOptions(options));
}

export { NamiRequestPlugin };
