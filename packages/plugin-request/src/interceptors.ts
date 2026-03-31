/**
 * @nami/plugin-request - 内置拦截器集合
 *
 * 提供一组常用的请求/响应拦截器，可直接配合 RequestClient 使用：
 * - AuthTokenInterceptor:    自动注入认证 Token
 * - RequestLoggingInterceptor: 请求日志记录
 * - ErrorNormalizationInterceptor: 错误标准化
 * - ResponseTransformInterceptor: 响应数据转换
 * - CacheReadThroughInterceptor: 读穿缓存（先查缓存，未命中再请求）
 */

import type { RequestInterceptor, ResponseInterceptor } from './request-client';
import type { RequestOptions, RequestResponse } from './adapters/server-adapter';
import { RequestError } from './adapters/server-adapter';

// ==================== Auth Token 拦截器 ====================

/**
 * 认证 Token 拦截器配置
 */
export interface AuthTokenInterceptorOptions {
  /**
   * 获取 Token 的函数
   * 支持同步和异步（如从 localStorage 或异步 token 刷新）
   */
  getToken: () => string | null | Promise<string | null>;

  /**
   * Token 请求头名称
   * @default 'Authorization'
   */
  headerName?: string;

  /**
   * Token 前缀
   * @default 'Bearer '
   */
  tokenPrefix?: string;

  /**
   * 需要排除的 URL 模式列表
   * 匹配的请求不会注入 Token（如登录接口）
   */
  excludeURLs?: Array<string | RegExp>;
}

/**
 * 创建认证 Token 拦截器
 *
 * 自动在每个请求头中注入 Token，简化认证流程。
 *
 * @example
 * ```typescript
 * client.addRequestInterceptor(
 *   createAuthTokenInterceptor({
 *     getToken: () => localStorage.getItem('access_token'),
 *     excludeURLs: ['/auth/login', '/auth/register'],
 *   })
 * );
 * ```
 */
export function createAuthTokenInterceptor(options: AuthTokenInterceptorOptions): RequestInterceptor {
  const {
    getToken,
    headerName = 'Authorization',
    tokenPrefix = 'Bearer ',
    excludeURLs = [],
  } = options;

  return {
    onRequest: async (url: string, requestOptions: RequestOptions): Promise<[string, RequestOptions]> => {
      // 检查是否在排除列表中
      const shouldExclude = excludeURLs.some((pattern) => {
        if (typeof pattern === 'string') {
          return url.includes(pattern);
        }
        return pattern.test(url);
      });

      if (shouldExclude) {
        return [url, requestOptions];
      }

      // 获取 Token
      const token = await getToken();
      if (!token) {
        return [url, requestOptions];
      }

      // 注入请求头
      const headers = {
        ...requestOptions.headers,
        [headerName]: `${tokenPrefix}${token}`,
      };

      return [url, { ...requestOptions, headers }];
    },
  };
}

// ==================== 请求日志拦截器 ====================

/**
 * 请求日志拦截器配置
 */
export interface RequestLoggingInterceptorOptions {
  /**
   * 日志输出函数
   * @default console.log
   */
  logger?: (message: string, meta?: Record<string, unknown>) => void;

  /**
   * 是否记录请求体
   * @default false
   */
  logBody?: boolean;

  /**
   * 是否记录响应数据
   * @default false
   */
  logResponse?: boolean;

  /**
   * 日志前缀
   * @default '[Request]'
   */
  prefix?: string;
}

/**
 * 创建请求日志拦截器
 *
 * 记录每个请求的 URL、方法、耗时等信息，用于调试和问题排查。
 *
 * @example
 * ```typescript
 * const { requestInterceptor, responseInterceptor } = createRequestLoggingInterceptor({
 *   prefix: '[API]',
 *   logBody: true,
 * });
 *
 * client.addRequestInterceptor(requestInterceptor);
 * client.addResponseInterceptor(responseInterceptor);
 * ```
 */
export function createRequestLoggingInterceptor(options: RequestLoggingInterceptorOptions = {}): {
  requestInterceptor: RequestInterceptor;
  responseInterceptor: ResponseInterceptor;
} {
  const {
    logger = (msg: string, meta?: Record<string, unknown>) => console.log(msg, meta),
    logBody = false,
    logResponse = false,
    prefix = '[Request]',
  } = options;

  /** 请求开始时间戳映射 */
  const startTimes = new Map<string, number>();

  const requestInterceptor: RequestInterceptor = {
    onRequest: (url: string, requestOptions: RequestOptions): [string, RequestOptions] => {
      const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const method = requestOptions.method ?? 'GET';

      // 记录开始时间
      startTimes.set(requestId, Date.now());

      const logMeta: Record<string, unknown> = {
        method,
        url,
        requestId,
      };

      if (logBody && requestOptions.body) {
        logMeta['body'] = requestOptions.body;
      }

      logger(`${prefix} → ${method} ${url}`, logMeta);

      // 将 requestId 注入到 headers 中，以便在响应拦截器中获取
      const headers = {
        ...requestOptions.headers,
        'X-Request-Log-Id': requestId,
      };

      return [url, { ...requestOptions, headers }];
    },
  };

  const responseInterceptor: ResponseInterceptor = {
    onResponse: <T>(response: RequestResponse<T>): RequestResponse<T> => {
      const requestId = response.config.headers?.['X-Request-Log-Id'];
      const startTime = requestId ? startTimes.get(requestId) : undefined;
      const duration = startTime ? Date.now() - startTime : undefined;

      if (requestId) {
        startTimes.delete(requestId);
      }

      const logMeta: Record<string, unknown> = {
        status: response.status,
        duration: duration !== undefined ? `${duration}ms` : 'unknown',
      };

      if (logResponse) {
        logMeta['data'] = response.data;
      }

      logger(`${prefix} ← ${response.status} (${duration ?? '?'}ms)`, logMeta);

      return response;
    },

    onError: (error: RequestError): void => {
      logger(`${prefix} ✕ 请求失败: ${error.message}`, {
        status: error.status,
        isTimeout: error.isTimeout,
        isCancelled: error.isCancelled,
      });
      // 不恢复错误，继续向上抛
    },
  };

  return { requestInterceptor, responseInterceptor };
}

// ==================== 错误标准化拦截器 ====================

/**
 * 错误标准化拦截器配置
 */
export interface ErrorNormalizationOptions {
  /**
   * 自定义错误消息提取函数
   * 从后端响应数据中提取用户友好的错误消息
   */
  extractMessage?: (data: unknown, status: number) => string | undefined;

  /**
   * 统一的错误处理回调
   * 可用于全局 toast 提示、跳转登录页等
   */
  onError?: (error: RequestError) => void;

  /**
   * 特定状态码的处理映射
   * @example { 401: () => router.push('/login'), 403: () => showForbidden() }
   */
  statusHandlers?: Record<number, (error: RequestError) => void>;
}

/**
 * 创建错误标准化拦截器
 *
 * 统一处理后端返回的错误格式，提取有意义的错误消息。
 *
 * @example
 * ```typescript
 * client.addResponseInterceptor(
 *   createErrorNormalizationInterceptor({
 *     extractMessage: (data) => (data as any)?.message || (data as any)?.error,
 *     statusHandlers: {
 *       401: () => { window.location.href = '/login'; },
 *     },
 *   })
 * );
 * ```
 */
export function createErrorNormalizationInterceptor(options: ErrorNormalizationOptions = {}): ResponseInterceptor {
  return {
    onError: (error: RequestError): void => {
      // 从响应数据中提取更有意义的错误消息
      if (options.extractMessage && error.data) {
        const message = options.extractMessage(error.data, error.status ?? 0);
        if (message) {
          error.message = message;
        }
      }

      // 执行特定状态码处理
      if (error.status !== undefined && options.statusHandlers) {
        const handler = options.statusHandlers[error.status];
        if (handler) {
          handler(error);
        }
      }

      // 执行全局错误回调
      options.onError?.(error);

      // 不恢复错误，继续向上抛
    },
  };
}

// ==================== 响应转换拦截器 ====================

/**
 * 响应转换拦截器配置
 */
export interface ResponseTransformOptions {
  /**
   * 数据提取路径
   * 从响应中提取实际数据的字段路径
   * @example 'data' 表示从 response.data.data 中提取
   * @example 'data.result' 表示从 response.data.data.result 中提取
   */
  dataPath?: string;

  /**
   * 自定义转换函数
   * 接收原始响应数据，返回转换后的数据
   */
  transform?: <T>(data: unknown) => T;
}

/**
 * 创建响应转换拦截器
 *
 * 将后端返回的包装格式（如 { code: 0, data: {...}, message: 'ok' }）
 * 自动解包为实际数据。
 *
 * @example
 * ```typescript
 * // 后端返回格式: { code: 0, data: { name: 'Alice' }, message: 'ok' }
 * client.addResponseInterceptor(
 *   createResponseTransformInterceptor({ dataPath: 'data' })
 * );
 * // 解包后 response.data 直接就是 { name: 'Alice' }
 * ```
 */
export function createResponseTransformInterceptor(options: ResponseTransformOptions = {}): ResponseInterceptor {
  return {
    onResponse: <T>(response: RequestResponse<T>): RequestResponse<T> => {
      if (options.transform) {
        return {
          ...response,
          data: options.transform<T>(response.data),
        };
      }

      if (options.dataPath) {
        const paths = options.dataPath.split('.');
        let data: unknown = response.data;

        for (const path of paths) {
          if (data !== null && data !== undefined && typeof data === 'object') {
            data = (data as Record<string, unknown>)[path];
          } else {
            break;
          }
        }

        return {
          ...response,
          data: data as T,
        };
      }

      return response;
    },
  };
}

// ==================== 读穿缓存拦截器 ====================

/**
 * 缓存条目
 */
interface CacheEntry<T = unknown> {
  /** 缓存的响应数据 */
  response: RequestResponse<T>;
  /** 缓存时间戳 */
  cachedAt: number;
  /** 过期时间（毫秒） */
  ttl: number;
}

/**
 * 读穿缓存拦截器配置
 */
export interface CacheReadThroughOptions {
  /**
   * 缓存 TTL（毫秒）
   * @default 60000（1 分钟）
   */
  ttl?: number;

  /**
   * 缓存最大条目数
   * @default 100
   */
  maxEntries?: number;

  /**
   * 自定义缓存键生成函数
   * 默认使用 method + url 作为缓存键
   */
  keyGenerator?: (url: string, options: RequestOptions) => string;

  /**
   * 缓存的 HTTP 方法列表
   * 默认仅缓存 GET 请求
   * @default ['GET']
   */
  cachedMethods?: string[];
}

/**
 * 创建读穿缓存拦截器
 *
 * 先查询内存缓存，命中则直接返回；未命中则发起请求并写入缓存。
 * 仅缓存成功的响应（2xx 状态码）。
 *
 * @example
 * ```typescript
 * const cache = createCacheReadThroughInterceptor({
 *   ttl: 30000,
 *   maxEntries: 200,
 * });
 *
 * client.addRequestInterceptor(cache.requestInterceptor);
 * client.addResponseInterceptor(cache.responseInterceptor);
 * ```
 */
export function createCacheReadThroughInterceptor(options: CacheReadThroughOptions = {}): {
  requestInterceptor: RequestInterceptor;
  responseInterceptor: ResponseInterceptor;
  /** 手动清除缓存 */
  clear: () => void;
  /** 获取缓存大小 */
  size: () => number;
} {
  const {
    ttl = 60000,
    maxEntries = 100,
    cachedMethods = ['GET'],
  } = options;

  const cache = new Map<string, CacheEntry>();

  /** 生成缓存键 */
  function generateKey(url: string, requestOptions: RequestOptions): string {
    if (options.keyGenerator) {
      return options.keyGenerator(url, requestOptions);
    }
    const method = requestOptions.method ?? 'GET';
    const params = requestOptions.params ? JSON.stringify(requestOptions.params) : '';
    return `${method}:${url}:${params}`;
  }

  /** 检查缓存是否过期 */
  function isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.cachedAt > entry.ttl;
  }

  /** 淘汰过期和溢出条目 */
  function evict(): void {
    // 先删除过期条目
    for (const [key, entry] of cache.entries()) {
      if (isExpired(entry)) {
        cache.delete(key);
      }
    }

    // 如果仍然超过上限，删除最旧的条目
    if (cache.size > maxEntries) {
      const keysToDelete = [...cache.keys()].slice(0, cache.size - maxEntries);
      for (const key of keysToDelete) {
        cache.delete(key);
      }
    }
  }

  const requestInterceptor: RequestInterceptor = {
    onRequest: (url: string, requestOptions: RequestOptions): [string, RequestOptions] => {
      const method = requestOptions.method ?? 'GET';

      // 仅对指定方法启用缓存
      if (!cachedMethods.includes(method)) {
        return [url, requestOptions];
      }

      const cacheKey = generateKey(url, requestOptions);
      const entry = cache.get(cacheKey);

      // 缓存命中且未过期
      if (entry && !isExpired(entry)) {
        // 通过特殊标记告知响应拦截器使用缓存
        return [url, {
          ...requestOptions,
          headers: {
            ...requestOptions.headers,
            'X-Cache-Key': cacheKey,
            'X-Cache-Hit': 'true',
          },
        }];
      }

      // 未命中，传递缓存键用于后续写入
      return [url, {
        ...requestOptions,
        headers: {
          ...requestOptions.headers,
          'X-Cache-Key': cacheKey,
        },
      }];
    },
  };

  const responseInterceptor: ResponseInterceptor = {
    onResponse: <T>(response: RequestResponse<T>): RequestResponse<T> => {
      const cacheKey = response.config.headers?.['X-Cache-Key'];
      const cacheHit = response.config.headers?.['X-Cache-Hit'];

      // 缓存命中，从缓存中返回数据
      if (cacheHit === 'true' && cacheKey) {
        const entry = cache.get(cacheKey);
        if (entry && !isExpired(entry)) {
          return entry.response as RequestResponse<T>;
        }
      }

      // 缓存未命中，写入缓存（仅缓存成功响应）
      if (cacheKey && response.status >= 200 && response.status < 300) {
        evict();
        cache.set(cacheKey, {
          response: response as RequestResponse<unknown>,
          cachedAt: Date.now(),
          ttl,
        });
      }

      return response;
    },
  };

  return {
    requestInterceptor,
    responseInterceptor,
    clear: () => cache.clear(),
    size: () => cache.size,
  };
}
