/**
 * @nami/webpack - 静态资源处理规则
 *
 * 配置 Webpack 处理图片、字体等静态资源文件。
 * 使用 Webpack 5 内置的 Asset Modules（取代旧版 file-loader/url-loader）。
 */

import type { RuleSetRule } from 'webpack';

/**
 * 静态资源规则配置选项
 */
export interface AssetRuleOptions {
  /** 小于此大小（字节）的资源内联为 Base64，默认 8KB */
  inlineLimit?: number;
  /** 资源输出目录前缀 */
  outputPath?: string;
}

/**
 * 创建静态资源处理规则
 *
 * @param options - 资源规则配置选项
 * @returns Webpack RuleSetRule 数组
 */
export function createAssetRules(options: AssetRuleOptions = {}): RuleSetRule[] {
  const { inlineLimit = 8 * 1024, outputPath = 'static/media' } = options;

  return [
    // 图片文件
    {
      test: /\.(png|jpe?g|gif|webp|avif)$/i,
      type: 'asset',
      parser: {
        dataUrlCondition: {
          maxSize: inlineLimit,
        },
      },
      generator: {
        filename: `${outputPath}/[name].[contenthash:8][ext]`,
      },
    },
    // 字体文件
    {
      test: /\.(woff|woff2|eot|ttf|otf)$/i,
      type: 'asset/resource',
      generator: {
        filename: `${outputPath}/[name].[contenthash:8][ext]`,
      },
    },
    // 音视频文件
    {
      test: /\.(mp4|webm|ogg|mp3|wav|flac|aac)$/i,
      type: 'asset/resource',
      generator: {
        filename: `${outputPath}/[name].[contenthash:8][ext]`,
      },
    },
  ];
}
