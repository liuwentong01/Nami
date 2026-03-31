/**
 * @nami/webpack - 基础 Webpack 配置
 *
 * 所有构建模式（Client/Server/SSG/Dev）共享的基础配置。
 * 包含：TypeScript 编译、静态资源处理、模块解析等通用规则。
 */

import type { Configuration, RuleSetRule } from 'webpack';
import type { NamiConfig } from '@nami/shared';
import path from 'path';
import { createTypeScriptRule } from '../rules/typescript';
import { createAssetRules } from '../rules/assets';
import { createSvgRules } from '../rules/svg';

/**
 * 基础配置选项
 */
export interface BaseConfigOptions {
  /** Nami 框架配置 */
  config: NamiConfig;
  /** 项目根目录 */
  projectRoot: string;
  /** 是否为服务端构建 */
  isServer?: boolean;
  /** 是否为开发模式 */
  isDev?: boolean;
}

/**
 * 创建基础 Webpack 配置
 *
 * 此配置被所有构建模式继承，包含：
 * - 模块解析配置（.ts, .tsx, .js, .jsx, .json 扩展名）
 * - TypeScript 编译规则
 * - 静态资源处理规则
 * - 基础 resolve 别名
 *
 * @param options - 基础配置选项
 * @returns Webpack Configuration
 */
export function createBaseConfig(options: BaseConfigOptions): Configuration {
  const { config, projectRoot, isServer = false, isDev = false } = options;

  const srcDir = path.resolve(projectRoot, config.srcDir);

  // 收集模块规则
  const rules: RuleSetRule[] = [
    // TypeScript 编译
    createTypeScriptRule({
      transpileOnly: true,
      isServer,
    }),
    // 静态资源
    ...createAssetRules(),
    // SVG
    ...createSvgRules(),
  ];

  return {
    // 构建模式
    mode: isDev ? 'development' : 'production',

    // 模块解析
    resolve: {
      // 支持的文件扩展名（按使用频率排序以优化解析速度）
      extensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
      // 路径别名
      alias: {
        '@': srcDir,
        '~': srcDir,
      },
      // 模块查找目录
      modules: ['node_modules', path.resolve(projectRoot, 'node_modules')],
    },

    // 模块规则
    module: {
      rules,
      // 跳过对大型库的解析以提升构建速度
      noParse: /jquery|lodash/,
    },

    // 基础性能提示
    performance: {
      // 开发模式关闭性能提示
      hints: isDev ? false : 'warning',
      // 资源大小警告阈值 250KB
      maxAssetSize: 256 * 1024,
      // 入口点大小警告阈值 500KB
      maxEntrypointSize: 512 * 1024,
    },

    // 统计信息输出
    stats: isDev ? 'minimal' : 'normal',

    // 基础设施日志级别
    infrastructureLogging: {
      level: isDev ? 'warn' : 'info',
    },

    // 缓存配置（加速二次构建）
    cache: isDev
      ? {
          type: 'filesystem' as const,
          cacheDirectory: path.resolve(projectRoot, 'node_modules/.cache/webpack'),
          buildDependencies: {
            config: [__filename],
          },
        }
      : false,
  };
}
