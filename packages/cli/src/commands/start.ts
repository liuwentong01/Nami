/**
 * @nami/cli - start 命令
 *
 * 启动生产服务器：
 * 1. 加载配置
 * 2. 加载构建产物
 * 3. 创建 Koa 服务器
 * 4. 启动 HTTP 监听
 */

import type { Command } from 'commander';
import { loadConfig } from '../config/load-config';
import { cliLogger } from '../utils/logger';
import { findAvailablePort } from '../utils/port-finder';
import { resolveServerRuntime } from '../utils/server-runtime';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

/**
 * 注册 start 命令
 */
export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('启动生产服务器')
    .option('-p, --port <port>', '指定端口号')
    .option('-H, --host <host>', '指定监听地址')
    .option('--cluster', '启用集群模式')
    .action(async (options) => {
      try {
        // 加载配置
        const config = await loadConfig(process.cwd());

        // 检查构建产物是否存在。
        // 这里使用合并后的 config.outDir，而不是写死 dist，
        // 避免自定义输出目录的项目被误判为“未构建”。
        const outDir = path.resolve(process.cwd(), config.outDir);
        if (!fs.existsSync(outDir)) {
          cliLogger.error(`未找到构建产物目录: ${config.outDir}。请先运行 \`nami build\``);
          process.exit(1);
        }

        // 端口配置
        if (options.port) {
          config.server.port = parseInt(options.port, 10);
        }
        if (options.host) {
          config.server.host = options.host;
        }

        const port = await findAvailablePort(config.server.port);
        config.server.port = port;

        // 集群模式
        if (options.cluster) {
          config.server.cluster = config.server.cluster || { workers: 0 };
        }

        cliLogger.info(`正在启动生产服务器...`);

        // 动态导入服务端模块
        const { startServer } = await import('@nami/server');
        const runtime = resolveServerRuntime({
          projectRoot: process.cwd(),
          config,
          fresh: false,
        });

        await startServer(config, {
          appElementFactory: runtime.appElementFactory,
          htmlRenderer: runtime.htmlRenderer,
          moduleLoader: runtime.moduleLoader,
        });

        cliLogger.newline();
        cliLogger.success('生产服务器已启动');
        cliLogger.indent(`${chalk.bold('Local:')}   ${chalk.cyan(`http://localhost:${port}`)}`);
        cliLogger.indent(`${chalk.bold('Network:')} ${chalk.cyan(`http://${config.server.host}:${port}`)}`);
        if (config.server.cluster) {
          cliLogger.indent(`${chalk.bold('Mode:')}    ${chalk.cyan('集群模式')}`);
        }
        cliLogger.newline();
      } catch (error) {
        const err = error as Error;
        cliLogger.error(`服务启动失败: ${err.message}`);
        process.exit(1);
      }
    });
}
