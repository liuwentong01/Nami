/**
 * @nami/webpack - CSS/SCSS/CSS Modules 规则
 *
 * 配置 Webpack 处理样式文件的规则，支持：
 * - 普通 CSS 文件
 * - CSS Modules（以 .module.css 为后缀的文件）
 * - SCSS/SASS 预处理器
 * - 生产环境 CSS 提取为独立文件
 * - 开发环境使用 style-loader 实现 HMR
 */

import type { RuleSetRule } from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

/**
 * 样式规则配置选项
 */
export interface StyleRuleOptions {
  /** 是否为开发模式（影响 CSS 提取策略） */
  isDev?: boolean;
  /** 是否为服务端构建（服务端跳过样式加载） */
  isServer?: boolean;
  /** CSS Modules 的本地标识名格式 */
  localIdentName?: string;
}

/**
 * 创建 CSS Loader 基础配置
 */
function getCssLoaderOptions(isModules: boolean, localIdentName: string) {
  return {
    loader: 'css-loader',
    options: {
      // CSS Modules 配置
      modules: isModules
        ? {
            localIdentName,
            exportLocalsConvention: 'camelCase' as const,
          }
        : false,
      // 在 css-loader 之前需要执行的 loader 数量
      importLoaders: 1,
    },
  };
}

/**
 * 创建样式规则列表
 *
 * @param options - 样式规则配置选项
 * @returns Webpack RuleSetRule 数组
 */
export function createStyleRules(options: StyleRuleOptions = {}): RuleSetRule[] {
  const {
    isDev = false,
    isServer = false,
    localIdentName = isDev ? '[name]__[local]--[hash:base64:5]' : '[hash:base64:8]',
  } = options;

  // 服务端构建：忽略所有样式文件（返回空模块）
  if (isServer) {
    return [
      {
        test: /\.css$/,
        use: 'null-loader',
      },
    ];
  }

  // 样式加载器：开发模式用 style-loader（HMR），生产模式提取为文件
  const styleLoader = isDev ? 'style-loader' : MiniCssExtractPlugin.loader;

  return [
    // 普通 CSS 文件（排除 .module.css）
    {
      test: /\.css$/,
      exclude: /\.module\.css$/,
      use: [styleLoader, getCssLoaderOptions(false, localIdentName), 'postcss-loader'],
    },
    // CSS Modules 文件
    {
      test: /\.module\.css$/,
      use: [styleLoader, getCssLoaderOptions(true, localIdentName), 'postcss-loader'],
    },
  ];
}

/**
 * 创建 MiniCssExtractPlugin 实例（仅生产环境需要）
 */
export function createCssExtractPlugin(): MiniCssExtractPlugin {
  return new MiniCssExtractPlugin({
    filename: 'static/css/[name].[contenthash:8].css',
    chunkFilename: 'static/css/[name].[contenthash:8].chunk.css',
  });
}
