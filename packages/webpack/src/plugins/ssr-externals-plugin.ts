/**
 * @nami/webpack - SSR 外部依赖处理插件
 *
 * 服务端构建时，大多数 node_modules 应该作为外部依赖（externals），
 * 运行时直接 require 而非打包到 Bundle 中。
 *
 * 但某些模块需要被 Webpack 处理：
 * - 包含 CSS 导入的模块
 * - ESM 模块（Node.js 的 require 无法直接加载）
 * - 框架内部包（@nami/*）
 *
 * 此插件提供更精细的外部化控制。
 */

import type { Compiler } from 'webpack';

/**
 * SSR Externals 插件选项
 */
export interface SSRExternalsPluginOptions {
  /**
   * 始终打包的模块列表（正则匹配）
   * 默认包含 @nami/* 和 CSS 文件
   */
  allowlist?: RegExp[];

  /**
   * 始终外部化的模块列表
   * 通常是 Node.js 原生模块
   */
  forcedExternals?: string[];
}

/**
 * Nami SSR 外部化 Webpack 插件
 */
export class NamiSSRExternalsPlugin {
  private allowlist: RegExp[];
  private forcedExternals: Set<string>;

  constructor(options: SSRExternalsPluginOptions = {}) {
    this.allowlist = options.allowlist || [/^@nami\//, /\.css$/, /\.less$/, /\.scss$/];
    this.forcedExternals = new Set(options.forcedExternals || []);
  }

  apply(compiler: Compiler): void {
    compiler.hooks.normalModuleFactory.tap('NamiSSRExternalsPlugin', (nmf) => {
      nmf.hooks.beforeResolve.tap('NamiSSRExternalsPlugin', (resolveData) => {
        if (!resolveData) return;

        const request = resolveData.request;

        // 相对路径导入：始终打包
        if (request.startsWith('.') || request.startsWith('/')) return;

        // 检查白名单
        if (this.allowlist.some((re) => re.test(request))) return;

        // 强制外部化
        if (this.forcedExternals.has(request)) {
          resolveData.request = request;
        }
      });
    });
  }
}
