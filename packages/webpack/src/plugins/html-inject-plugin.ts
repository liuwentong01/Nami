/**
 * @nami/webpack - HTML 模板注入插件
 *
 * 为 CSR 模式生成 index.html，注入必要的 <script> 和 <link> 标签。
 * SSR 模式不使用此插件（HTML 由服务端动态生成）。
 */

import type { Compiler, Compilation } from 'webpack';
import { DEFAULT_CONTAINER_ID } from '@nami/shared';
import { createCSRRootContainer, resolveStaticEmergencyHTML } from '@nami/core';

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
  /** 是否生成 CSR index.html；无 CSR 路由时关闭，但仍生成 emergency.html */
  emitIndex?: boolean;
  /** CSR index.html 根容器中的自定义 loading 骨架片段 */
  skeletonHTML?: string;
  /** Node 服务不可达时供反代/CDN 使用的静态应急 HTML */
  staticEmergencyHTML?: string;
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
      emitIndex: options.emitIndex ?? true,
      skeletonHTML: options.skeletonHTML || '',
      staticEmergencyHTML: options.staticEmergencyHTML || '',
    };
  }

  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap('NamiHtmlInjectPlugin', (compilation: Compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'NamiHtmlInjectPlugin',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          const rawPublicPath = compilation.outputOptions.publicPath;
          const publicPath = typeof rawPublicPath === 'string' ? rawPublicPath : '/';

          // 收集入口文件
          const jsFiles: string[] = [];
          const cssFiles: string[] = [];

          for (const [, entrypoint] of compilation.entrypoints) {
            for (const file of entrypoint.getFiles()) {
              if (file.endsWith('.js')) {
                jsFiles.push(this.joinPublicPath(publicPath, file));
              } else if (file.endsWith('.css')) {
                cssFiles.push(this.joinPublicPath(publicPath, file));
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

          if (this.options.emitIndex) {
            // 自定义 template 只影响 CSR index，不会覆盖独立静态应急页。
            const html = this.options.template || this.generateDefaultHTML(cssLinks, jsScripts);

            compilation.assets['index.html'] = {
              source: () => html,
              size: () => Buffer.byteLength(html),
            } as any;
          }

          // emergency.html 不包含业务 JS，供反代/CDN 在 Node 服务完全不可达时使用。
          const emergencyHTML = resolveStaticEmergencyHTML(
            this.options.staticEmergencyHTML,
            `${this.options.title} - 服务暂时不可用`,
          );
          compilation.assets['emergency.html'] = {
            source: () => emergencyHTML,
            size: () => Buffer.byteLength(emergencyHTML),
          } as any;
        },
      );
    });
  }

  /**
   * 生成默认 HTML 模板
   */
  private generateDefaultHTML(cssLinks: string, jsScripts: string): string {
    const safeTitle = this.escapeHTMLText(this.options.title);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <meta name="renderer" content="csr">
    <title>${safeTitle}</title>
${cssLinks}
${this.options.headTags}
</head>
<body>
${this.options.bodyTags}
${this.indentHTML(createCSRRootContainer(this.options.skeletonHTML, this.options.containerId), 4)}
${jsScripts}
</body>
</html>`;
  }

  private indentHTML(html: string, spaces: number): string {
    const indentation = ' '.repeat(spaces);
    return html
      .split('\n')
      .map((line) => `${indentation}${line}`)
      .join('\n');
  }

  private joinPublicPath(publicPath: string, file: string): string {
    if (publicPath === 'auto') return file;
    if (/^(?:https?:)?\/\//i.test(publicPath)) {
      return `${publicPath.replace(/\/$/, '')}/${file.replace(/^\//, '')}`;
    }

    const normalizedPath = publicPath === '' ? '/' : publicPath;
    return `${normalizedPath.replace(/\/$/, '')}/${file.replace(/^\//, '')}`;
  }

  private escapeHTMLText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
