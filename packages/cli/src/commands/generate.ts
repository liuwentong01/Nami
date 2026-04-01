/**
 * @nami/cli - generate 命令
 *
 * 触发 SSG 静态页面生成：
 * 1. 加载配置
 * 2. 筛选 SSG/ISR 路由
 * 3. 执行静态生成
 */

import type { Command } from 'commander';
import { loadConfig } from '../config/load-config';
import { cliLogger } from '../utils/logger';
import { withSpinner } from '../utils/spinner';
import { RenderMode } from '@nami/shared';

/**
 * 注册 generate 命令
 */
export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .alias('g')
    .description('生成静态页面（SSG/ISR 路由）')
    .option('--route <path>', '仅生成指定路由')
    .action(async (options) => {
      try {
        const config = await loadConfig(process.cwd());

        // 筛选需要静态生成的路由
        let routes = config.routes.filter(
          (r) => r.renderMode === RenderMode.SSG || r.renderMode === RenderMode.ISR,
        );

        // 如果指定了路由，仅生成该路由
        if (options.route) {
          routes = routes.filter((r) => r.path === options.route);
          if (routes.length === 0) {
            cliLogger.error(`未找到路由: ${options.route}`);
            process.exit(1);
          }
        }

        if (routes.length === 0) {
          cliLogger.warn('没有需要静态生成的路由（未配置 SSG/ISR 路由）');
          return;
        }

        cliLogger.info(`发现 ${routes.length} 个需要静态生成的路由`);

        await withSpinner('正在生成静态页面...', async () => {
          const { NamiBuilder } = await import('@nami/webpack');
          const builder = new NamiBuilder(config, process.cwd());
          await builder.build('production', {
            clean: false,
            ssgRoutes: routes.map((route) => route.path),
          });
        });

        cliLogger.success('静态页面生成完成');
      } catch (error) {
        const err = error as Error;
        cliLogger.error(`静态生成失败: ${err.message}`);
        process.exit(1);
      }
    });
}
