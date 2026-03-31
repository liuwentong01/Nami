/**
 * @nami/plugin-request - 同构 HTTP 请求客户端
 *
 * RequestClient 是对底层适配器的高级封装，提供更友好的 API：
 * - 同时支持 Node.js 和浏览器环境
 * - 支持 GET/POST/PUT/DELETE 快捷方法
 * - 支持请求/响应拦截器链
 * - 支持超时、重试（指数退避）、请求取消
 * - 支持 baseURL 和默认请求头
 *
 * RequestClient 内部根据运行环境自动选择适配器：
 * - 浏览器环境：使用 ClientRequestAdapter
 * - Node.js 环境：使用 ServerRequestAdapter
 */

import type {
  RequestAdapter,
  RequestOptions,
  RequestResponse,
} from './adapters/server-adapter';
import { RequestError } from './adapters/server-adapter';
import { ServerRequestAdapter, type ServerAdapterOptions } from './adapters/server-adapter';
import { ClientRequestAdapter, type ClientAdapterOptions } from './adapters/client-adapter';

// ==================== 拦截器类型 ====================

/**
 * 请求拦截器
 * 在请求发出前修改请求配置
 */
export interface RequestInterceptor {
  /**
   * 拦截处理函数
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 修改后的 [url, options] 元组
   */
  onRequest: (url: string, options: RequestOptions) => [string, RequestOptions] | Promise<[string, RequestOptions]>;
}

/**
 * 响应拦截器
 * 在响应返回后处理响应数据
 */
export interface ResponseInterceptor {
  /**
   * 成功响应拦截
   * @param response - 响应数据
   * @returns 修改后的响应
   */
  onResponse?: <T>(response: RequestResponse<T>) => RequestResponse<T> | Promise<RequestResponse<T>>;

  /**
   * 错误响应拦截
   * @param error - 请求错误
   * @returns 可选地恢复错误并返回响应，或继续抛出
   */
  onError?: (error: RequestError) => RequestResponse<unknown> | Promise<RequestResponse<unknown>> | void;
}

/**
 * RequestClient 配置选项
 */
export interface RequestClientOptions {
  /**
   * 请求基础 URL
   * @example 'https://api.example.com'
   */
  baseURL?: string;

  /**
   * 默认请求头
   */
  headers?: Record<string, string>;

  /**
   * 默认超时时间（毫秒）
   * @default 10000
   */
  timeout?: number;

  /**
   * 自动重试次数
   * 设为 0 禁用重试
   * @default 0
   */
  retryCount?: number;

  /**
   * 重试基础延迟（毫秒）
   * @default 1000
   */
  retryDelay?: number;

  /**
   * 凭证模式
   * @default 'same-origin'
   */
  credentials?: 'include' | 'same-origin' | 'omit';

  /**
   * 自定义适配器实例
   * 如果提供，将使用此适配器替代自动选择
   */
  adapter?: RequestAdapter;
}

/**
 * 同构 HTTP 请求客户端
 *
 * 提供统一的请求 API，自动适配 Node.js 和浏览器环境。
 *
 * @example
 * ```typescript
 * const client = new RequestClient({
 *   baseURL: 'https://api.example.com',
 *   timeout: 5000,
 *   headers: { 'Authorization': 'Bearer token' },
 * });
 *
 * // GET 请求
 * const users = await client.get<User[]>('/users');
 *
 * // POST 请求
 * const newUser = await client.post<User>('/users', { name: 'Alice' });
 *
 * // 添加拦截器
 * client.addRequestInterceptor({
 *   onRequest: (url, opts) => {
 *     opts.headers = { ...opts.headers, 'X-Request-Id': generateId() };
 *     return [url, opts];
 *   },
 * });
 * ```
 */
export class RequestClient {
  /** 底层请求适配器 */
  private readonly adapter: RequestAdapter;

  /** 默认请求选项 */
  private readonly defaults: Required<Pick<RequestClientOptions, 'timeout' | 'retryCount' | 'retryDelay'>> & RequestClientOptions;

  /** 请求拦截器链 */
  private readonly requestInterceptors: RequestInterceptor[] = [];

  /** 响应拦截器链 */
  private readonly responseInterceptors: ResponseInterceptor[] = [];

  constructor(options: RequestClientOptions = {}) {
    this.defaults = {
      ...options,
      timeout: options.timeout ?? 10000,
      retryCount: options.retryCount ?? 0,
      retryDelay: options.retryDelay ?? 1000,
    };

    // 初始化适配器
    if (options.adapter) {
      this.adapter = options.adapter;
    } else if (typeof window !== 'undefined') {
      // 浏览器环境
      this.adapter = new ClientRequestAdapter({
        baseURL: options.baseURL,
        defaultHeaders: options.headers,
        defaultTimeout: options.timeout,
        credentials: options.credentials,
      });
    } else {
      // Node.js 环境
      this.adapter = new ServerRequestAdapter({
        baseURL: options.baseURL,
        defaultHeaders: options.headers,
        defaultTimeout: options.timeout,
      });
    }
  }

  // ==================== 快捷方法 ====================

  /**
   * 发起 GET 请求
   */
  async get<T = unknown>(url: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<RequestResponse<T>> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }

  /**
   * 发起 POST 请求
   */
  async post<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<RequestResponse<T>> {
    return this.request<T>(url, { ...options, method: 'POST', body });
  }

  /**
   * 发起 PUT 请求
   */
  async put<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<RequestResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PUT', body });
  }

  /**
   * 发起 DELETE 请求
   */
  async delete<T = unknown>(url: string, options?: Omit<RequestOptions, 'method'>): Promise<RequestResponse<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }

  /**
   * 发起 PATCH 请求
   */
  async patch<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<RequestResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PATCH', body });
  }

  // ==================== 核心请求方法 ====================

  /**
   * 发起请求（核心方法）
   *
   * 执行流程：
   * 1. 合并默认选项
   * 2. 执行请求拦截器链
   * 3. 发起实际请求（含重试逻辑）
   * 4. 执行响应拦截器链
   * 5. 返回最终响应
   *
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 响应数据
   */
  async request<T = unknown>(url: string, options: RequestOptions = {}): Promise<RequestResponse<T>> {
    // 合并默认请求头
    const mergedOptions: RequestOptions = {
      ...options,
      timeout: options.timeout ?? this.defaults.timeout,
      headers: {
        ...this.defaults.headers,
        ...options.headers,
      },
    };

    // 执行请求拦截器链
    let currentUrl = url;
    let currentOptions = mergedOptions;

    for (const interceptor of this.requestInterceptors) {
      [currentUrl, currentOptions] = await interceptor.onRequest(currentUrl, currentOptions);
    }

    try {
      // 发起请求（含重试）
      const response = await this.executeWithRetry<T>(currentUrl, currentOptions);

      // 执行响应拦截器链（成功路径）
      let currentResponse: RequestResponse<T> = response;
      for (const interceptor of this.responseInterceptors) {
        if (interceptor.onResponse) {
          currentResponse = await interceptor.onResponse<T>(currentResponse) as RequestResponse<T>;
        }
      }

      return currentResponse;
    } catch (error) {
      const requestError = error instanceof RequestError
        ? error
        : new RequestError(error instanceof Error ? error.message : String(error));

      // 执行响应拦截器链（错误路径）
      for (const interceptor of this.responseInterceptors) {
        if (interceptor.onError) {
          const recovered = await interceptor.onError(requestError);
          if (recovered) {
            return recovered as RequestResponse<T>;
          }
        }
      }

      throw requestError;
    }
  }

  // ==================== 拦截器管理 ====================

  /**
   * 添加请求拦截器
   * @param interceptor - 请求拦截器
   */
  addRequestInterceptor(interceptor: RequestInterceptor): void {
    this.requestInterceptors.push(interceptor);
  }

  /**
   * 添加响应拦截器
   * @param interceptor - 响应拦截器
   */
  addResponseInterceptor(interceptor: ResponseInterceptor): void {
    this.responseInterceptors.push(interceptor);
  }

  /**
   * 移除请求拦截器
   */
  removeRequestInterceptor(interceptor: RequestInterceptor): void {
    const index = this.requestInterceptors.indexOf(interceptor);
    if (index !== -1) {
      this.requestInterceptors.splice(index, 1);
    }
  }

  /**
   * 移除响应拦截器
   */
  removeResponseInterceptor(interceptor: ResponseInterceptor): void {
    const index = this.responseInterceptors.indexOf(interceptor);
    if (index !== -1) {
      this.responseInterceptors.splice(index, 1);
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 执行带重试逻辑的请求
   *
   * 采用指数退避策略：第 N 次重试等待 retryDelay * 2^(N-1) 毫秒。
   */
  private async executeWithRetry<T>(url: string, options: RequestOptions): Promise<RequestResponse<T>> {
    const maxRetries = this.defaults.retryCount;
    let lastError: RequestError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.adapter.request<T>(url, options);
      } catch (error) {
        lastError = error instanceof RequestError
          ? error
          : new RequestError(error instanceof Error ? error.message : String(error));

        // 最后一次尝试或不可重试的错误，直接抛出
        if (attempt >= maxRetries || !this.isRetryable(lastError)) {
          throw lastError;
        }

        // 等待指数退避延迟
        const delay = Math.min(
          this.defaults.retryDelay * Math.pow(2, attempt),
          30000,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new RequestError('未知错误：重试耗尽');
  }

  /**
   * 判断错误是否可重试
   *
   * 可重试条件：
   * - 网络超时
   * - 服务端错误（5xx）
   * - 网络异常（无状态码）
   *
   * 不可重试：
   * - 客户端错误（4xx）
   * - 请求被主动取消
   */
  private isRetryable(error: RequestError): boolean {
    if (error.isCancelled) return false;
    if (error.isTimeout) return true;
    if (error.status !== undefined) return error.status >= 500;
    return true;
  }

  /**
   * 获取底层请求适配器
   */
  getAdapter(): RequestAdapter {
    return this.adapter;
  }
}
