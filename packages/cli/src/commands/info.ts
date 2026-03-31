/**
 * @nami/cli - info 命令
 *
 * 输出当前项目和环境的诊断信息，
 * 用于问题排查和 Bug 报告。
 */

import type { Command } from 'commander';
import { cliLogger } from '../utils/logger';
import chalk from 'chalk';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * 注册 info 命令
 */
export function registerInfoCommand(program: Command): void {
  program
    .command('info')
    .description('输出环境和项目信息')
    .action(async () => {
      cliLogger.newline();
      cliLogger.info('Nami 框架环境信息');
      cliLogger.divider();

      // 系统信息
      printSection('系统', [
        ['OS', `${os.type()} ${os.release()} (${os.arch()})`],
        ['CPU', `${os.cpus()[0]?.model || 'unknown'} × ${os.cpus().length}`],
        ['Memory', `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`],
        ['Node.js', process.version],
        ['npm', getCommandVersion('npm')],
        ['pnpm', getCommandVersion('pnpm')],
      ]);

      // Nami 包版本
      const namiPackages = [
        '@nami/cli',
        '@nami/core',
        '@nami/shared',
        '@nami/server',
        '@nami/client',
        '@nami/webpack',
      ];

      const packageVersions: Array<[string, string]> = [];
      for (const pkg of namiPackages) {
        const version = getPackageVersion(pkg);
        if (version) {
          packageVersions.push([pkg, version]);
        }
      }

      if (packageVersions.length > 0) {
        printSection('Nami 包', packageVersions);
      }

      // 关键依赖版本
      const deps: Array<[string, string]> = [];
      for (const pkg of ['react', 'react-dom', 'webpack', 'koa', 'typescript']) {
        const version = getPackageVersion(pkg);
        if (version) {
          deps.push([pkg, version]);
        }
      }

      if (deps.length > 0) {
        printSection('关键依赖', deps);
      }

      // 项目配置
      const configPath = ['nami.config.ts', 'nami.config.js']
        .map((f) => path.resolve(process.cwd(), f))
        .find((f) => fs.existsSync(f));

      printSection('项目', [
        ['工作目录', process.cwd()],
        ['配置文件', configPath ? path.basename(configPath) : chalk.yellow('未找到')],
      ]);

      cliLogger.divider();
      cliLogger.newline();
    });
}

/**
 * 打印信息段落
 */
function printSection(title: string, items: Array<[string, string]>): void {
  cliLogger.newline();
  cliLogger.indent(chalk.bold(title));
  for (const [key, value] of items) {
    cliLogger.indent(`  ${chalk.gray(key.padEnd(16))} ${value}`, 1);
  }
}

/**
 * 获取 npm 包版本
 */
function getPackageVersion(packageName: string): string | null {
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`, {
      paths: [process.cwd()],
    });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return null;
  }
}

/**
 * 获取命令行工具版本
 */
function getCommandVersion(command: string): string {
  try {
    const { execSync } = require('child_process');
    return execSync(`${command} --version`, { encoding: 'utf-8' }).trim();
  } catch {
    return chalk.gray('未安装');
  }
}
