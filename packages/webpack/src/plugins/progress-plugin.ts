/**
 * @nami/webpack - 构建进度显示插件
 *
 * 在终端显示友好的构建进度信息，
 * 包括当前阶段、进度百分比和耗时。
 */

import type { Compiler } from 'webpack';
import webpack from 'webpack';

/**
 * 进度插件选项
 */
export interface ProgressPluginOptions {
  /** 构建名称（如 'client', 'server'） */
  name?: string;
  /** 是否显示详细信息 */
  verbose?: boolean;
}

/**
 * 创建构建进度插件
 *
 * @param options - 进度插件选项
 * @returns WebpackPluginInstance
 */
export function createProgressPlugin(
  options: ProgressPluginOptions = {},
): webpack.WebpackPluginInstance {
  const { name = 'build', verbose = false } = options;

  return new webpack.ProgressPlugin({
    activeModules: verbose,
    entries: true,
    modules: true,
    profile: verbose,
    handler: (percentage, message, ...args) => {
      const percent = Math.round(percentage * 100);
      const detail = args.length > 0 ? ` ${args[0]}` : '';

      // 只在关键节点输出（避免终端刷屏）
      if (percent % 10 === 0 || percent === 100) {
        const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
        process.stdout.write(
          `\r[${name}] [${bar}] ${percent}% ${message}${detail}`.padEnd(80),
        );

        if (percent === 100) {
          process.stdout.write('\n');
        }
      }
    },
  });
}
