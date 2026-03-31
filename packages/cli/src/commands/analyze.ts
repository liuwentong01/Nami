/**
 * @nami/cli - analyze 命令
 *
 * 生成 Bundle 分析报告，帮助优化产物体积。
 * 使用 webpack-bundle-analyzer 生成可视化报告。
 */

import type { Command } from 'commander';
import { loadConfig } from '../config/load-config';
import { cliLogger } from '../utils/logger';
import { withSpinner } from '../utils/spinner';

/**
 * 注册 analyze 命令
 */
export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('分析 Bundle 产物体积')
    .option('--target <target>', '分析目标: client | server', 'client')
    .action(async (options) => {
      try {
        const config = await loadConfig(process.cwd());

        cliLogger.info(`正在分析 ${options.target} Bundle...`);

        await withSpinner('正在构建并分析...', async () => {
          const { createClientConfig, createServerConfig } = await import('@nami/webpack');
          const webpack = (await import('webpack')).default;
          const { BundleAnalyzerPlugin } = await import('webpack-bundle-analyzer');

          // 创建配置
          const webpackConfig =
            options.target === 'server'
              ? createServerConfig({ config, projectRoot: process.cwd() })
              : createClientConfig({ config, projectRoot: process.cwd() });

          // 添加分析插件
          webpackConfig.plugins = [
            ...(webpackConfig.plugins || []),
            new BundleAnalyzerPlugin({
              analyzerMode: 'static',
              reportFilename: `${options.target}-bundle-report.html`,
              openAnalyzer: true,
              logLevel: 'silent',
            }),
          ];

          // 执行构建
          return new Promise<void>((resolve, reject) => {
            webpack(webpackConfig, (err, stats) => {
              if (err) reject(err);
              else resolve();
            });
          });
        });

        cliLogger.success('分析报告已生成');
      } catch (error) {
        const err = error as Error;
        cliLogger.error(`分析失败: ${err.message}`);
        process.exit(1);
      }
    });
}
