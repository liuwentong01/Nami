/**
 * @nami/webpack - SVG 处理规则
 *
 * SVG 文件支持两种使用方式：
 * 1. 作为 React 组件导入（默认）：import { ReactComponent as Logo } from './logo.svg'
 * 2. 作为 URL 导入：import logoUrl from './logo.svg?url'
 */

import type { RuleSetRule } from 'webpack';

/**
 * 创建 SVG 处理规则
 *
 * @returns Webpack RuleSetRule 数组
 */
export function createSvgRules(): RuleSetRule[] {
  return [
    // SVG 作为 URL 资源（带 ?url 后缀）
    {
      test: /\.svg$/i,
      type: 'asset/resource',
      resourceQuery: /url/,
      generator: {
        filename: 'static/media/[name].[contenthash:8][ext]',
      },
    },
    // SVG 作为内联源码（默认，可被 @svgr/webpack 转为 React 组件）
    {
      test: /\.svg$/i,
      resourceQuery: { not: [/url/] },
      use: [
        {
          loader: '@svgr/webpack',
          options: {
            // 生成的组件自带 props 类型
            typescript: true,
            // 移除 SVG 中的宽高属性，由 CSS 控制
            dimensions: false,
            // SVG 优化
            svgo: true,
            svgoConfig: {
              plugins: [
                {
                  name: 'removeViewBox',
                  active: false,
                },
              ],
            },
          },
        },
      ],
    },
  ];
}
