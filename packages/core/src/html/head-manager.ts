/**
 * @nami/core - Head 标签管理器
 *
 * HeadManager 管理 HTML <head> 标签中的所有元素：
 * - <title>
 * - <meta>
 * - <link>
 * - <script>
 *
 * 支持去重：相同 key 的标签会被后加入的覆盖，而非重复添加。
 * 这在 SSR 场景中很重要，因为服务端可能在多个中间件/钩子中
 * 操作 head 内容，需要确保最终输出不包含重复的标签。
 *
 * 去重策略：
 * - title: 始终只有一个，后设置覆盖前设置
 * - meta: 按 name 或 property 去重
 * - link: 按 rel + href 去重
 * - script: 按 src 去重
 */

import { createLogger } from '@nami/shared';

/** Head 管理器日志 */
const logger = createLogger('@nami/core:head-manager');

/**
 * Head 标签条目
 * 内部用于存储各类标签的统一结构
 */
interface HeadEntry {
  /** 去重 key */
  key: string;
  /** 标签类型 */
  type: 'title' | 'meta' | 'link' | 'script';
  /** 标签属性 */
  attrs: Record<string, string | boolean>;
  /** 标签内容（仅 title 和 inline script） */
  content?: string;
}

/**
 * Head 标签管理器
 *
 * 收集、去重和输出 HTML <head> 标签。
 *
 * @example
 * ```typescript
 * const head = new HeadManager();
 *
 * head.setTitle('我的页面 - Nami App');
 * head.addMeta('description', '这是一个示例页面');
 * head.addMeta('keywords', 'nami, ssr, react');
 * head.addLink('stylesheet', '/styles/main.css');
 * head.addLink('icon', '/favicon.ico');
 * head.addScript('/js/analytics.js', { async: true });
 *
 * const headHTML = head.renderToString();
 * // <title>我的页面 - Nami App</title>
 * // <meta name="description" content="这是一个示例页面">
 * // <meta name="keywords" content="nami, ssr, react">
 * // <link rel="stylesheet" href="/styles/main.css">
 * // <link rel="icon" href="/favicon.ico">
 * // <script src="/js/analytics.js" async></script>
 * ```
 */
export class HeadManager {
  /** 存储所有 head 标签条目，使用 Map 实现去重 */
  private readonly entries: Map<string, HeadEntry> = new Map();

  /**
   * 设置页面标题
   *
   * 始终只有一个 <title> 标签，多次调用会覆盖。
   *
   * @param title - 页面标题文本
   */
  setTitle(title: string): void {
    this.entries.set('title', {
      key: 'title',
      type: 'title',
      attrs: {},
      content: title,
    });

    logger.debug('设置页面标题', { title });
  }

  /**
   * 添加 <meta> 标签
   *
   * 按 name（或 property）去重，相同 name 的 meta 标签会被覆盖。
   *
   * @param name - meta 标签的 name 属性值
   * @param content - meta 标签的 content 属性值
   *
   * @example
   * ```typescript
   * head.addMeta('description', '页面描述');
   * head.addMeta('og:title', '分享标题'); // 自动使用 property 属性
   * ```
   */
  addMeta(name: string, content: string): void {
    const key = `meta:${name}`;

    // 以 og:、twitter:、fb: 开头的使用 property 属性（Open Graph / Twitter Card）
    const isProperty = /^(og|twitter|fb|article):/.test(name);

    const attrs: Record<string, string> = isProperty
      ? { property: name, content }
      : { name, content };

    this.entries.set(key, {
      key,
      type: 'meta',
      attrs,
    });

    logger.debug('添加 meta 标签', { name, content: content.substring(0, 50) });
  }

  /**
   * 添加 <link> 标签
   *
   * 按 rel + href 去重。
   *
   * @param rel - link 标签的 rel 属性值（如 stylesheet、icon、preload）
   * @param href - 资源 URL
   * @param attrs - 额外属性（如 media、type、crossorigin 等）
   *
   * @example
   * ```typescript
   * head.addLink('stylesheet', '/styles/main.css');
   * head.addLink('preload', '/fonts/sans.woff2', { as: 'font', crossorigin: 'anonymous' });
   * ```
   */
  addLink(
    rel: string,
    href: string,
    attrs?: Record<string, string>,
  ): void {
    const key = `link:${rel}:${href}`;

    this.entries.set(key, {
      key,
      type: 'link',
      attrs: {
        rel,
        href,
        ...attrs,
      },
    });

    logger.debug('添加 link 标签', { rel, href });
  }

  /**
   * 添加 <script> 标签
   *
   * 按 src 去重。
   *
   * @param src - 脚本 URL
   * @param attrs - 额外属性（如 async、defer、type、crossorigin 等）
   *
   * @example
   * ```typescript
   * head.addScript('/js/analytics.js', { async: true });
   * head.addScript('/js/vendor.js', { defer: true });
   * head.addScript('/js/module.js', { type: 'module' });
   * ```
   */
  addScript(
    src: string,
    attrs?: Record<string, string | boolean>,
  ): void {
    const key = `script:${src}`;

    this.entries.set(key, {
      key,
      type: 'script',
      attrs: {
        src,
        ...attrs,
      },
    });

    logger.debug('添加 script 标签', { src });
  }

  /**
   * 将所有 head 标签渲染为 HTML 字符串
   *
   * 输出顺序：title → meta → link → script
   *
   * @returns 所有 head 标签拼接的 HTML 字符串
   */
  renderToString(): string {
    const entries = Array.from(this.entries.values());

    // 按类型排序：title → meta → link → script
    const typeOrder: Record<string, number> = {
      title: 0,
      meta: 1,
      link: 2,
      script: 3,
    };

    entries.sort((a, b) => {
      return (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
    });

    const tags = entries.map((entry) => this.renderEntry(entry));

    logger.debug('渲染 head 标签', { count: tags.length });

    return tags.join('\n');
  }

  /**
   * 获取当前标签数量
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 清空所有标签
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * 渲染单个 head 标签条目
   */
  private renderEntry(entry: HeadEntry): string {
    switch (entry.type) {
      case 'title':
        return `<title>${this.escapeHTML(entry.content ?? '')}</title>`;

      case 'meta':
        return `<meta ${this.renderAttrs(entry.attrs)}>`;

      case 'link':
        return `<link ${this.renderAttrs(entry.attrs)}>`;

      case 'script': {
        const attrsStr = this.renderAttrs(entry.attrs);
        return `<script ${attrsStr}></script>`;
      }

      default:
        return '';
    }
  }

  /**
   * 将属性对象渲染为 HTML 属性字符串
   *
   * @example
   * { name: 'desc', content: 'hello' } → 'name="desc" content="hello"'
   * { src: '/js/app.js', async: true } → 'src="/js/app.js" async'
   */
  private renderAttrs(attrs: Record<string, string | boolean>): string {
    return Object.entries(attrs)
      .map(([key, value]) => {
        if (typeof value === 'boolean') {
          return value ? key : '';
        }
        return `${key}="${this.escapeAttr(value)}"`;
      })
      .filter(Boolean)
      .join(' ');
  }

  /**
   * 转义 HTML 属性值
   */
  private escapeAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 转义 HTML 文本内容
   */
  private escapeHTML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
