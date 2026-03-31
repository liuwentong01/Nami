/**
 * @nami/plugin-request - 请求插件主体
 *
 * NamiRequestPlugin 是 Nami 框架的官方请求插件，提供同构的 HTTP 请求能力：
 *
 * 1. 服务端初始化：在 onServerStart 中配置 ServerRequestAdapter
 * 2. 客户端初始化：在 onClientInit 中配置 ClientRequestAdapter
 * 3. 统一接口：通过 useRequest Hook 提供声明式的请求 API
 * 4. 拦截器链：支持重试、超时、缓存等请求拦截器
 *
 * 同构设计：
 * - useRequest Hook 在 SSR 和 CSR 中都可使用
 * - 服务端使用 ServerRequestAdapter（基于 Node.js fetch）
 * - 客户端使用 ClientRequestAdapter（基于浏览器 fetch）
 * - 插件在不同环境自动切换适配器
 */

import type { NamiPlugin, PluginAPI } from '@nami/shared';
import { ServerRequestAdapter, type ServerAdapterOptions } from './adapters/server-adapter';
import type { RequestAdapter } from './adapters/server-adapter';
import { ClientRequestAdapter, type ClientAdapterOptions } from './adapters/client-adapter';
import { RetryInterceptor, type RetryInterceptorOptions } from './interceptors/retry';
import { TimeoutInterceptor, type TimeoutInterceptorOptions } from './interceptors/timeout';
import { CacheInterceptor, type CacheInterceptorOptions } from './interceptors/cache';
import { setGlobalAdapter } from './use-request';

/**
 * 请求插件配置选项
 */
export interface RequestPluginOptions {
  /**
   * 服务端请求适配器配置
   */
  serverOptions?: ServerAdapterOptions;

  /**
   * 客户端请求适配器配置
   */
  clientOptions?: ClientAdapterOptions;

  /**
   * 重试拦截器配置
   * 设为 false 禁用重试
   * @default { maxRetries: 3 }
   */
  retry?: RetryInterceptorOptions | false;

  /**
   * 超时拦截器配置
   * 设为 false 禁用超时控制
   * @default { defaultTimeout: 10000 }
   */
  timeout?: TimeoutInterceptorOptions | false;

  /**
   * 缓存拦截器配置
   * 设为 false 禁用请求缓存
   * @default false（默认不启用请求级缓存）
   */
  cache?: CacheInterceptorOptions | false;

  /**
   * 日志前缀
   * @default '[NamiRequest]'
   */
  logPrefix?: string;
}

/**
 * 带拦截器的请求适配器包装
 *
 * 将原始适配器包装一层，在请求前后执行拦截器链。
 * 拦截器执行顺序：缓存 → 超时 → 重试 → 适配器
 */
class InterceptedAdapter implements RequestAdapter {
  /** 原始适配器 */
  private readonly adapter: RequestAdapter;

  /** 重试拦截器 */
  private readonly retryInterceptor?: RetryInterceptor;

  /** 超时拦截器 */
  private readonly timeoutInterceptor?: TimeoutInterceptor;

  /** 缓存拦截器 */
  private readonly cacheInterceptor?: CacheInterceptor;

  constructor(
    adapter: RequestAdapter,
    options: {
      retry?: RetryInterceptor;
      timeout?: TimeoutInterceptor;
      cache?: CacheInterceptor;
    },
  ) {
    this.adapter = adapter;
    this.retryInterceptor = options.retry;
    this.timeoutInterceptor = options.timeout;
    this.cacheInterceptor = options.cache;
  }

  /**
   * 执行带拦截器链的请求
   *
   * 拦截器执行链路：
   * 1. 缓存拦截器检查缓存（命中则直接返回）
   * 2. 重试拦截器包裹请求（失败时自动重试）
   *    2.1 超时拦截器控制单次请求超时
   *        2.1.1 适配器发起实际的 HTTP 请求
   */
  async request<T = unknown>(
    url: string,
    options?: import('./adapters/server-adapter').RequestOptions,
  ): Promise<import('./adapters/server-adapter').RequestResponse<T>> {
    // 构建执行链：从内到外包裹

    // 最内层：原始适配器
    let executor: RequestAdapter = this.adapter;

    // 包裹超时拦截器
    if (this.timeoutInterceptor) {
      const timeoutInterceptor = this.timeoutInterceptor;
      const innerExecutor = executor;
      executor = {
        request: <U>(u: string, o?: import('./adapters/server-adapter').RequestOptions) =>
          timeoutInterceptor.execute<U>(innerExecutor, u, o),
      };
    }

    // 包裹重试拦截器
    if (this.retryInterceptor) {
      const retryInterceptor = this.retryInterceptor;
      const innerExecutor = executor;
      executor = {
        request: <U>(u: string, o?: import('./adapters/server-adapter').RequestOptions) =>
          retryInterceptor.execute<U>(innerExecutor, u, o),
      };
    }

    // 包裹缓存拦截器（最外层，缓存命中时跳过内层所有操作）
    if (this.cacheInterceptor) {
      const cacheInterceptor = this.cacheInterceptor;
      const innerExecutor = executor;
      executor = {
        request: <U>(u: string, o?: import('./adapters/server-adapter').RequestOptions) =>
          cacheInterceptor.execute<U>(innerExecutor, u, o),
      };
    }

    return executor.request<T>(url, options);
  }
}

/**
 * Nami 请求插件
 *
 * @example
 * ```typescript
 * import { NamiRequestPlugin } from '@nami/plugin-request';
 *
 * export default {
 *   plugins: [
 *     new NamiRequestPlugin({
 *       serverOptions: {
 *         baseURL: 'https://api.example.com',
 *         defaultTimeout: 5000,
 *       },
 *       clientOptions: {
 *         baseURL: '/api',
 *         credentials: 'include',
 *       },
 *       retry: { maxRetries: 2 },
 *       timeout: { defaultTimeout: 10000 },
 *     }),
 *   ],
 * };
 * ```
 */
export class NamiRequestPlugin implements NamiPlugin {
  /** 插件唯一名称 */
  readonly name = 'nami:request';

  /** 插件版本号 */
  readonly version = '0.1.0';

  /** 插件配置 */
  private readonly options: RequestPluginOptions;

  /** 当前使用的适配器 */
  private adapter: RequestAdapter | null = null;

  /** 拦截器实例 */
  private retryInterceptor?: RetryInterceptor;
  private timeoutInterceptor?: TimeoutInterceptor;
  private cacheInterceptor?: CacheInterceptor;

  /** 日志前缀 */
  private readonly logPrefix: string;

  constructor(options: RequestPluginOptions = {}) {
    this.options = options;
    this.logPrefix = options.logPrefix ?? '[NamiRequest]';
  }

  /**
   * 插件初始化
   *
   * 注册服务端和客户端初始化钩子，
   * 在对应环境中创建适配器和拦截器。
   *
   * @param api - 插件 API
   */
  async setup(api: PluginAPI): Promise<void> {
    const logger = api.getLogger();

    // 初始化拦截器
    this.initInterceptors();

    // ==================== 服务端初始化 ====================
    api.onServerStart(async () => {
      try {
        // 创建服务端适配器
        const serverAdapter = new ServerRequestAdapter(this.options.serverOptions);

        // 包裹拦截器
        this.adapter = this.wrapWithInterceptors(serverAdapter);

        // 设置全局适配器（供 useRequest 使用）
        setGlobalAdapter(this.adapter);

        logger.info(`${this.logPrefix} 服务端请求适配器已初始化`, {
          baseURL: this.options.serverOptions?.baseURL ?? '(none)',
        });
      } catch (error) {
        logger.error(`${this.logPrefix} 服务端适配器初始化失败`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // ==================== 客户端初始化 ====================
    api.onClientInit(async () => {
      try {
        // 创建客户端适配器
        const clientAdapter = new ClientRequestAdapter(this.options.clientOptions);

        // 包裹拦截器
        this.adapter = this.wrapWithInterceptors(clientAdapter);

        // 设置全局适配器
        setGlobalAdapter(this.adapter);

        logger.info(`${this.logPrefix} 客户端请求适配器已初始化`, {
          baseURL: this.options.clientOptions?.baseURL ?? '(none)',
        });
      } catch (error) {
        logger.error(`${this.logPrefix} 客户端适配器初始化失败`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // ==================== 插件销毁 ====================
    api.onDispose(async () => {
      // 清理缓存拦截器
      if (this.cacheInterceptor) {
        this.cacheInterceptor.clear();
      }
      this.adapter = null;
      logger.info(`${this.logPrefix} 请求插件已销毁`);
    });
  }

  /**
   * 初始化拦截器实例
   */
  private initInterceptors(): void {
    // 重试拦截器
    if (this.options.retry !== false) {
      this.retryInterceptor = new RetryInterceptor(
        this.options.retry ?? { maxRetries: 3 },
      );
    }

    // 超时拦截器
    if (this.options.timeout !== false) {
      this.timeoutInterceptor = new TimeoutInterceptor(
        this.options.timeout ?? { defaultTimeout: 10000 },
      );
    }

    // 缓存拦截器（默认不启用）
    if (this.options.cache && this.options.cache !== false) {
      this.cacheInterceptor = new CacheInterceptor(this.options.cache);
    }
  }

  /**
   * 将适配器包裹拦截器链
   */
  private wrapWithInterceptors(adapter: RequestAdapter): RequestAdapter {
    return new InterceptedAdapter(adapter, {
      retry: this.retryInterceptor,
      timeout: this.timeoutInterceptor,
      cache: this.cacheInterceptor,
    });
  }

  /**
   * 获取当前请求适配器
   * 可用于在插件外直接调用
   */
  getAdapter(): RequestAdapter | null {
    return this.adapter;
  }

  /**
   * 获取缓存拦截器（如果启用了的话）
   */
  getCacheInterceptor(): CacheInterceptor | undefined {
    return this.cacheInterceptor;
  }
}
