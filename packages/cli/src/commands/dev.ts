/**
 * @nami/cli - dev 命令
 *
 * 启动开发服务器：
 * 1. 加载配置
 * 2. 创建 Webpack Dev Client + Server 编译器
 * 3. 启动 Koa 服务 + Webpack Dev/HMR Middleware
 * 4. 监听文件变化实时编译
 */

import type { Command } from 'commander';
import { loadConfig } from '../config/load-config';
import { cliLogger } from '../utils/logger';
import { findAvailablePort } from '../utils/port-finder';
import { createSpinner } from '../utils/spinner';
import { resolveServerRuntime } from '../utils/server-runtime';
import chalk from 'chalk';

/**
 * 注册 dev 命令
 */
export function registerDevCommand(program: Command): void {
  program
    .command('dev')
    .description('启动开发服务器（支持 HMR 热更新）')
    .option('-p, --port <port>', '指定端口号', '3000')
    .option('-H, --host <host>', '指定监听地址', '0.0.0.0')
    .option('--no-open', '不自动打开浏览器')
    .action(async (options) => {
      try {
        const spinner = createSpinner('正在启动开发服务器...');
        spinner.start();

        // 加载配置
        const config = await loadConfig(process.cwd());

        // 检测端口可用性
        const preferredPort = parseInt(options.port, 10);
        const port = await findAvailablePort(preferredPort);

        if (port !== preferredPort) {
          cliLogger.warn(`端口 ${preferredPort} 已被占用，使用端口 ${port}`);
        }

        // 更新配置中的端口
        config.server.port = port;
        config.server.host = options.host;

        spinner.text = '正在编译...';

        // 动态导入服务端模块（避免未安装时报错）
        const { createDevServer } = await import('@nami/server');
        const { createDevClientConfig, createDevServerConfig } = await import('@nami/webpack');

        // 创建 Webpack 配置
        const clientConfig = createDevClientConfig({
          config,
          projectRoot: process.cwd(),
        });
        const serverConfig = createDevServerConfig({
          config,
          projectRoot: process.cwd(),
        });

        // 开发模式下 server bundle 会持续重编译。
        // 因此这里不把运行时对象固定死，而是每个请求按需读取最新的构建产物。
        const devServer = await createDevServer({
          config,
          clientWebpackConfig: clientConfig,
          serverWebpackConfig: serverConfig,
          runtimeProvider: async () => resolveServerRuntime({
            projectRoot: process.cwd(),
            config,
            fresh: true,
          }),
        });

        devServer.listen(port, options.host);

        spinner.stop();

        cliLogger.newline();
        cliLogger.success('开发服务器已启动');
        cliLogger.newline();
        cliLogger.indent(`${chalk.bold('Local:')}   ${chalk.cyan(`http://localhost:${port}`)}`);
        cliLogger.indent(`${chalk.bold('Network:')} ${chalk.cyan(`http://${options.host}:${port}`)}`);
        cliLogger.newline();
        cliLogger.indent(chalk.gray('按 Ctrl+C 停止服务'));
        cliLogger.newline();
      } catch (error) {
        const err = error as Error;
        cliLogger.error(`开发服务器启动失败: ${err.message}`);
        process.exit(1);
      }
    });
}
