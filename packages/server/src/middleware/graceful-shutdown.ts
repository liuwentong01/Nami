/**
 * @nami/server - 优雅停机中间件
 *
 * 处理进程终止信号（SIGTERM、SIGINT），确保服务在关闭前完成所有进行中的请求。
 *
 * 优雅停机流程：
 * 1. 接收到 SIGTERM/SIGINT 信号
 * 2. 设置 isShuttingDown 标志为 true
 * 3. 新请求返回 503（Service Unavailable），附带 Connection: close 头
 * 4. 等待所有进行中的请求完成（或超时）
 * 5. 关闭 HTTP 服务器
 * 6. 执行清理回调（如关闭数据库连接、缓存连接等）
 * 7. 退出进程
 *
 * 为什么需要优雅停机？
 * - 直接 kill 进程会导致正在处理的请求被中断（用户看到连接重置错误）
 * - K8s 在滚动更新时会先发送 SIGTERM，等待一段时间后发送 SIGKILL
 * - 如果不处理 SIGTERM，K8s 将在 terminationGracePeriodSeconds 后强制杀进程
 * - 优雅停机确保用户请求不丢失，部署过程对用户透明
 *
 * @example
 * ```typescript
 * import { setupGracefulShutdown } from '@nami/server';
 *
 * const server = app.listen(3000);
 *
 * setupGracefulShutdown({
 *   server,
 *   timeout: 30000,
 *   onShutdown: async () => {
 *     await db.close();
 *     await redis.quit();
 *   },
 * });
 * ```
 */

import type { Server } from 'http';
import type Koa from 'koa';
import { createLogger } from '@nami/shared';
import type { Logger } from '@nami/shared';

/**
 * 优雅停机配置选项
 */
export interface GracefulShutdownOptions {
  /** HTTP 服务器实例 */
  server: Server;

  /**
   * 优雅停机超时时间（毫秒）
   *
   * 接收到终止信号后，最多等待此时间让进行中的请求完成。
   * 超时后强制关闭服务器。
   *
   * 默认: 30000（30秒）
   *
   * 注意：此值应小于 K8s 的 terminationGracePeriodSeconds（默认 30s），
   * 为 K8s 的 SIGKILL 留出一些余量。
   */
  timeout?: number;

  /**
   * 关闭前的清理回调
   *
   * 在 HTTP 服务器关闭后、进程退出前执行。
   * 用于关闭数据库连接、缓存连接、消息队列等外部资源。
   *
   * @returns Promise 或 void
   */
  onShutdown?: () => Promise<void> | void;

  /**
   * 收到停机信号后、server.close() 之前执行的同步回调。
   * 用于激活 shutdownAware 中间件，让后续到达的请求立即 503。
   */
  onSignalReceived?: () => void;

  /**
   * 自定义日志实例
   */
  logger?: Logger;
}

/** 模块级日志实例 */
const defaultLogger: Logger = createLogger('@nami/server:shutdown');

/**
 * 设置优雅停机处理
 *
 * 注册 SIGTERM 和 SIGINT 信号处理器，在收到信号时执行优雅停机流程。
 *
 * @param options - 优雅停机配置
 */
export function setupGracefulShutdown(options: GracefulShutdownOptions): void {
  const {
    server,
    timeout = 30000,
    onShutdown,
    onSignalReceived,
    logger = defaultLogger,
  } = options;

  /** 停机状态标志 — 防止重复触发 */
  let isShuttingDown = false;

  /**
   * 进行中的请求计数器
   *
   * 通过监听 server 的 'request' 和 'finish' 事件来追踪活跃连接数。
   * 当活跃连接数降为 0 时，可以安全地关闭服务器。
   */
  let activeConnections = 0;

  // 追踪请求开始
  server.on('request', (_req, res) => {
    activeConnections++;
    res.on('finish', () => {
      activeConnections--;
    });
  });

  /**
   * 优雅停机核心逻辑
   *
   * @param signal - 触发停机的信号名称
   */
  async function shutdown(signal: string): Promise<void> {
    // 防止重复触发（SIGTERM 和 SIGINT 可能同时到达）
    if (isShuttingDown) {
      logger.warn('停机已在进行中，忽略重复信号', { signal });
      return;
    }

    isShuttingDown = true;

    // 立即激活 shutdownAware 中间件，让新到达的请求返回 503
    if (onSignalReceived) {
      onSignalReceived();
    }

    logger.info(`收到 ${signal} 信号，开始优雅停机...`, {
      signal,
      activeConnections,
      timeout,
    });

    /**
     * 步骤 1：停止接受新连接
     *
     * server.close() 会停止接受新的 TCP 连接，
     * 但已建立的连接（进行中的请求）会继续处理。
     */
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          logger.error('关闭 HTTP 服务器失败', {
            error: err.message,
          });
          reject(err);
        } else {
          logger.info('HTTP 服务器已关闭（不再接受新连接）');
          resolve();
        }
      });
    });

    /**
     * 步骤 2：等待进行中的请求完成（或超时）
     *
     * 使用 Promise.race 实现超时机制：
     * - 如果所有请求在超时前完成，正常关闭
     * - 如果超时，强制关闭（某些请求可能被中断）
     */
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.warn('优雅停机超时，将强制关闭', {
          timeout,
          activeConnections,
        });
        resolve();
      }, timeout);
    });

    try {
      // 等待服务器关闭或超时
      await Promise.race([closePromise, timeoutPromise]);

      /**
       * 步骤 3：执行清理回调
       *
       * 在 HTTP 服务器关闭后执行，确保：
       * - 数据库连接池被正确关闭
       * - Redis 连接被正确关闭
       * - 缓存被持久化（如果需要）
       * - 日志被刷新
       */
      if (onShutdown) {
        logger.info('执行清理回调...');
        try {
          await onShutdown();
          logger.info('清理回调执行完成');
        } catch (cleanupError) {
          logger.error('清理回调执行失败', {
            error: cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          });
        }
      }

      logger.info('优雅停机完成，进程即将退出', { signal });

      /**
       * 步骤 4：退出进程
       *
       * 使用 process.exit(0) 表示正常退出。
       * 在容器环境中，退出码 0 表示服务正常终止，
       * K8s 不会认为是意外崩溃，不会触发重启策略。
       */
      process.exit(0);
    } catch (error) {
      logger.error('优雅停机过程中发生错误', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 异常退出使用退出码 1
      process.exit(1);
    }
  }

  /**
   * 注册信号处理器
   *
   * SIGTERM: K8s、Docker 等容器编排工具发送的终止信号
   * SIGINT:  用户在终端按 Ctrl+C 时发送的中断信号
   */
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  logger.debug('优雅停机处理器已注册', { timeout });
}

/**
 * 创建停机感知中间件
 *
 * 在服务进入停机状态后，对新请求返回 503 响应。
 * 此中间件应注册在所有其他中间件之前。
 *
 * @returns Koa 中间件函数和停机控制器
 */
export function createShutdownAwareMiddleware(): {
  middleware: Koa.Middleware;
  triggerShutdown: () => void;
} {
  let isShuttingDown = false;

  const middleware: Koa.Middleware = async (ctx, next) => {
    if (isShuttingDown) {
      /**
       * 服务正在停机中，拒绝新请求
       *
       * - 503 状态码告知负载均衡器此节点不可用
       * - Connection: close 告知客户端不要复用此连接
       * - Retry-After 建议客户端在多少秒后重试
       */
      ctx.status = 503;
      ctx.set('Connection', 'close');
      ctx.set('Retry-After', '5');
      ctx.body = {
        status: 'shutting_down',
        message: '服务正在停机中，请稍后重试',
      };
      return;
    }
    await next();
  };

  return {
    middleware,
    triggerShutdown: () => { isShuttingDown = true; },
  };
}
