/**
 * @nami/cli - CLI 日志工具
 *
 * 提供带颜色和图标的终端日志输出。
 */

import chalk from 'chalk';

/** CLI 日志前缀 */
const PREFIX = chalk.cyan('[nami]');

/**
 * CLI 日志工具
 */
export const cliLogger = {
  /** 信息日志 */
  info(message: string): void {
    console.log(`${PREFIX} ${chalk.blue('info')} ${message}`);
  },

  /** 成功日志 */
  success(message: string): void {
    console.log(`${PREFIX} ${chalk.green('success')} ${message}`);
  },

  /** 警告日志 */
  warn(message: string): void {
    console.warn(`${PREFIX} ${chalk.yellow('warn')} ${message}`);
  },

  /** 错误日志 */
  error(message: string): void {
    console.error(`${PREFIX} ${chalk.red('error')} ${message}`);
  },

  /** 调试日志（仅在 DEBUG=nami 时输出） */
  debug(message: string): void {
    if (process.env.DEBUG?.includes('nami')) {
      console.debug(`${PREFIX} ${chalk.gray('debug')} ${message}`);
    }
  },

  /** 空行 */
  newline(): void {
    console.log();
  },

  /** 带缩进的日志 */
  indent(message: string, level: number = 1): void {
    const spaces = '  '.repeat(level);
    console.log(`${spaces}${message}`);
  },

  /** 分隔线 */
  divider(): void {
    console.log(chalk.gray('─'.repeat(50)));
  },
};
