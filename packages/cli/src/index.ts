/**
 * @nami/cli - CLI 主模块
 *
 * 创建和配置 Commander 命令行程序，
 * 注册所有子命令。
 */

import { Command } from 'commander';
import { registerDevCommand } from './commands/dev';
import { registerBuildCommand } from './commands/build';
import { registerStartCommand } from './commands/start';
import { registerGenerateCommand } from './commands/generate';
import { registerAnalyzeCommand } from './commands/analyze';
import { registerInfoCommand } from './commands/info';

/**
 * 创建 CLI 程序实例
 *
 * @returns Commander 程序实例
 */
export function createCLI(): Command {
  const program = new Command();

  program
    .name('nami')
    .description('Nami 框架命令行工具 - CSR/SSR/SSG/ISR 全链路解决方案')
    .version('0.1.0', '-v, --version', '输出版本号');

  // 注册子命令
  registerDevCommand(program);
  registerBuildCommand(program);
  registerStartCommand(program);
  registerGenerateCommand(program);
  registerAnalyzeCommand(program);
  registerInfoCommand(program);

  return program;
}
