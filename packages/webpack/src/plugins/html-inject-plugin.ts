/**
 * @nami/webpack - HTML 模板注入插件
 *
 * 为 CSR 模式生成 index.html，注入必要的 <script> 和 <link> 标签。
 * SSR 模式不使用此插件（HTML 由服务端动态生成）。
 */

import type { Compiler, Compilation } from 'webpack';
import { DEFAULT_CONTAINER_ID } from '@nami/shared';

/**
 * HTML 注入插件选项
 */
export interface HtmlInjectPluginOptions {
  /** HTML 标题 */
  title?: string;
  /** 挂载容器 ID */
  containerId?: string;
  /** 自定义 HTML 模板 */
  template?: string;
  /** 额外的 <head> 内容 */
  headTags?: string;
  /** 额外的 <body> 内容（在根容器之前） */
  bodyTags?: string;
}

/**
 * Nami HTML 注入 Webpack 插件
 */
export class NamiHtmlInjectPlugin {
  private options: Required<HtmlInjectPluginOptions>;

  constructor(options: HtmlInjectPluginOptions = {}) {
    this.options = {
      title: options.title || 'Nami App',
      containerId: options.containerId || DEFAULT_CONTAINER_ID,
      template: options.template || '',
      headTags: options.headTags || '',
      bodyTags: options.bodyTags || '',
    };
  }

  apply(compiler: Compiler): void {
    compiler.hooks.emit.tapAsync('NamiHtmlInjectPlugin', (compilation: Compilation, callback) => {
      const publicPath = compilation.outputOptions.publicPath || '/';

      // 收集入口文件
      const jsFiles: string[] = [];
      const cssFiles: string[] = [];

      for (const [, entrypoint] of compilation.entrypoints) {
        for (const file of entrypoint.getFiles()) {
          if (file.endsWith('.js')) {
            jsFiles.push(`${publicPath}${file}`.replace(/\/\//g, '/'));
          } else if (file.endsWith('.css')) {
            cssFiles.push(`${publicPath}${file}`.replace(/\/\//g, '/'));
          }
        }
      }

      // 生成 CSS link 标签
      const cssLinks = cssFiles
        .map((file) => `    <link rel="stylesheet" href="${file}">`)
        .join('\n');

      // 生成 JS script 标签
      const jsScripts = jsFiles
        .map((file) => `    <script defer src="${file}"></script>`)
        .join('\n');

      // 生成完整 HTML
      const html = this.options.template || this.generateDefaultHTML(cssLinks, jsScripts);

      // 写入 index.html
      compilation.assets['index.html'] = {
        source: () => html,
        size: () => Buffer.byteLength(html),
      } as any;

      callback();
    });
  }

  /**
   * 生成默认 HTML 模板
   */
  private generateDefaultHTML(cssLinks: string, jsScripts: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>${this.options.title}</title>
${cssLinks}
${this.options.headTags}
</head>
<body>
${this.options.bodyTags}
    <div id="${this.options.containerId}"></div>
${jsScripts}
</body>
</html>`;
  }
}
