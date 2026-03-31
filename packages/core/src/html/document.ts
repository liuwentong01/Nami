/**
 * @nami/core - HTML 文档模板
 *
 * DocumentTemplate 负责生成完整的 HTML 文档。
 * 在 SSR 渲染流程中，React 渲染产出的仅是 body 内容，
 * 还需要此模板将其包装为完整的 HTML 文档，包括：
 * - DOCTYPE 声明
 * - <head> 标签（charset、viewport、title、meta、styles）
 * - <body> 标签（渲染内容、初始数据、JS 脚本）
 *
 * 设计原则：
 * - 输出标准的 HTML5 文档
 * - 默认包含必要的 meta 标签（charset、viewport）
 * - 支持自定义 meta、link、script 标签
 * - 自动注入初始数据（window.__NAMI_DATA__）
 */

import { DEFAULT_CONTAINER_ID, createLogger } from '@nami/shared';
import { DataSerializer } from '../data/serializer';

/** 文档模板日志 */
const logger = createLogger('@nami/core:document');

/**
 * 文档渲染选项
 */
export interface DocumentRenderOptions {
  /** 页面标题 */
  title?: string;

  /** meta 标签列表 */
  meta?: Array<{
    name?: string;
    property?: string;
    content: string;
    httpEquiv?: string;
    charset?: string;
  }>;

  /** body 内的 HTML 内容（React 渲染产出） */
  bodyContent?: string;

  /** 内联样式字符串列表 */
  styles?: string[];

  /** CSS 外链列表 */
  styleLinks?: Array<{
    href: string;
    media?: string;
  }>;

  /** JS 脚本列表 */
  scripts?: Array<{
    src: string;
    async?: boolean;
    defer?: boolean;
    type?: string;
  }>;

  /** 内联脚本内容列表 */
  inlineScripts?: string[];

  /** 服务端预取的初始数据 */
  initialData?: Record<string, unknown>;

  /** HTML 挂载容器 ID */
  containerId?: string;

  /** 页面语言 */
  lang?: string;

  /** 额外的 head 内容（原始 HTML 字符串） */
  headExtra?: string;

  /** 额外的 body 底部内容（原始 HTML 字符串） */
  bodyExtra?: string;
}

/**
 * HTML 文档模板类
 *
 * 负责将渲染结果组装为完整的 HTML 文档。
 *
 * @example
 * ```typescript
 * const template = new DocumentTemplate();
 *
 * const html = template.render({
 *   title: '我的页面',
 *   bodyContent: '<div>Hello World</div>',
 *   initialData: { user: { name: '张三' } },
 *   scripts: [
 *     { src: '/static/js/main.js', defer: true },
 *   ],
 *   styles: ['body { margin: 0; }'],
 * });
 * ```
 */
export class DocumentTemplate {
  /** 数据序列化器 */
  private readonly serializer: DataSerializer;

  constructor() {
    this.serializer = new DataSerializer();
  }

  /**
   * 渲染完整的 HTML 文档
   *
   * @param options - 文档渲染选项
   * @returns 完整的 HTML 文档字符串
   */
  render(options: DocumentRenderOptions): string {
    const {
      title = '',
      meta = [],
      bodyContent = '',
      styles = [],
      styleLinks = [],
      scripts = [],
      inlineScripts = [],
      initialData,
      containerId = DEFAULT_CONTAINER_ID,
      lang = 'zh-CN',
      headExtra = '',
      bodyExtra = '',
    } = options;

    logger.debug('开始渲染 HTML 文档', {
      title,
      hasInitialData: !!initialData,
      scriptCount: scripts.length,
      styleCount: styles.length + styleLinks.length,
    });

    // 构建各部分
    const headContent = this.buildHead(title, meta, styles, styleLinks, headExtra);
    const dataScript = initialData ? this.serializer.serialize(initialData) : '';
    const scriptTags = this.buildScripts(scripts, inlineScripts);

    // 组装完整 HTML
    const html = [
      '<!DOCTYPE html>',
      `<html lang="${this.escapeAttr(lang)}">`,
      '<head>',
      headContent,
      '</head>',
      '<body>',
      `  <div id="${this.escapeAttr(containerId)}">${bodyContent}</div>`,
      dataScript,
      scriptTags,
      bodyExtra,
      '</body>',
      '</html>',
    ].join('\n');

    return html;
  }

  /**
   * 构建 <head> 标签内容
   */
  private buildHead(
    title: string,
    meta: DocumentRenderOptions['meta'],
    styles: string[],
    styleLinks: NonNullable<DocumentRenderOptions['styleLinks']>,
    headExtra: string,
  ): string {
    const parts: string[] = [];

    // 必要的 meta 标签
    parts.push('  <meta charset="utf-8">');
    parts.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');

    // 用户自定义 meta 标签
    if (meta) {
      for (const tag of meta) {
        parts.push(`  ${this.renderMetaTag(tag)}`);
      }
    }

    // 页面标题
    if (title) {
      parts.push(`  <title>${this.escapeHTML(title)}</title>`);
    }

    // 外链 CSS
    for (const link of styleLinks) {
      const mediaAttr = link.media ? ` media="${this.escapeAttr(link.media)}"` : '';
      parts.push(`  <link rel="stylesheet" href="${this.escapeAttr(link.href)}"${mediaAttr}>`);
    }

    // 内联样式
    for (const style of styles) {
      parts.push(`  <style>${style}</style>`);
    }

    // 额外的 head 内容
    if (headExtra) {
      parts.push(`  ${headExtra}`);
    }

    return parts.join('\n');
  }

  /**
   * 渲染单个 meta 标签
   */
  private renderMetaTag(tag: NonNullable<DocumentRenderOptions['meta']>[number]): string {
    const attrs: string[] = [];

    if (tag.charset) {
      return `<meta charset="${this.escapeAttr(tag.charset)}">`;
    }
    if (tag.httpEquiv) {
      attrs.push(`http-equiv="${this.escapeAttr(tag.httpEquiv)}"`);
    }
    if (tag.name) {
      attrs.push(`name="${this.escapeAttr(tag.name)}"`);
    }
    if (tag.property) {
      attrs.push(`property="${this.escapeAttr(tag.property)}"`);
    }
    attrs.push(`content="${this.escapeAttr(tag.content)}"`);

    return `<meta ${attrs.join(' ')}>`;
  }

  /**
   * 构建 <script> 标签
   */
  private buildScripts(
    scripts: NonNullable<DocumentRenderOptions['scripts']>,
    inlineScripts: string[],
  ): string {
    const parts: string[] = [];

    // 内联脚本
    for (const content of inlineScripts) {
      parts.push(`  <script>${content}</script>`);
    }

    // 外链脚本
    for (const script of scripts) {
      const attrs: string[] = [];
      attrs.push(`src="${this.escapeAttr(script.src)}"`);
      if (script.async) attrs.push('async');
      if (script.defer) attrs.push('defer');
      if (script.type) attrs.push(`type="${this.escapeAttr(script.type)}"`);
      parts.push(`  <script ${attrs.join(' ')}></script>`);
    }

    return parts.join('\n');
  }

  /**
   * 转义 HTML 属性值中的特殊字符
   */
  private escapeAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 转义 HTML 文本内容中的特殊字符
   */
  private escapeHTML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
