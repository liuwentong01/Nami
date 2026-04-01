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
    /**
     * 通过 externals 配置实现 SSR 外部化
     *
     * Webpack 的 normalModuleFactory.hooks.beforeResolve 无法直接标记模块为 external，
     * 因此改用 compiler.options.externals 函数方式，这是 Webpack 5 推荐的外部化模式。
     *
     * 判断逻辑：
     * 1. 相对路径（./ ../）和绝对路径（/）→ 始终打包（项目自身代码）
     * 2. 匹配白名单（@nami/*、CSS 文件等）→ 始终打包
     * 3. 其余 node_modules 包 → 标记为 commonjs external，运行时 require
     */
    const existingExternals = compiler.options.externals;
    const allowlist = this.allowlist;
    const forcedExternals = this.forcedExternals;

    const externalsFunction = (
      { request }: { request?: string },
      callback: (err?: Error | null, result?: string) => void,
    ): void => {
      if (!request) {
        callback();
        return;
      }

      // 相对路径或绝对路径：始终打包（项目自身代码）
      if (request.startsWith('.') || request.startsWith('/')) {
        callback();
        return;
      }

      // 白名单匹配：始终打包（框架包、CSS 等需要 Webpack 处理的模块）
      if (allowlist.some((re) => re.test(request))) {
        callback();
        return;
      }

      // 强制外部化列表或非白名单的 node_modules 包 → 标记为 commonjs external
      callback(null, `commonjs ${request}`);
    };

    // 保留已有的 externals 配置，追加 SSR 外部化函数
    if (existingExternals) {
      compiler.options.externals = [
        ...(Array.isArray(existingExternals) ? existingExternals : [existingExternals]),
        externalsFunction as any,
      ];
    } else {
      compiler.options.externals = [externalsFunction as any];
    }
  }
}
