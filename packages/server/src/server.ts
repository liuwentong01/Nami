/**
 * @nami/server - 服务器启动器
 *
 * startServer 是启动 Nami HTTP 服务器的高层入口函数。
 * 它封装了服务器创建、端口监听、优雅停机、集群模式等逻辑。
 *
 * 启动流程：
 * 1. 判断是否启用集群模式
 *    - 是: 主进程 fork 工作进程，每个工作进程独立启动
 *    - 否: 单进程直接启动
 * 2. 创建 Nami Koa 应用（createNamiServer）
 * 3. 绑定端口开始监听
 * 4. 设置优雅停机处理
 * 5. 触发 onServerStart 钩子通知插件
 *
 * @example
 * ```typescript
 * import { startServer } from '@nami/server';
 * import { loadConfig } from '@nami/core';
 *
 * const config = await loadConfig();
 * await startServer(config);
 * // 服务器已在 http://0.0.0.0:3000 启动
 * ```
 */

import cluster from 'cluster';
import type { Server } from 'http';
import type { NamiConfig, Logger } from '@nami/shared';
import { createLogger } from '@nami/shared';
import { createNamiServer, type NamiServerInstance, type CreateServerOptions } from './app';
import { setupGracefulShutdown } from './middleware/graceful-shutdown';
import { startMaster } from './cluster/master';

/** 模块级日志实例 */
const logger: Logger = createLogger('@nami/server');

/**
 * 服务器启动配置选项
 */
export interface StartServerOptions extends CreateServerOptions {
  /**
   * 服务启动成功回调
   */
  onReady?: (info: {
    port: number;
    host: string;
    pid: number;
    isCluster: boolean;
  }) => void;

  /**
   * 自定义停机清理逻辑
   */
  onShutdown?: () => Promise<void> | void;
}

/**
 * 服务器启动结果
 */
export interface StartServerResult {
  /** Nami 服务器实例 */
  serverInstance: NamiServerInstance;

  /** HTTP 服务器实例（单进程模式下有值） */
  httpServer?: Server;
}

/**
 * 启动 Nami HTTP 服务器
 *
 * 根据配置自动选择单进程或集群模式启动服务器。
 *
 * @param config - Nami 框架主配置
 * @param options - 启动选项
 * @returns 服务器启动结果
 */
export async function startServer(
  config: NamiConfig,
  options: StartServerOptions = {},
): Promise<StartServerResult | void> {
  const serverLogger = options.logger ?? logger;

  const { port, host } = config.server;
  const isClusterMode = !!config.server.cluster;

  // ===== 集群模式 =====
  if (isClusterMode && cluster.isPrimary) {
    serverLogger.info('以集群模式启动', {
      workers: config.server.cluster?.workers ?? 0,
    });

    /**
     * 主进程：fork 工作进程
     * 主进程自身不处理 HTTP 请求，只负责进程管理
     */
    startMaster({
      workers: config.server.cluster?.workers,
      logger: serverLogger,
      onAllWorkersReady: () => {
        serverLogger.info('所有工作进程已就绪', {
          workers: config.server.cluster?.workers ?? 'auto',
        });

        if (options.onReady) {
          options.onReady({
            port,
            host,
            pid: process.pid,
            isCluster: true,
          });
        }
      },
    });

    // 主进程不返回服务器实例
    return;
  }

  // ===== 单进程模式（或集群模式下的工作进程） =====
  serverLogger.info('正在启动 Nami 服务器...', {
    appName: config.appName,
    port,
    host,
    isWorker: cluster.isWorker,
    pid: process.pid,
  });

  // 创建 Nami 服务器
  const serverInstance = await createNamiServer(config, options);
  const { app, pluginManager, isrManager } = serverInstance;

  // 绑定端口
  const httpServer: Server = await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      serverLogger.info(`Nami 服务器已启动`, {
        address: `http://${host}:${port}`,
        pid: process.pid,
        isWorker: cluster.isWorker,
        appName: config.appName,
      });

      // 集群 Worker 进程需要通知主进程端口已绑定、可接受请求
      if (cluster.isWorker && process.send) {
        process.send({
          type: 'worker:ready',
          workerId: cluster.worker?.id ?? 0,
          pid: process.pid,
          port,
        });
      }

      resolve(server);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        serverLogger.fatal(`端口 ${port} 已被占用`, {
          port,
          error: err.message,
        });
      } else {
        serverLogger.fatal('服务器启动失败', {
          error: err.message,
          code: err.code,
        });
      }
      reject(err);
    });
  });

  // ===== 设置优雅停机 =====
  if (config.server.gracefulShutdown) {
    setupGracefulShutdown({
      server: httpServer,
      timeout: config.server.gracefulShutdownTimeout,
      logger: serverLogger,
      onSignalReceived: serverInstance.triggerShutdown,
      onShutdown: async () => {
        serverLogger.info('开始执行停机清理...');

        // 关闭 ISR 管理器
        if (isrManager) {
          await isrManager.close();
        }

        // 销毁插件管理器
        await pluginManager.dispose();

        // 执行用户自定义清理逻辑
        if (options.onShutdown) {
          await options.onShutdown();
        }

        serverLogger.info('停机清理完成');
      },
    });
  }

  // ===== 触发 onServerStart 钩子 =====
  try {
    await pluginManager.runParallelHook('onServerStart', { port, host });
  } catch (error) {
    serverLogger.warn('onServerStart 钩子执行失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 执行就绪回调
  if (options.onReady) {
    options.onReady({
      port,
      host,
      pid: process.pid,
      isCluster: isClusterMode,
    });
  }

  return {
    serverInstance,
    httpServer,
  };
}
