/**
 * @nami/server - 开发服务器
 *
 * 结合 Koa + webpack-dev-middleware + webpack-hot-middleware，
 * 提供开发环境下的完整 SSR 开发体验。
 *
 * 功能特性：
 * 1. Webpack 实时编译 — 源码变更后自动重新编译
 * 2. HMR 热更新 — 客户端代码变更后无需刷新页面即可看到效果
 * 3. SSR 开发支持 — 服务端代码变更后自动重新加载服务端 bundle
 * 4. 错误覆盖 — 编译错误直接在浏览器中显示
 * 5. 源码映射 — 支持 source map，方便调试
 *
 * 开发服务器架构：
 * ```
 * Koa App
 *   ├── webpack-dev-middleware (拦截静态资源请求)
 *   ├── webpack-hot-middleware (提供 HMR 通道)
 *   └── SSR 渲染中间件 (使用内存中的服务端 bundle 渲染)
 * ```
 *
 * 与生产模式的区别：
 * - 不使用 koa-static（由 webpack-dev-middleware 接管静态资源）
 * - 不使用 ISR 缓存（开发环境每次都重新渲染）
 * - 启用 source map 和详细错误信息
 * - 使用内存文件系统（memfs），不写磁盘
 *
 * @example
 * ```typescript
 * import { createDevServer } from '@nami/server';
 *
 * const devServer = await createDevServer(namiConfig);
 * devServer.listen(3000);
 * ```
 */

import type Koa from 'koa';
import type { NamiConfig, Logger, NamiPlugin } from '@nami/shared';
import { createLogger } from '@nami/shared';
import type { Configuration as WebpackConfiguration, Compiler, Stats } from 'webpack';
import { DegradationManager, PluginLoader, PluginManager } from '@nami/core';
import type { AppElementFactory, HTMLRenderer, ModuleLoaderLike } from '@nami/core';

/**
 * 开发服务器配置选项
 */
export interface DevServerOptions {
  /** Nami 框架主配置 */
  config: NamiConfig;

  /** 客户端 Webpack 配置 */
  clientWebpackConfig: WebpackConfiguration;

  /** 服务端 Webpack 配置（用于 SSR） */
  serverWebpackConfig?: WebpackConfiguration;

  /**
   * 自定义日志实例
   */
  logger?: Logger;

  /**
   * 插件管理器实例（可选）
   * 提供后将使用完整的 renderMiddleware 进行 SSR 渲染；
   * 不提供则回退到简单的 CSR HTML shell。
   */
  pluginManager?: PluginManager;

  /**
   * 降级管理器实例（可选）
   * 配合 pluginManager 使用，提供渲染降级能力。
   */
  degradationManager?: DegradationManager;

  /** React 元素工厂（新 SSR 协议） */
  appElementFactory?: AppElementFactory;

  /** 兼容 entry-server.renderToHTML() 的 HTML 渲染函数 */
  htmlRenderer?: HTMLRenderer;

  /** 页面模块加载器 */
  moduleLoader?: ModuleLoaderLike;

  /**
   * 动态运行时提供器
   *
   * 开发模式下服务端 bundle 会持续重编译，这里允许按请求读取最新 runtime，
   * 避免 SSR 渲染继续使用旧代码。
   */
  runtimeProvider?: () => Promise<{
    appElementFactory?: AppElementFactory;
    htmlRenderer?: HTMLRenderer;
    moduleLoader?: ModuleLoaderLike;
  }>;

  /**
   * 开发服务器就绪回调
   * 当 Webpack 首次编译完成后调用
   */
  onReady?: () => void;
}

/** 模块级日志实例 */
const defaultLogger: Logger = createLogger('@nami/server:dev');

/**
 * 开发服务器实例
 *
 * 封装了 Koa 应用和 Webpack 编译器的关联关系
 */
export interface DevServer {
  /** Koa 应用实例 */
  app: Koa;

  /**
   * 启动监听
   * @param port - 端口号
   * @param host - 主机地址
   * @param callback - 启动成功回调
   */
  listen: (port: number, host?: string, callback?: () => void) => void;

  /**
   * 关闭开发服务器
   * 关闭 Webpack watcher、HTTP 服务器等
   */
  close: () => Promise<void>;
}

/**
 * 创建开发服务器
 *
 * 整合 Koa + Webpack dev/hot middleware，提供开发环境的完整 SSR 体验。
 *
 * @param options - 开发服务器配置
 * @returns 开发服务器实例
 */
export async function createDevServer(
  options: DevServerOptions,
): Promise<DevServer> {
  const { config, clientWebpackConfig, serverWebpackConfig } = options;
  const logger = options.logger ?? defaultLogger;
  let effectivePluginManager = options.pluginManager;
  let effectiveDegradationManager = options.degradationManager;
  const shouldDisposePluginManager = !options.pluginManager;

  logger.info('正在创建开发服务器...', {
    appName: config.appName,
    port: config.server.port,
  });

  /**
   * 动态导入 webpack
   *
   * webpack 是一个大型依赖，动态导入避免在生产环境中被加载。
   * 开发服务器仅在开发环境中使用。
   */
  let webpackFactory: (config: WebpackConfiguration) => Compiler;
  try {
    const webpackModule = await import('webpack');
    // `webpack` 在不同编译目标下可能表现为 default export 或模块本身。
    // 这里统一收敛成可调用工厂，避免 dev server 因模块互操作差异失效。
    webpackFactory = (
      (webpackModule as unknown as { default?: unknown }).default ?? webpackModule
    ) as (config: WebpackConfiguration) => Compiler;
  } catch {
    throw new Error(
      '开发服务器需要 webpack 依赖，请确保已安装: pnpm add -D webpack',
    );
  }

  // 创建 Koa 应用
  const Koa = (await import('koa')).default;
  const app = new Koa();

  // ===== 初始化插件系统 =====
  if (!effectivePluginManager) {
    effectivePluginManager = new PluginManager(config, logger);

    if (config.plugins.length > 0) {
      const resolvedPlugins: NamiPlugin[] = [];

      for (const pluginEntry of config.plugins) {
        try {
          const plugin = typeof pluginEntry === 'string'
            ? PluginLoader.load(pluginEntry, logger)
            : pluginEntry;
          resolvedPlugins.push(plugin);
        } catch (error) {
          logger.error('开发模式插件加载失败，已跳过', {
            plugin: pluginEntry,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await effectivePluginManager.registerPlugins(resolvedPlugins);
    }
  }

  if (!effectiveDegradationManager) {
    effectiveDegradationManager = new DegradationManager();
  }

  // 经过上面的兜底初始化后，开发服务器始终应持有一套可用的
  // pluginManager / degradationManager。这里收窄类型，避免后续中间件装配阶段
  // 不必要地继续传播 `undefined`。
  const resolvedPluginManager = effectivePluginManager!;
  const resolvedDegradationManager = effectiveDegradationManager!;

  // ===== 创建 Webpack 编译器 =====
  const clientCompiler: Compiler = webpackFactory(clientWebpackConfig);

  /**
   * 注册客户端 Webpack dev 和 hot 中间件
   */
  try {
    const { createWebpackDevMiddleware } = await import('./webpack-dev');
    const { createHMRMiddleware } = await import('./hmr-middleware');

    const devMiddleware = createWebpackDevMiddleware(clientCompiler, {
      publicPath: clientWebpackConfig.output?.publicPath as string || '/',
      logger,
    });

    const hmrMiddleware = createHMRMiddleware(clientCompiler, {
      logger,
    });

    app.use(devMiddleware);
    app.use(hmrMiddleware);
  } catch (error) {
    logger.error('注册 Webpack 开发中间件失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  /**
   * 服务端编译器（用于 SSR 开发模式）
   *
   * 如果提供了服务端 Webpack 配置，启动服务端编译 watcher。
   * 服务端 bundle 编译完成后，渲染中间件会使用最新的 bundle 进行 SSR。
   */
  let serverCompiler: Compiler | undefined;
  if (serverWebpackConfig) {
    const activeServerCompiler = webpackFactory(serverWebpackConfig);
    serverCompiler = activeServerCompiler;

    // 以 watch 模式启动服务端编译
    activeServerCompiler.watch(
      { aggregateTimeout: 300 },
      (err?: Error | null, stats?: Stats) => {
        if (err) {
          logger.error('服务端 Webpack 编译错误', {
            error: err.message,
          });
          return;
        }

        if (stats?.hasErrors()) {
          logger.error('服务端 Webpack 编译失败', {
            errors: stats.compilation.errors.map((e: Error) => e.message),
          });
          return;
        }

        logger.info('服务端 Webpack 编译完成', {
          duration: stats?.endTime && stats?.startTime
            ? stats.endTime - stats.startTime
            : undefined,
        });
      },
    );
  }

  // ===== 注册基础中间件 =====
  const { timingMiddleware } = await import('../middleware/timing');
  const { requestContextMiddleware } = await import('../middleware/request-context');
  const { healthCheckMiddleware } = await import('../middleware/health-check');
  const { errorIsolationMiddleware } = await import('../middleware/error-isolation');

  // 基础中间件（开发环境简化版）
  app.use(timingMiddleware());
  app.use(requestContextMiddleware());
  app.use(healthCheckMiddleware());
  app.use(errorIsolationMiddleware());

  // ===== 开发模式渲染中间件 =====
  /**
   * 开发模式统一复用正式的 renderMiddleware。
   *
   * 这样做有两个好处：
   * 1. dev / start / production 三条链路共享同一套渲染语义
   * 2. runtimeProvider 可以在每次请求前读取最新 server bundle，避免 HMR 后 SSR 仍用旧入口
   *
   * 如果运行时 bundle 尚未产出，renderMiddleware 会在内部按既有降级逻辑回退，
   * 不会阻塞整个开发服务器启动。
   */
  const { renderMiddleware } = await import('../middleware/render-middleware');

  app.use(renderMiddleware({
    config,
    pluginManager: resolvedPluginManager,
    degradationManager: resolvedDegradationManager,
    appElementFactory: options.appElementFactory,
    htmlRenderer: options.htmlRenderer,
    moduleLoader: options.moduleLoader,
    runtimeProvider: options.runtimeProvider,
  }));

  logger.info('已注册 SSR 渲染中间件（开发模式）');

  // ===== 监听首次编译完成 =====
  let isReady = false;

  clientCompiler.hooks.done.tap('NamiDevServer', (stats: Stats) => {
    if (!isReady && !stats.hasErrors()) {
      isReady = true;
      logger.info('Webpack 首次编译完成，开发服务器就绪');

      if (options.onReady) {
        options.onReady();
      }
    }
  });

  // ===== 构建 DevServer 实例 =====
  let httpServer: ReturnType<Koa['listen']> | null = null;

  return {
    app,

    listen(port: number, host?: string, callback?: () => void) {
      httpServer = app.listen(port, host ?? '0.0.0.0', () => {
        logger.info(`开发服务器已启动`, {
          address: `http://${host ?? '0.0.0.0'}:${port}`,
          mode: 'development',
        });
        callback?.();
      });
    },

    async close() {
      logger.info('正在关闭开发服务器...');

      // 关闭服务端编译 watcher
      if (serverCompiler) {
        await new Promise<void>((resolve) => {
          serverCompiler!.close(() => {
            resolve();
          });
        });
      }

      // 关闭 HTTP 服务器
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer!.close((err?: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      if (shouldDisposePluginManager) {
        await resolvedPluginManager.dispose();
      }

      logger.info('开发服务器已关闭');
    },
  };
}
