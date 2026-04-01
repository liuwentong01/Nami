/**
 * @nami/server - 集群模式主进程
 *
 * 在多核 CPU 环境中，使用 Node.js cluster 模块创建多个工作进程，
 * 充分利用硬件资源，提高服务的并发处理能力。
 *
 * 主进程职责：
 * 1. 根据配置 fork 指定数量的工作进程
 * 2. 监听工作进程退出事件，自动重启崩溃的工作进程
 * 3. 限制重启频率，防止频繁崩溃导致的无限重启循环
 * 4. 转发优雅停机信号给所有工作进程
 *
 * 进程模型：
 * ```
 * Master Process (主进程)
 *   ├── Worker 1 (工作进程 - Koa 服务器)
 *   ├── Worker 2 (工作进程 - Koa 服务器)
 *   ├── Worker 3 (工作进程 - Koa 服务器)
 *   └── Worker N (工作进程 - Koa 服务器)
 * ```
 *
 * 负载均衡：
 * - Linux/macOS: 由操作系统内核的 SO_REUSEPORT 或 round-robin 分配
 * - cluster 模块默认使用 round-robin 策略（除了 Windows）
 *
 * @example
 * ```typescript
 * import { startMaster } from '@nami/server';
 *
 * if (cluster.isPrimary) {
 *   startMaster({ workers: 4 });
 * }
 * ```
 */

import cluster from 'cluster';
import os from 'os';
import { createLogger } from '@nami/shared';
import type { Logger } from '@nami/shared';

/**
 * 主进程配置选项
 */
export interface MasterOptions {
  /**
   * 工作进程数量
   *
   * - 正数: 指定具体的进程数量
   * - 0: 使用 CPU 核心数（推荐值）
   * - 负数: CPU 核心数 - |workers|（保留部分核心给系统）
   *
   * 默认: 0（CPU 核心数）
   */
  workers?: number;

  /**
   * 工作进程崩溃后的重启延迟（毫秒）
   * 防止频繁重启导致 CPU 空转
   * 默认: 1000
   */
  restartDelay?: number;

  /**
   * 最大连续重启次数
   * 在指定时间窗口内连续崩溃超过此次数后，停止重启
   * 默认: 10
   */
  maxRestarts?: number;

  /**
   * 重启计数重置时间窗口（毫秒）
   * 默认: 60000（1分钟）
   */
  restartWindow?: number;

  /**
   * 自定义日志实例
   */
  logger?: Logger;

  /**
   * 工作进程就绪回调
   * 当所有工作进程都启动完成后调用
   */
  onAllWorkersReady?: () => void;
}

/** 模块级日志实例 */
const defaultLogger: Logger = createLogger('@nami/server:master');

/**
 * 启动主进程
 *
 * fork 指定数量的工作进程，并建立进程管理机制。
 *
 * @param options - 主进程配置
 */
export function startMaster(options: MasterOptions = {}): void {
  const logger = options.logger ?? defaultLogger;

  /**
   * 计算实际的工作进程数量
   */
  const cpuCount = os.cpus().length;
  let workerCount: number;

  if (!options.workers || options.workers === 0) {
    workerCount = cpuCount;
  } else if (options.workers < 0) {
    // 负数表示保留核心数
    workerCount = Math.max(1, cpuCount + options.workers);
  } else {
    workerCount = options.workers;
  }

  const restartDelay = options.restartDelay ?? 1000;
  const maxRestarts = options.maxRestarts ?? 10;
  const restartWindow = options.restartWindow ?? 60000;

  /** 重启计数器（用于检测频繁崩溃） */
  let restartCount = 0;
  let restartWindowStart = Date.now();

  logger.info(`主进程启动，PID: ${process.pid}`, {
    pid: process.pid,
    workerCount,
    cpuCount,
    restartDelay,
    maxRestarts,
  });

  /** 已就绪的工作进程计数 */
  let readyWorkers = 0;

  // ===== fork 工作进程 =====
  for (let i = 0; i < workerCount; i++) {
    forkWorker();
  }

  /**
   * fork 一个新的工作进程
   */
  function forkWorker(): void {
    const worker = cluster.fork();

    logger.info(`工作进程已 fork`, {
      workerPid: worker.process.pid,
      workerId: worker.id,
    });

    /**
     * 监听工作进程消息
     *
     * 关键语义：使用 worker:ready 消息（而非 online 事件）判断就绪。
     * online 事件仅表示进程已 fork 成功，但此时 Koa 尚未绑定端口；
     * worker:ready 由 startWorker 在 app.listen 回调中发送，
     * 确保该工作进程确实能处理 HTTP 请求后才计入就绪。
     */
    worker.on('message', (message: Record<string, unknown>) => {
      if (message.type === 'worker:ready') {
        readyWorkers++;
        logger.info(`工作进程就绪（已绑定端口）`, {
          workerPid: worker.process.pid,
          workerId: worker.id,
          readyWorkers,
          totalWorkers: workerCount,
        });

        if (readyWorkers === workerCount && options.onAllWorkersReady) {
          options.onAllWorkersReady();
        }
      } else {
        logger.debug('收到工作进程消息', {
          workerPid: worker.process.pid,
          message,
        });
      }
    });
  }

  // ===== 监听工作进程退出 =====
  cluster.on('exit', (worker, code, signal) => {
    readyWorkers = Math.max(0, readyWorkers - 1);

    /**
     * 工作进程退出原因分析
     *
     * - signal 非空: 进程被信号杀死（如 SIGTERM、SIGKILL）
     * - code === 0: 正常退出
     * - code !== 0: 异常退出（崩溃）
     */
    const exitReason = signal
      ? `被信号 ${signal} 终止`
      : code !== 0
        ? `异常退出，退出码 ${code}`
        : '正常退出';

    logger.warn(`工作进程退出: ${exitReason}`, {
      workerPid: worker.process.pid,
      workerId: worker.id,
      code,
      signal,
      exitReason,
    });

    /**
     * 判断是否需要重启
     *
     * 不重启的情况：
     * - 正常退出（code === 0）— 通常是优雅停机
     * - 被 SIGTERM 信号终止 — 通常是人工停止或 K8s 滚动更新
     * - 连续重启次数超过上限 — 防止无限重启循环
     */
    if (signal === 'SIGTERM' || code === 0) {
      logger.info('工作进程正常退出，不自动重启', {
        workerPid: worker.process.pid,
      });
      return;
    }

    // 检查重启频率
    const now = Date.now();
    if (now - restartWindowStart > restartWindow) {
      // 重置计数窗口
      restartCount = 0;
      restartWindowStart = now;
    }

    restartCount++;

    if (restartCount > maxRestarts) {
      logger.error(
        `工作进程在 ${restartWindow}ms 内连续崩溃 ${restartCount} 次，` +
        `超过最大重启次数 ${maxRestarts}，停止重启`,
        {
          restartCount,
          maxRestarts,
          restartWindow,
        },
      );
      return;
    }

    // 延迟重启
    logger.info(`将在 ${restartDelay}ms 后重启工作进程`, {
      restartDelay,
      restartCount,
      maxRestarts,
    });

    setTimeout(() => {
      forkWorker();
    }, restartDelay);
  });

  // ===== 处理主进程终止信号 =====
  function handleMasterShutdown(signal: string): void {
    logger.info(`主进程收到 ${signal} 信号，通知所有工作进程停机`, {
      signal,
      workerCount: Object.keys(cluster.workers ?? {}).length,
    });

    /**
     * 向所有工作进程发送 SIGTERM 信号
     * 工作进程收到 SIGTERM 后会执行各自的优雅停机逻辑
     */
    for (const id in cluster.workers) {
      const worker = cluster.workers[id];
      if (worker) {
        worker.process.kill('SIGTERM');
      }
    }

    /**
     * 设置主进程超时退出
     * 如果工作进程在超时时间内未全部退出，主进程强制退出
     */
    setTimeout(() => {
      logger.warn('主进程等待超时，强制退出');
      process.exit(1);
    }, 35000); // 比工作进程的优雅停机超时多 5 秒
  }

  process.on('SIGTERM', () => handleMasterShutdown('SIGTERM'));
  process.on('SIGINT', () => handleMasterShutdown('SIGINT'));
}
