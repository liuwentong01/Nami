/**
 * @nami/webpack - 代码分割策略
 *
 * 精心设计的代码分割方案，目标：
 * 1. 最大化长期缓存利用率（框架/库代码变化频率低）
 * 2. 避免单个 Chunk 过大影响首屏加载
 * 3. 避免 Chunk 过多导致请求数爆炸
 *
 * 分割策略：
 * - vendor:  React/ReactDOM 等核心框架（极少变化）
 * - commons: 被多个页面共享的公共模块
 * - pages/*: 每个页面的独立 Chunk（路由懒加载）
 */

import type { Configuration } from 'webpack';

type SplitChunksOptions = NonNullable<
  NonNullable<Configuration['optimization']>['splitChunks']
>;

/**
 * 创建代码分割配置
 *
 * @returns SplitChunks 配置对象
 */
export function createSplitChunksConfig(): SplitChunksOptions {
  return {
    chunks: 'all',

    // 最小 Chunk 大小 20KB（太小的 Chunk 不值得独立请求）
    minSize: 20 * 1024,

    // 最大 Chunk 大小 250KB（超过此值尝试进一步拆分）
    maxSize: 250 * 1024,

    // 模块被至少 2 个 Chunk 引用时才提取为公共模块
    minChunks: 2,

    // 异步请求的最大并行数
    maxAsyncRequests: 20,

    // 入口点的最大并行请求数
    maxInitialRequests: 10,

    cacheGroups: {
      // React 核心库（变化频率极低，独立缓存）
      react: {
        name: 'vendor-react',
        test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
        priority: 30,
        chunks: 'all',
        enforce: true,
      },

      // 其他第三方库
      vendor: {
        name: 'vendor',
        test: /[\\/]node_modules[\\/]/,
        priority: 20,
        chunks: 'all',
        // 只有足够大的模块才单独打包
        minSize: 30 * 1024,
      },

      // 多页面共享的公共模块
      commons: {
        name: 'commons',
        minChunks: 2,
        priority: 10,
        chunks: 'all',
        reuseExistingChunk: true,
      },

      // 默认分组（其他未匹配的模块）
      default: {
        minChunks: 2,
        priority: -10,
        reuseExistingChunk: true,
      },
    },
  };
}
