/**
 * @nami/plugin-request - 服务端请求适配器
 *
 * 在 Node.js 环境中发起 HTTP 请求的适配器实现。
 * 使用 Node.js 18+ 内置的 fetch API 或 node:http 模块。
 *
 * 服务端请求的特殊考虑：
 * - 不存在跨域限制，可直接请求任何域名
 * - 需要处理内网域名解析（可能需要自定义 DNS）
 * - 超时控制更重要（避免阻塞渲染线程）
 * - 可能需要传递服务端特有的认证头（如内网 token）
 */

/**
 * 请求适配器接口
 *
 * 所有请求适配器（服务端/客户端）都实现此接口，
 * 确保上层 useRequest Hook 可以无感切换。
 */
export interface RequestAdapter {
  /**
   * 发起请求
   *
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 响应数据
   */
  request<T = unknown>(url: string, options?: RequestOptions): Promise<RequestResponse<T>>;
}

/**
 * 请求选项
 */
export interface RequestOptions {
  /** HTTP 方法 */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

  /** 请求头 */
  headers?: Record<string, string>;

  /** 请求体（POST/PUT/PATCH 使用） */
  body?: unknown;

  /** 超时时间（毫秒） */
  timeout?: number;

  /** 取消控制器 */
  signal?: AbortSignal;

  /** 查询参数 */
  params?: Record<string, string | number | boolean>;

  /** 响应类型 */
  responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer';

  /**
   * 是否携带凭证（cookies）
   * 服务端请求通常不需要
   * @default false
   */
  credentials?: 'include' | 'same-origin' | 'omit';
}

/**
 * 统一的响应数据结构
 */
export interface RequestResponse<T = unknown> {
  /** 响应数据 */
  data: T;

  /** HTTP 状态码 */
  status: number;

  /** 状态描述文本 */
  statusText: string;

  /** 响应头 */
  headers: Record<string, string>;

  /** 原始请求选项 */
  config: RequestOptions;
}

/**
 * 请求错误
 */
export class RequestError extends Error {
  /** HTTP 状态码（如果有） */
  status?: number;

  /** 响应数据（如果有） */
  data?: unknown;

  /** 是否为超时错误 */
  isTimeout: boolean;

  /** 是否为取消错误 */
  isCancelled: boolean;

  /** 原始请求选项 */
  config?: RequestOptions;

  constructor(message: string, options?: {
    status?: number;
    data?: unknown;
    isTimeout?: boolean;
    isCancelled?: boolean;
    config?: RequestOptions;
  }) {
    super(message);
    this.name = 'RequestError';
    this.status = options?.status;
    this.data = options?.data;
    this.isTimeout = options?.isTimeout ?? false;
    this.isCancelled = options?.isCancelled ?? false;
    this.config = options?.config;

    Object.setPrototypeOf(this, RequestError.prototype);
  }
}

/**
 * 服务端请求适配器配置
 */
export interface ServerAdapterOptions {
  /**
   * 请求基础 URL
   * 所有相对路径的请求都会基于此 URL 拼接
   * @example 'https://api.example.com'
   */
  baseURL?: string;

  /**
   * 默认请求头
   */
  defaultHeaders?: Record<string, string>;

  /**
   * 默认超时时间（毫秒）
   * @default 10000
   */
  defaultTimeout?: number;
}

/**
 * 服务端请求适配器
 *
 * 使用 Node.js 内置 fetch API（18+）发起请求。
 *
 * @example
 * ```typescript
 * const adapter = new ServerRequestAdapter({
 *   baseURL: 'https://api.example.com',
 *   defaultTimeout: 5000,
 * });
 *
 * const response = await adapter.request<{ name: string }>('/api/user/1');
 * console.log(response.data.name);
 * ```
 */
export class ServerRequestAdapter implements RequestAdapter {
  /** 基础 URL */
  private readonly baseURL: string;

  /** 默认请求头 */
  private readonly defaultHeaders: Record<string, string>;

  /** 默认超时时间 */
  private readonly defaultTimeout: number;

  constructor(options: ServerAdapterOptions = {}) {
    this.baseURL = options.baseURL ?? '';
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...options.defaultHeaders,
    };
    this.defaultTimeout = options.defaultTimeout ?? 10000;
  }

  /**
   * 发起 HTTP 请求
   *
   * @param url - 请求 URL（绝对路径或相对路径）
   * @param options - 请求选项
   * @returns 统一格式的响应
   */
  async request<T = unknown>(
    url: string,
    options: RequestOptions = {},
  ): Promise<RequestResponse<T>> {
    // 拼接完整 URL
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
      signal: options.signal,
    };

    // 处理请求体
    if (options.body !== undefined && options.body !== null) {
      if (typeof options.body === 'string') {
        fetchOptions.body = options.body;
      } else {
        fetchOptions.body = JSON.stringify(options.body);
      }
    }

    // 设置超时控制
    const timeout = options.timeout ?? this.defaultTimeout;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // 如果外部没有提供 signal，使用内部的 AbortController
    if (!options.signal) {
      fetchOptions.signal = controller.signal;
      timeoutId = setTimeout(() => {
        controller.abort();
      }, timeout);
    }

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
            // 尝试 JSON 解析，失败时回退到文本
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

      // 检查 HTTP 状态码
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
      // 处理 AbortError（超时或主动取消）
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

      // 如果已经是 RequestError，直接抛出
      if (error instanceof RequestError) {
        throw error;
      }

      // 其他错误（网络错误等）
      throw new RequestError(
        `请求失败: ${error instanceof Error ? error.message : String(error)}`,
        { config: options },
      );
    } finally {
      // 清理超时定时器
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * 构建完整的请求 URL
   *
   * 处理基础 URL 拼接和查询参数序列化。
   *
   * @param url - 原始 URL
   * @param params - 查询参数
   * @returns 完整的 URL 字符串
   */
  private buildURL(url: string, params?: Record<string, string | number | boolean>): string {
    // 拼接基础 URL
    let fullURL: string;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      fullURL = url;
    } else {
      // 确保 baseURL 和 url 之间有且仅有一个 /
      const base = this.baseURL.endsWith('/') ? this.baseURL.slice(0, -1) : this.baseURL;
      const path = url.startsWith('/') ? url : `/${url}`;
      fullURL = `${base}${path}`;
    }

    // 拼接查询参数
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
