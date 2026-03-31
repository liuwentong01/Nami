/**
 * @nami/server - 集群模式工作进程
 *
 * 工作进程负责启动 Koa HTTP 服务器并处理实际的请求。
 * 每个工作进程都是独立的 Node.js 进程，拥有独立的事件循环和内存空间。
 *
 * 工作进程的生命周期：
 * 1. 初始化 — 加载配置、创建 Koa 应用、注册中间件
 * 2. 监听 — 绑定端口开始接受 HTTP 请求
 * 3. 运行 — 持续处理请求
 * 4. 停机 — 收到 SIGTERM 后执行优雅停机
 *
 * 与主进程的关系：
 * - 主进程通过 cluster.fork() 创建工作进程
 * - 工作进程通过 process.send() 向主进程发送消息
 * - 主进程通过 worker.send() 向工作进程发送消息
 * - 所有工作进程共享同一个端口（由操作系统内核分发请求）
 *
 * @example
 * ```typescript
 * import { startWorker } from '@nami/server';
 *
 * if (cluster.isWorker) {
 *   startWorker(config);
 * }
 * ```
 */

import cluster from 'cluster';
import type { NamiConfig, Logger } from '@nami/shared';
import { createLogger } from '@nami/shared';
import { createNamiServer } from '../app';
import { setupGracefulShutdown } from '../middleware/graceful-shutdown';

/**
 * 工作进程配置选项
 */
export interface WorkerOptions {
  /** Nami 框架主配置 */
  config: NamiConfig;

  /**
   * 自定义日志实例
   */
  logger?: Logger;

  /**
   * 服务启动成功回调
   */
  onReady?: (info: { port: number; host: string; pid: number }) => void;

  /**
   * 自定义停机清理逻辑
   */
  onShutdown?: () => Promise<void> | void;
}

/** 模块级日志实例 */
const defaultLogger: Logger = createLogger('@nami/server:worker');

/**
 * 启动工作进程
 *
 * 创建 Koa 应用，注册中间件管线，绑定端口开始接受请求。
 *
 * @param options - 工作进程配置
 */
export async function startWorker(options: WorkerOptions): Promise<void> {
  const { config, onReady, onShutdown } = options;
  const logger = options.logger ?? defaultLogger;

  const { port, host } = config.server;
  const workerId = cluster.worker?.id ?? 0;
  const pid = process.pid;

  logger.info(`工作进程启动中`, {
    workerId,
    pid,
    port,
    host,
  });

  try {
    // ===== 1. 创建 Koa 应用 =====
    const { app } = await createNamiServer(config);

    // ===== 2. 启动 HTTP 服务器 =====
    const server = app.listen(port, host, () => {
      logger.info(`工作进程就绪`, {
        workerId,
        pid,
        port,
        host,
        address: `http://${host}:${port}`,
      });

      /**
       * 通知主进程：工作进程已就绪
       * 主进程可据此判断是否所有工作进程都已启动完成
       */
      if (process.send) {
        process.send({
          type: 'worker:ready',
          workerId,
          pid,
          port,
        });
      }

      // 执行自定义回调
      if (onReady) {
        onReady({ port, host, pid });
      }
    });

    // ===== 3. 设置优雅停机 =====
    setupGracefulShutdown({
      server,
      timeout: config.server.gracefulShutdownTimeout,
      logger,
      onShutdown: async () => {
        logger.info('工作进程开始清理资源', {
          workerId,
          pid,
        });

        // 执行自定义清理逻辑
        if (onShutdown) {
          await onShutdown();
        }

        logger.info('工作进程清理完成', {
          workerId,
          pid,
        });
      },
    });

    // ===== 4. 处理未捕获的异常 =====

    /**
     * 未捕获的同步异常
     *
     * 工作进程中的未捕获异常通常意味着进程状态已不可信，
     * 记录日志后让进程退出，由主进程负责重启。
     */
    process.on('uncaughtException', (error) => {
      logger.fatal('工作进程未捕获异常', {
        workerId,
        pid,
        error: error.message,
        stack: error.stack,
      });

      // 给优雅停机一些时间
      setTimeout(() => {
        process.exit(1);
      }, 5000);
    });

    /**
     * 未处理的 Promise rejection
     *
     * 从 Node.js 15 开始，未处理的 rejection 默认会导致进程退出。
     * 这里显式处理以确保行为一致且有日志。
     */
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('工作进程未处理的 Promise rejection', {
        workerId,
        pid,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    });

  } catch (error) {
    logger.fatal('工作进程启动失败', {
      workerId,
      pid,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    process.exit(1);
  }
}
