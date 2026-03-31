/**
 * @nami/server - 集群模式导出入口
 *
 * 提供 Node.js cluster 模式的主从进程管理能力：
 *
 * - Master: 主进程，负责 fork 工作进程和进程生命周期管理
 * - Worker: 工作进程，每个进程运行一个独立的 Koa HTTP 服务器
 *
 * 使用方式：
 * ```typescript
 * import cluster from 'cluster';
 * import { startMaster, startWorker } from '@nami/server';
 *
 * if (cluster.isPrimary) {
 *   startMaster({ workers: 4 });
 * } else {
 *   startWorker({ config: namiConfig });
 * }
 * ```
 */

// ===== 主进程 =====
export { startMaster } from './master';
export type { MasterOptions } from './master';

// ===== 工作进程 =====
export { startWorker } from './worker';
export type { WorkerOptions } from './worker';
