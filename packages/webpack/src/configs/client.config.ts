/**
 * @nami/webpack - 客户端构建配置
 *
 * 生成浏览器端运行的 JavaScript Bundle，包含：
 * - React 应用代码
 * - 路由懒加载 Chunk
 * - CSS 提取
 * - 代码分割（vendor/runtime/pages）
 * - 资源指纹（Content Hash）
 */

import type { Configuration } from 'webpack';
import type { NamiConfig } from '@nami/shared';
import path from 'path';
import webpack from 'webpack';
import { createBaseConfig } from './base.config';
import { createStyleRules, createCssExtractPlugin } from '../rules/styles';
import { createSplitChunksConfig } from '../optimization/split-chunks';
import { createTerserPlugin } from '../optimization/terser';

/**
 * 客户端构建配置选项
 */
export interface ClientConfigOptions {
  /** Nami 框架配置 */
  config: NamiConfig;
  /** 项目根目录 */
  projectRoot: string;
  /** 是否为开发模式 */
  isDev?: boolean;
}

/**
 * 创建客户端 Webpack 配置
 *
 * 客户端 Bundle 的产物结构：
 * ```
 * dist/client/
 * ├── static/
 * │   ├── js/
 * │   │   ├── main.[hash].js        # 应用入口
 * │   │   ├── vendor.[hash].js      # 第三方库
 * │   │   ├── runtime.[hash].js     # Webpack 运行时
 * │   │   └── pages/
 * │   │       └── [page].[hash].js  # 页面级 Chunk
 * │   └── css/
 * │       └── [name].[hash].css     # 提取的 CSS
 * └── asset-manifest.json           # 资源清单
 * ```
 *
 * @param options - 客户端构建选项
 * @returns Webpack Configuration
 */
export function createClientConfig(options: ClientConfigOptions): Configuration {
  const { config, projectRoot, isDev = false } = options;

  // 获取基础配置
  const baseConfig = createBaseConfig({
    config,
    projectRoot,
    isServer: false,
    isDev,
  });

  const outputDir = path.resolve(projectRoot, config.outDir, 'client');

  // 客户端专属插件
  const plugins: webpack.WebpackPluginInstance[] = [
    // 定义环境变量
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
      'process.env.NAMI_RENDER_MODE': JSON.stringify('client'),
      // 注入用户自定义环境变量（仅 NAMI_PUBLIC_ 前缀）
      ...Object.entries(config.env || {}).reduce(
        (acc, [key, value]) => {
          if (key.startsWith('NAMI_PUBLIC_')) {
            acc[`process.env.${key}`] = JSON.stringify(value);
          }
          return acc;
        },
        {} as Record<string, string>,
      ),
    }),
  ];

  // 生产环境：提取 CSS 到独立文件
  if (!isDev) {
    plugins.push(createCssExtractPlugin());
  }

  // 开发环境：HMR 插件
  if (isDev) {
    plugins.push(new webpack.HotModuleReplacementPlugin());
  }

  return {
    ...baseConfig,
    name: 'client',
    target: 'web',

    // 入口
    entry: {
      main: isDev
        ? [
            // HMR 客户端入口
            'webpack-hot-middleware/client?reload=true&noInfo=true',
            path.resolve(projectRoot, config.srcDir, 'entry-client'),
          ]
        : [path.resolve(projectRoot, config.srcDir, 'entry-client')],
    },

    // 输出
    output: {
      path: outputDir,
      // 开发模式不使用 hash 以加速构建
      filename: isDev ? 'static/js/[name].js' : 'static/js/[name].[contenthash:8].js',
      chunkFilename: isDev
        ? 'static/js/[name].chunk.js'
        : 'static/js/[name].[contenthash:8].chunk.js',
      publicPath: config.assets.publicPath,
      // 清理旧构建产物
      clean: !isDev,
    },

    // 模块规则：追加样式规则
    module: {
      ...baseConfig.module,
      rules: [...(baseConfig.module?.rules || []), ...createStyleRules({ isDev, isServer: false })],
    },

    // 优化
    optimization: isDev
      ? {
          // 开发模式：最小化优化以加速构建
          minimize: false,
          splitChunks: false,
        }
      : {
          minimize: true,
          minimizer: [createTerserPlugin()],
          // 代码分割策略
          splitChunks: createSplitChunksConfig(),
          // 提取 Webpack 运行时为独立 Chunk
          runtimeChunk: {
            name: 'runtime',
          },
          // 模块 ID 使用确定性哈希（利于长期缓存）
          moduleIds: 'deterministic',
        },

    // Source Map
    devtool: isDev ? 'eval-cheap-module-source-map' : 'source-map',

    plugins: [...(baseConfig.plugins || []), ...plugins],
  };
}
