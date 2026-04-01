/**
 * @nami/webpack - 基础 Webpack 配置
 *
 * 所有构建模式（Client/Server/SSG/Dev）共享的基础配置。
 * 包含：TypeScript 编译、静态资源处理、模块解析等通用规则。
 */

import type { Configuration, RuleSetRule } from 'webpack';
import type { NamiConfig } from '@nami/shared';
import path from 'path';
import crypto from 'crypto';
import { createTypeScriptRule } from '../rules/typescript';
import { createAssetRules } from '../rules/assets';
import { createSvgRules } from '../rules/svg';

/**
 * 根据 NamiConfig 生成内容哈希
 *
 * 用于生产模式的缓存版本标识。当配置变更时，哈希值变化，
 * Webpack 会自动丢弃旧的缓存文件，确保构建结果的正确性。
 *
 * @param config - Nami 框架配置
 * @returns 8 位十六进制哈希字符串
 */
function createContentHash(config: NamiConfig): string {
  const content = JSON.stringify({
    appName: config.appName,
    srcDir: config.srcDir,
    outputDir: config.outputDir,
    publicPath: config.publicPath,
    defaultRenderMode: config.defaultRenderMode,
    routes: config.routes?.map((r) => r.path),
  });
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
}

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

    /**
     * 缓存配置 — 加速二次构建
     *
     * 开发和生产模式均启用 Webpack 5 文件系统缓存（持久化到磁盘），
     * 二次构建速度可提升 60-80%。
     *
     * dev/prod 使用独立的缓存目录，避免模式切换导致缓存失效。
     *
     * 生产模式额外配置：
     * - version: 基于配置内容哈希的缓存版本标识，配置变更时自动失效旧缓存
     * - compression: gzip 压缩缓存文件，减少磁盘占用（生产缓存通常较大）
     */
    cache: {
      type: 'filesystem' as const,
      cacheDirectory: path.resolve(
        projectRoot,
        'node_modules/.cache/webpack',
        isDev ? 'dev' : 'prod',
      ),
      buildDependencies: {
        // 当本配置文件自身变更时，自动失效缓存
        config: [__filename],
      },
      // 开发模式用固定版本标识；生产模式用配置内容哈希，配置变更时自动失效
      version: isDev ? 'dev' : createContentHash(config),
      ...(isDev ? {} : {
        compression: 'gzip' as const,
      }),
    },
  };
}
