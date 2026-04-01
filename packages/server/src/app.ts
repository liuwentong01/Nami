/**
 * @nami/server - Koa 应用创建器
 *
 * createNamiServer 是 Nami 服务端的核心入口函数，
 * 负责创建一个完整配置的 Koa 应用实例，包含所有中间件管线。
 *
 * 中间件注册顺序（由外到内）：
 * ```
 * 1. timing             — 请求计时（记录 X-Response-Time）
 * 2. security           — 安全响应头（XSS、CSP、HSTS）
 * 3. requestContext      — 请求上下文（requestId、logger）
 * 4. healthCheck        — 健康检查（短路 /_health）
 * 5. staticServe        — 静态资源服务（JS/CSS/图片）
 * 6. [plugin middlewares] — 插件注册的自定义中间件
 * 7. errorIsolation     — 错误隔离（防止渲染错误崩溃进程）
 * 8. isrCache           — ISR 缓存层（stale-while-revalidate）
 * 9. render             — 核心渲染（SSR/CSR/SSG/ISR）
 * ```
 *
 * 中间件顺序的设计考量：
 * - timing 在最外层：确保计时覆盖所有中间件
 * - security 在早期：尽早设置安全头
 * - requestContext 在 healthCheck 之前：healthCheck 可以使用 requestId
 * - healthCheck 在 staticServe 之前：避免对静态资源也做路由匹配
 * - staticServe 在 plugin 之前：静态资源直接返回，不经过插件逻辑
 * - errorIsolation 包裹 isrCache 和 render：保护核心渲染逻辑
 * - isrCache 在 render 之前：命中缓存时短路跳过渲染
 *
 * @example
 * ```typescript
 * import { createNamiServer } from '@nami/server';
 *
 * const config = await loadConfig();
 * const { app, pluginManager, isrManager } = await createNamiServer(config);
 *
 * app.listen(3000, () => {
 *   console.log('Nami server running at http://localhost:3000');
 * });
 * ```
 */

import Koa from 'koa';
import type { NamiConfig, NamiPlugin, Logger } from '@nami/shared';
import { createLogger } from '@nami/shared';
import { PluginManager, PluginLoader } from '@nami/core';
import { DegradationManager } from '@nami/core';

// 中间件
import { timingMiddleware } from './middleware/timing';
import { securityMiddleware } from './middleware/security';
import { requestContextMiddleware } from './middleware/request-context';
import { healthCheckMiddleware } from './middleware/health-check';
import { staticServeMiddleware } from './middleware/static-serve';
import { errorIsolationMiddleware } from './middleware/error-isolation';
import { isrCacheMiddleware } from './middleware/isr-cache-middleware';
import { renderMiddleware } from './middleware/render-middleware';

// ISR
import { createCacheStore } from './isr/cache-store';
import { ISRManager } from './isr/isr-manager';
import type { AppElementFactory, HTMLRenderer, ModuleLoaderLike } from '@nami/core';

/** 模块级日志实例 */
const logger: Logger = createLogger('@nami/server:app');

/**
 * createNamiServer 的返回值
 */
export interface NamiServerInstance {
  /** Koa 应用实例 */
  app: Koa;

  /** 插件管理器 */
  pluginManager: PluginManager;

  /** ISR 管理器（仅当 ISR 启用时有值） */
  isrManager?: ISRManager;

  /** 降级管理器 */
  degradationManager: DegradationManager;
}

/**
 * createNamiServer 的配置选项
 */
export interface CreateServerOptions {
  /**
   * React 组件树工厂函数
   * SSR/ISR 模式下需要此函数来创建 React 元素树
   */
  appElementFactory?: AppElementFactory;

  /**
   * 兼容 entry-server.renderToHTML() 的 HTML 渲染函数
   */
  htmlRenderer?: HTMLRenderer;

  /**
   * 页面模块加载器
   *
   * 用于让默认服务端链路也能解析页面级数据预取函数，
   * 避免只有手写接入时才能拿到 getServerSideProps / getStaticProps。
   */
  moduleLoader?: ModuleLoaderLike;

  /**
   * 开发模式动态运行时提供器
   *
   * 当 server bundle 持续重编译时，通过该函数按请求读取最新 runtime，
   * 以免 Koa 进程一直持有旧版本入口。
   */
  runtimeProvider?: () => Promise<{
    appElementFactory?: AppElementFactory;
    htmlRenderer?: HTMLRenderer;
    moduleLoader?: ModuleLoaderLike;
  }>;

  /**
   * 自定义日志实例
   */
  logger?: Logger;
}

/**
 * 创建 Nami Koa 服务器
 *
 * 组装完整的中间件管线并返回 Koa 应用实例。
 * 这是 @nami/server 最重要的导出函数。
 *
 * @param config - Nami 框架主配置
 * @param options - 额外选项
 * @returns Nami 服务器实例
 */
export async function createNamiServer(
  config: NamiConfig,
  options: CreateServerOptions = {},
): Promise<NamiServerInstance> {
  const appLogger = options.logger ?? logger;

  appLogger.info('正在创建 Nami 服务器...', {
    appName: config.appName,
    defaultRenderMode: config.defaultRenderMode,
    port: config.server.port,
  });

  // ===== 1. 创建 Koa 应用 =====
  const app = new Koa();

  /**
   * 设置 Koa 应用级别的错误处理
   *
   * 这是最后一道防线，理论上不应该触发（errorIsolation 中间件会先捕获）。
   * 但为了绝对安全，还是注册一个全局错误处理器。
   */
  app.on('error', (err: Error, ctx?: Koa.Context) => {
    appLogger.error('Koa 全局错误（兜底捕获）', {
      error: err.message,
      stack: err.stack,
      url: ctx?.url,
      method: ctx?.method,
    });
  });

  // ===== 2. 初始化插件管理器 =====
  const pluginManager = new PluginManager(config, appLogger);

  /**
   * 注册插件
   *
   * 插件可以是 NamiPlugin 实例或字符串（包名）。
   * 字符串类型的插件会通过 PluginLoader 动态加载。
   */
  if (config.plugins && config.plugins.length > 0) {
    const resolvedPlugins: NamiPlugin[] = [];

    for (const pluginEntry of config.plugins) {
      if (typeof pluginEntry === 'string') {
        try {
          const loaded = await PluginLoader.load(pluginEntry);
          resolvedPlugins.push(loaded);
        } catch (error) {
          appLogger.error(`加载插件失败: ${pluginEntry}`, {
            plugin: pluginEntry,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        resolvedPlugins.push(pluginEntry);
      }
    }

    await pluginManager.registerPlugins(resolvedPlugins);
  }

  // ===== 3. 初始化降级管理器 =====
  const degradationManager = new DegradationManager();

  // ===== 4. 初始化 ISR 管理器（如果启用） =====
  let isrManager: ISRManager | undefined;

  if (config.isr.enabled) {
    appLogger.info('ISR 已启用，正在初始化缓存存储...', {
      cacheAdapter: config.isr.cacheAdapter,
    });

    const cacheStore = createCacheStore({
      cacheAdapter: config.isr.cacheAdapter,
      cacheDir: config.isr.cacheDir,
      redis: config.isr.redis,
    });

    isrManager = new ISRManager(config.isr, cacheStore);
  }

  // ===== 5. 注册中间件管线 =====

  /**
   * 中间件 1: 请求计时
   * 位于最外层，确保 X-Response-Time 头覆盖所有中间件的耗时
   */
  app.use(timingMiddleware());
  appLogger.debug('中间件已注册: timing');

  /**
   * 中间件 2: 安全响应头
   * 尽早设置安全相关的 HTTP 头部
   */
  app.use(securityMiddleware());
  appLogger.debug('中间件已注册: security');

  /**
   * 中间件 3: 请求上下文
   * 生成 requestId 和 child logger，供后续中间件使用
   */
  app.use(requestContextMiddleware());
  appLogger.debug('中间件已注册: requestContext');

  /**
   * 中间件 4: 健康检查
   * 命中 /_health 路径时短路返回，不经过后续中间件
   */
  app.use(healthCheckMiddleware());
  appLogger.debug('中间件已注册: healthCheck');

  /**
   * 中间件 5: 静态资源服务
   * 处理 JS/CSS/图片等静态文件请求
   */
  app.use(staticServeMiddleware());
  appLogger.debug('中间件已注册: staticServe');

  /**
   * 中间件 5.5: 用户自定义中间件
   * 在配置中通过 server.middlewares 注入的自定义中间件
   */
  if (config.server.middlewares && config.server.middlewares.length > 0) {
    for (const mw of config.server.middlewares) {
      app.use(mw);
    }
    appLogger.debug(`用户自定义中间件已注册: ${config.server.middlewares.length} 个`);
  }

  /**
   * 中间件 6: 插件中间件
   * 各插件通过 api.addServerMiddleware() 注册的中间件
   */
  const pluginMiddlewares = pluginManager.getServerMiddlewares();
  if (pluginMiddlewares.length > 0) {
    for (const mw of pluginMiddlewares) {
      app.use(mw);
    }
    appLogger.debug(`插件中间件已注册: ${pluginMiddlewares.length} 个`);
  }

  /**
   * 中间件 7: 错误隔离
   * 包裹 ISR 缓存层和渲染层，防止渲染错误崩溃进程
   */
  app.use(errorIsolationMiddleware());
  appLogger.debug('中间件已注册: errorIsolation');

  /**
   * 中间件 8: ISR 缓存层（仅当 ISR 启用时）
   * 在渲染之前检查 ISR 缓存，命中时短路返回
   */
  if (isrManager) {
    app.use(isrCacheMiddleware({
      config,
      isrManager,
    }));
    appLogger.debug('中间件已注册: isrCache');
  }

  /**
   * 中间件 9: 核心渲染
   * 执行完整的渲染流程：路由匹配 → 数据预取 → React 渲染 → HTML 输出
   */
  app.use(renderMiddleware({
    config,
    pluginManager,
    degradationManager,
    appElementFactory: options.appElementFactory,
    htmlRenderer: options.htmlRenderer,
    moduleLoader: options.moduleLoader,
    isrManager,
    runtimeProvider: options.runtimeProvider,
  }));
  appLogger.debug('中间件已注册: render');

  // ===== 6. 触发 onServerStart 钩子 =====
  // 注意：此时服务器尚未开始监听端口，钩子通知的是"应用创建完成"
  // 实际的端口监听在 startServer 中进行

  appLogger.info('Nami 服务器创建完成', {
    appName: config.appName,
    middlewareCount: 9 + pluginMiddlewares.length + (config.server.middlewares?.length ?? 0),
    pluginCount: pluginManager.getPluginCount(),
    isrEnabled: config.isr.enabled,
  });

  return {
    app,
    pluginManager,
    isrManager,
    degradationManager,
  };
}
