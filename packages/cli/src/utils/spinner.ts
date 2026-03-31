/**
 * @nami/cli - 终端加载动画
 *
 * 封装 ora 库，提供统一的加载状态展示。
 */

import ora from 'ora';
import type { Ora } from 'ora';

/**
 * 创建带品牌前缀的 Spinner
 *
 * @param text - 加载提示文本
 * @returns Ora spinner 实例
 *
 * @example
 * ```typescript
 * const spinner = createSpinner('正在构建...');
 * spinner.start();
 * await build();
 * spinner.succeed('构建完成');
 * ```
 */
export function createSpinner(text: string): Ora {
  return ora({
    text,
    prefixText: '\x1b[36m[nami]\x1b[0m',
    spinner: 'dots',
  });
}

/**
 * 带自动完成/失败处理的异步 Spinner
 *
 * @param text - 加载提示文本
 * @param fn - 要执行的异步函数
 * @returns 异步函数的返回值
 */
export async function withSpinner<T>(
  text: string,
  fn: () => Promise<T>,
): Promise<T> {
  const spinner = createSpinner(text);
  spinner.start();

  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}
