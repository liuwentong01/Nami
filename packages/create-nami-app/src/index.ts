/**
 * create-nami-app - 脚手架主模块
 *
 * 通过交互式问答收集用户偏好，
 * 然后基于模板生成完整的项目结构。
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { promptUserOptions } from './prompts';
import { generateProject } from './generator';
import type { ProjectOptions } from './prompts';

/**
 * 创建 Nami 应用
 */
export async function createApp(): Promise<void> {
  const program = new Command();

  program
    .name('create-nami-app')
    .description('创建 Nami 框架项目')
    .version('0.1.0')
    .argument('[project-name]', '项目名称')
    .option('-t, --template <template>', '项目模板 (csr|ssr|ssg|full)', '')
    .option('--skip-install', '跳过依赖安装')
    .option('--use-npm', '使用 npm 安装依赖')
    .action(async (projectName?: string, options?: Record<string, unknown>) => {
      console.log();
      console.log(chalk.bold.cyan('  Nami Framework'));
      console.log(chalk.gray('  集团级前端框架 - CSR/SSR/SSG/ISR 多渲染模式'));
      console.log();

      // 交互式问答
      const userOptions = await promptUserOptions(projectName, options?.template as string);

      // 生成项目
      await generateProject(userOptions, {
        skipInstall: options?.skipInstall as boolean,
        packageManager: options?.useNpm ? 'npm' : 'pnpm',
      });

      // 完成提示
      console.log();
      console.log(chalk.green('  项目创建成功！'));
      console.log();
      console.log('  下一步:');
      console.log(chalk.cyan(`    cd ${userOptions.projectName}`));
      if (options?.skipInstall) {
        console.log(chalk.cyan('    pnpm install'));
      }
      console.log(chalk.cyan('    pnpm dev'));
      console.log();
    });

  program.parse(process.argv);
}
