/**
 * @nami/plugin-request - 客户端请求适配器
 *
 * 在浏览器环境中发起 HTTP 请求的适配器实现。
 * 使用浏览器原生的 fetch API。
 *
 * 客户端请求的特殊考虑：
 * - 存在跨域（CORS）限制
 * - 可能需要携带 Cookie（credentials: 'include'）
 * - 需要考虑网络状况（弱网、离线等）
 * - 页面切换时需要取消未完成的请求
 */

import type {
  RequestAdapter,
  RequestOptions,
  RequestResponse,
} from './server-adapter';
import { RequestError } from './server-adapter';

/**
 * 客户端请求适配器配置
 */
export interface ClientAdapterOptions {
  /**
   * 请求基础 URL
   * @example '/api' 或 'https://api.example.com'
   */
  baseURL?: string;

  /**
   * 默认请求头
   */
  defaultHeaders?: Record<string, string>;

  /**
   * 默认超时时间（毫秒）
   * @default 30000
   */
  defaultTimeout?: number;

  /**
   * 默认凭证模式
   * - 'include': 始终发送 cookies（跨域也发送）
   * - 'same-origin': 仅同源时发送 cookies
   * - 'omit': 不发送 cookies
   * @default 'same-origin'
   */
  credentials?: 'include' | 'same-origin' | 'omit';
}

/**
 * 客户端请求适配器
 *
 * 封装浏览器 fetch API，提供统一的请求接口。
 * 自动处理超时控制、请求取消、凭证携带等。
 *
 * @example
 * ```typescript
 * const adapter = new ClientRequestAdapter({
 *   baseURL: '/api',
 *   credentials: 'include',
 *   defaultTimeout: 15000,
 * });
 *
 * const response = await adapter.request<User>('/user/profile');
 * console.log(response.data.name);
 * ```
 */
export class ClientRequestAdapter implements RequestAdapter {
  /** 基础 URL */
  private readonly baseURL: string;

  /** 默认请求头 */
  private readonly defaultHeaders: Record<string, string>;

  /** 默认超时时间 */
  private readonly defaultTimeout: number;

  /** 默认凭证模式 */
  private readonly credentials: RequestCredentials;

  constructor(options: ClientAdapterOptions = {}) {
    this.baseURL = options.baseURL ?? '';
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...options.defaultHeaders,
    };
    // 客户端默认超时更长（用户网络状况不可控）
    this.defaultTimeout = options.defaultTimeout ?? 30000;
    this.credentials = options.credentials ?? 'same-origin';
  }

  /**
   * 发起 HTTP 请求
   *
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 统一格式的响应
   */
  async request<T = unknown>(
    url: string,
    options: RequestOptions = {},
  ): Promise<RequestResponse<T>> {
    const fullURL = this.buildURL(url, options.params);

    // 合并请求头
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options.headers,
    };

    // 构建 fetch 选项
    const fetchOptions: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      credentials: options.credentials ?? this.credentials,
    };

    // 处理请求体
    if (options.body !== undefined && options.body !== null) {
      if (typeof options.body === 'string' || options.body instanceof FormData) {
        fetchOptions.body = options.body as BodyInit;
        // FormData 不需要手动设置 Content-Type，浏览器会自动处理
        if (options.body instanceof FormData) {
          delete headers['Content-Type'];
        }
      } else {
        fetchOptions.body = JSON.stringify(options.body);
      }
    }

    // 超时控制
    const timeout = options.timeout ?? this.defaultTimeout;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // 合并外部 signal 和内部超时 signal
    if (options.signal) {
      // 如果外部提供了 signal，监听其 abort 事件
      options.signal.addEventListener('abort', () => controller.abort());
    }

    fetchOptions.signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(fullURL, fetchOptions);

      // 解析响应头
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // 解析响应体
      let data: T;
      const responseType = options.responseType ?? 'json';

      try {
        switch (responseType) {
          case 'text':
            data = (await response.text()) as unknown as T;
            break;
          case 'blob':
            data = (await response.blob()) as unknown as T;
            break;
          case 'arrayBuffer':
            data = (await response.arrayBuffer()) as unknown as T;
            break;
          case 'json':
          default:
            const text = await response.text();
            try {
              data = JSON.parse(text) as T;
            } catch {
              data = text as unknown as T;
            }
            break;
        }
      } catch {
        data = null as unknown as T;
      }

      // HTTP 错误状态码
      if (!response.ok) {
        throw new RequestError(
          `请求失败: ${response.status} ${response.statusText}`,
          {
            status: response.status,
            data,
            config: options,
          },
        );
      }

      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        config: options,
      };
    } catch (error) {
      // AbortError 处理
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new RequestError('请求已取消', {
            isCancelled: true,
            config: options,
          });
        }
        throw new RequestError(`请求超时: ${timeout}ms`, {
          isTimeout: true,
          config: options,
        });
      }

      if (error instanceof RequestError) {
        throw error;
      }

      // 网络错误（离线、DNS 失败等）
      throw new RequestError(
        `网络错误: ${error instanceof Error ? error.message : String(error)}`,
        { config: options },
      );
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * 构建完整的请求 URL
   */
  private buildURL(url: string, params?: Record<string, string | number | boolean>): string {
    let fullURL: string;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) {
      fullURL = url;
    } else {
      const base = this.baseURL.endsWith('/') ? this.baseURL.slice(0, -1) : this.baseURL;
      const path = url.startsWith('/') ? url : `/${url}`;
      fullURL = `${base}${path}`;
    }

    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        searchParams.set(key, String(value));
      }
      const separator = fullURL.includes('?') ? '&' : '?';
      fullURL = `${fullURL}${separator}${searchParams.toString()}`;
    }

    return fullURL;
  }
}

// 重新导出共享类型，方便客户端代码导入
export type { RequestAdapter, RequestOptions, RequestResponse };
export { RequestError };
