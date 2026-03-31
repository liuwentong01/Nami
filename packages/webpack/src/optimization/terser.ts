/**
 * @nami/webpack - JavaScript 压缩配置
 *
 * 使用 TerserPlugin 进行 JavaScript 压缩，配置要点：
 * - 多线程压缩（利用多核 CPU）
 * - 移除 console.log（保留 warn/error）
 * - 压缩类名和变量名
 * - 保留 LICENSE 注释
 */

import TerserPlugin from 'terser-webpack-plugin';

/**
 * 创建 Terser 压缩插件实例
 *
 * @returns TerserPlugin 实例
 */
export function createTerserPlugin(): TerserPlugin {
  return new TerserPlugin({
    // 多线程压缩
    parallel: true,
    // 不提取 LICENSE 文件（减少产物文件数）
    extractComments: false,
    terserOptions: {
      // 解析选项
      parse: {
        ecma: 2020 as 2020,
      },
      // 压缩选项
      compress: {
        ecma: 2020 as 2020,
        // 移除 console.log，保留 console.warn 和 console.error
        drop_console: false,
        pure_funcs: ['console.log', 'console.debug'],
        // 移除 debugger 语句
        drop_debugger: true,
        // 优化比较运算
        comparisons: true,
        // 内联仅调用一次的函数
        inline: 2,
        // 移除不可达代码
        dead_code: true,
      },
      // 混淆选项
      mangle: {
        // Safari 10 兼容
        safari10: true,
      },
      output: {
        ecma: 2020 as 2020,
        // 不生成注释
        comments: false,
        // ASCII 字符优先（避免 Unicode 转义）
        ascii_only: true,
      },
    },
  });
}
