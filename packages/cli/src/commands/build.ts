/**
 * @nami/cli - build 命令
 *
 * 执行生产构建：
 * 1. 加载配置
 * 2. 创建 NamiBuilder
 * 3. 执行完整构建流程（Client + Server + SSG）
 * 4. 输出构建结果统计
 */

import type { Command } from 'commander';
import { loadConfig } from '../config/load-config';
import { cliLogger } from '../utils/logger';
import { createSpinner } from '../utils/spinner';
import chalk from 'chalk';

/**
 * 注册 build 命令
 */
export function registerBuildCommand(program: Command): void {
  program
    .command('build')
    .description('执行生产构建')
    .option('--analyze', '生成 Bundle 分析报告')
    .option('--no-minimize', '跳过代码压缩（调试用）')
    .action(async (options) => {
      try {
        const startTime = Date.now();
        const spinner = createSpinner('正在加载配置...');
        spinner.start();

        // 加载配置
        const config = await loadConfig(process.cwd());

        spinner.text = '正在构建...';

        // 动态导入构建模块
        const { NamiBuilder } = await import('@nami/webpack');

        // 创建构建器并执行构建
        const builder = new NamiBuilder(config, process.cwd());
        const result = await builder.build('production');

        spinner.stop();

        // 输出构建结果
        cliLogger.newline();
        if (result.success) {
          cliLogger.success(`构建成功！耗时 ${chalk.bold(formatDuration(result.duration))}`);
        } else {
          cliLogger.error(`构建失败，共 ${result.errors.length} 个错误`);
          for (const error of result.errors) {
            cliLogger.indent(chalk.red(`  - ${error}`));
          }
        }

        // 输出警告
        if (result.warnings.length > 0) {
          cliLogger.warn(`共 ${result.warnings.length} 个警告`);
          for (const warning of result.warnings.slice(0, 5)) {
            cliLogger.indent(chalk.yellow(`  - ${warning}`));
          }
          if (result.warnings.length > 5) {
            cliLogger.indent(chalk.gray(`  ... 还有 ${result.warnings.length - 5} 个警告`));
          }
        }

        cliLogger.newline();

        if (!result.success) {
          process.exit(1);
        }
      } catch (error) {
        const err = error as Error;
        cliLogger.error(`构建失败: ${err.message}`);
        process.exit(1);
      }
    });
}

/**
 * 格式化时间
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
