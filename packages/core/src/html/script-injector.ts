/**
 * @nami/core - 脚本注入器
 *
 * ScriptInjector 负责在 HTML 文档中注入各类脚本和样式标签：
 * - 初始数据脚本（window.__NAMI_DATA__）
 * - JS chunk 脚本标签（根据 Webpack manifest）
 * - CSS 样式标签（根据 Webpack manifest）
 *
 * 在 SSR 场景中，ScriptInjector 确保：
 * 1. 初始数据在 JS 执行前已注入（放在 JS chunk 之前）
 * 2. JS chunk 按正确顺序加载（vendor → runtime → main）
 * 3. CSS 样式在页面渲染前加载（放在 <head> 中）
 * 4. 支持 async/defer 属性优化加载性能
 */

import { generateDataScript, createLogger } from '@nami/shared';

/** 脚本注入器日志 */
const logger = createLogger('@nami/core:script-injector');

/**
 * 资源清单类型
 * 从 Webpack 构建产物的 asset-manifest.json 读取
 */
export interface AssetManifest {
  /** 入口文件映射 */
  entrypoints?: {
    /** JS 入口文件列表 */
    js?: string[];
    /** CSS 入口文件列表 */
    css?: string[];
  };
  /** 所有资源文件映射（chunk name → 文件路径） */
  files?: Record<string, string>;
  /** JS chunk 文件列表 */
  js?: string[];
  /** CSS 文件列表 */
  css?: string[];
}

/**
 * 脚本属性配置
 */
export interface ScriptAttributes {
  /** 异步加载（不阻塞解析） */
  async?: boolean;
  /** 延迟执行（DOMContentLoaded 后执行） */
  defer?: boolean;
  /** 脚本类型（如 'module'） */
  type?: string;
  /** 跨域属性 */
  crossorigin?: string;
  /** 资源完整性校验 */
  integrity?: string;
  /** 预加载提示 */
  nonce?: string;
}

/**
 * 脚本注入器
 *
 * @example
 * ```typescript
 * const injector = new ScriptInjector('/static/');
 *
 * // 注入初始数据
 * const dataScript = injector.injectInitialData({ user: { name: '张三' } });
 *
 * // 注入 JS chunks
 * const jsScripts = injector.injectChunks(manifest, { defer: true });
 *
 * // 注入 CSS 样式
 * const cssLinks = injector.injectStyles(manifest);
 * ```
 */
export class ScriptInjector {
  /** 静态资源公共路径前缀 */
  private readonly publicPath: string;

  /**
   * 构造函数
   *
   * @param publicPath - 静态资源公共路径前缀，默认 '/'
   */
  constructor(publicPath: string = '/') {
    // 确保 publicPath 以 / 结尾
    this.publicPath = publicPath.endsWith('/') ? publicPath : `${publicPath}/`;
  }

  /**
   * 注入初始数据脚本
   *
   * 生成包含服务端预取数据的 <script> 标签。
   * 此标签应放在所有 JS chunk 之前，确保客户端 JS 执行时数据已就绪。
   *
   * @param data - 要注入的数据对象
   * @returns <script> 标签 HTML 字符串
   */
  injectInitialData(data: Record<string, unknown>): string {
    if (!data || Object.keys(data).length === 0) {
      logger.debug('无初始数据需要注入');
      return '';
    }

    logger.debug('注入初始数据', {
      keys: Object.keys(data),
    });

    return generateDataScript(data);
  }

  /**
   * 注入 JS chunk 脚本标签
   *
   * 根据 Webpack 构建产物的 manifest，生成所有 JS chunk 的 <script> 标签。
   * 支持 async/defer 属性配置。
   *
   * @param manifest - 资源清单
   * @param attrs - 脚本属性（async、defer 等）
   * @returns 所有 <script> 标签拼接的 HTML 字符串
   */
  injectChunks(manifest: AssetManifest, attrs?: ScriptAttributes): string {
    const jsFiles = this.resolveJSFiles(manifest);

    if (jsFiles.length === 0) {
      logger.warn('manifest 中未找到 JS 文件');
      return '';
    }

    logger.debug('注入 JS chunks', {
      count: jsFiles.length,
      files: jsFiles,
    });

    const scriptTags = jsFiles.map((file) => {
      const src = this.resolvePath(file);
      return this.createScriptTag(src, attrs);
    });

    return scriptTags.join('\n');
  }

  /**
   * 注入 CSS 样式标签
   *
   * 根据 Webpack 构建产物的 manifest，生成所有 CSS 文件的 <link> 标签。
   * 这些标签应放在 <head> 中，确保样式在页面渲染前加载。
   *
   * @param manifest - 资源清单
   * @returns 所有 <link> 标签拼接的 HTML 字符串
   */
  injectStyles(manifest: AssetManifest): string {
    const cssFiles = this.resolveCSSFiles(manifest);

    if (cssFiles.length === 0) {
      logger.debug('manifest 中未找到 CSS 文件');
      return '';
    }

    logger.debug('注入 CSS 样式', {
      count: cssFiles.length,
      files: cssFiles,
    });

    const linkTags = cssFiles.map((file) => {
      const href = this.resolvePath(file);
      return `<link rel="stylesheet" href="${this.escapeAttr(href)}">`;
    });

    return linkTags.join('\n');
  }

  /**
   * 注入预加载标签
   *
   * 为关键资源生成 <link rel="preload"> 标签，
   * 提示浏览器尽早下载这些资源。
   *
   * @param manifest - 资源清单
   * @returns <link rel="preload"> 标签 HTML 字符串
   */
  injectPreload(manifest: AssetManifest): string {
    const jsFiles = this.resolveJSFiles(manifest);
    const cssFiles = this.resolveCSSFiles(manifest);
    const tags: string[] = [];

    // 预加载 JS
    for (const file of jsFiles) {
      const href = this.resolvePath(file);
      tags.push(`<link rel="preload" href="${this.escapeAttr(href)}" as="script">`);
    }

    // 预加载 CSS
    for (const file of cssFiles) {
      const href = this.resolvePath(file);
      tags.push(`<link rel="preload" href="${this.escapeAttr(href)}" as="style">`);
    }

    return tags.join('\n');
  }

  /**
   * 从 manifest 中解析 JS 文件列表
   */
  private resolveJSFiles(manifest: AssetManifest): string[] {
    // 优先从 entrypoints 获取
    if (manifest.entrypoints?.js && manifest.entrypoints.js.length > 0) {
      return manifest.entrypoints.js;
    }

    // 降级从 js 字段获取
    if (manifest.js && manifest.js.length > 0) {
      return manifest.js;
    }

    // 从 files 映射中提取 .js 文件
    if (manifest.files) {
      return Object.values(manifest.files).filter((f) => f.endsWith('.js'));
    }

    return [];
  }

  /**
   * 从 manifest 中解析 CSS 文件列表
   */
  private resolveCSSFiles(manifest: AssetManifest): string[] {
    // 优先从 entrypoints 获取
    if (manifest.entrypoints?.css && manifest.entrypoints.css.length > 0) {
      return manifest.entrypoints.css;
    }

    // 降级从 css 字段获取
    if (manifest.css && manifest.css.length > 0) {
      return manifest.css;
    }

    // 从 files 映射中提取 .css 文件
    if (manifest.files) {
      return Object.values(manifest.files).filter((f) => f.endsWith('.css'));
    }

    return [];
  }

  /**
   * 解析资源文件路径
   *
   * 如果文件路径已是绝对 URL（http:// 或 //），直接返回。
   * 否则拼接 publicPath。
   */
  private resolvePath(file: string): string {
    // 已经是绝对 URL
    if (file.startsWith('http://') || file.startsWith('https://') || file.startsWith('//')) {
      return file;
    }

    // 已经以 publicPath 开头
    if (file.startsWith(this.publicPath)) {
      return file;
    }

    // 去掉 file 开头的 /，避免重复斜杠
    const cleanFile = file.startsWith('/') ? file.slice(1) : file;
    return `${this.publicPath}${cleanFile}`;
  }

  /**
   * 创建 <script> 标签
   */
  private createScriptTag(src: string, attrs?: ScriptAttributes): string {
    const parts: string[] = [`src="${this.escapeAttr(src)}"`];

    if (attrs?.async) parts.push('async');
    if (attrs?.defer) parts.push('defer');
    if (attrs?.type) parts.push(`type="${this.escapeAttr(attrs.type)}"`);
    if (attrs?.crossorigin) parts.push(`crossorigin="${this.escapeAttr(attrs.crossorigin)}"`);
    if (attrs?.integrity) parts.push(`integrity="${this.escapeAttr(attrs.integrity)}"`);
    if (attrs?.nonce) parts.push(`nonce="${this.escapeAttr(attrs.nonce)}"`);

    return `<script ${parts.join(' ')}></script>`;
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
}
