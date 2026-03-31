/**
 * @nami/core - CSR（客户端渲染）渲染器
 *
 * CSR 是降级链的终点，也是最简单的渲染模式。
 *
 * 工作原理：
 * 服务端只返回一个"空壳" HTML（包含 <div id="nami-root"></div> 和
 * 客户端 JS/CSS 资源引用），所有渲染和数据获取工作都在浏览器端完成。
 *
 * 适用场景：
 * - 管理后台、内部系统等不需要 SEO 的页面
 * - SSR/SSG 降级后的兜底方案
 * - 开发环境快速迭代
 *
 * 降级策略：
 * CSR 是渲染模式降级链的最后一环，createFallbackRenderer() 返回 null。
 * 如果 CSR 也失败，将由上层错误处理机制返回兜底静态 HTML 或 503。
 *
 * 性能特征：
 * - TTFB 最快（服务端几乎零计算）
 * - FCP/LCP 最慢（需要下载并执行 JS 后才开始渲染）
 * - 不利于 SEO（搜索引擎爬虫可能无法执行 JS）
 */

import type {
  RenderMode,
  RenderContext,
  RenderResult,
  PrefetchResult,
  NamiConfig,
} from '@nami/shared';
import { RenderMode as RenderModeEnum } from '@nami/shared';

import { BaseRenderer } from './base-renderer';
import type { RendererOptions } from './types';

/**
 * CSR 渲染器
 *
 * 生成包含客户端资源引用的空壳 HTML，实际渲染工作交给浏览器完成。
 */
export class CSRRenderer extends BaseRenderer {
  constructor(options: RendererOptions) {
    super(options);
    this.logger.debug('CSR 渲染器已初始化');
  }

  /**
   * 返回渲染模式标识
   */
  getMode(): RenderMode {
    return RenderModeEnum.CSR;
  }

  /**
   * 执行 CSR 渲染
   *
   * 生成一个包含以下内容的 HTML 页面：
   * 1. DOCTYPE 和基础 meta 标签
   * 2. CSS 资源引用（link 标签）
   * 3. 空的挂载容器 <div id="nami-root"></div>
   * 4. 客户端 JS Bundle 引用（script 标签）
   *
   * 这是一个纯模板操作，不涉及 React 渲染，因此性能稳定且极快。
   *
   * @param context - 渲染上下文
   * @returns 包含空壳 HTML 的渲染结果
   */
  async render(context: RenderContext): Promise<RenderResult> {
    const timing = this.createRenderTiming();

    this.logger.debug('开始 CSR 渲染', { url: context.url });

    // 触发渲染前钩子
    await this.callPluginHook('beforeRender', context);

    timing.renderStart = Date.now();

    try {
      // 生成空壳 HTML
      const html = this.generateShellHTML(context);

      timing.renderEnd = Date.now();
      timing.htmlEnd = Date.now();

      this.logger.debug('CSR 渲染完成', {
        url: context.url,
        duration: Date.now() - timing.startTime,
      });

      const result = this.createDefaultResult(
        html,
        200,
        RenderModeEnum.CSR,
        timing,
        {
          headers: {
            // CSR 页面可以被 CDN 短暂缓存（但不宜太长，因为 JS Bundle 更新后需要及时生效）
            'Cache-Control': 'public, max-age=60, s-maxage=120',
          },
        },
      );

      // 触发渲染后钩子
      await this.callPluginHook('afterRender', context, result);

      return result;
    } catch (error) {
      timing.renderEnd = Date.now();

      // 触发渲染错误钩子
      await this.callPluginHook('renderError', context, error);

      this.logger.error('CSR 渲染失败', {
        url: context.url,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * CSR 模式的数据预取
   *
   * CSR 模式下服务端不执行数据预取，所有数据获取由客户端完成。
   * 返回空的 PrefetchResult 以满足接口契约。
   *
   * @param _context - 渲染上下文（CSR 模式下未使用）
   * @returns 空的预取结果
   */
  async prefetchData(_context: RenderContext): Promise<PrefetchResult> {
    return {
      data: {},
      errors: [],
      degraded: false,
      duration: 0,
    };
  }

  /**
   * CSR 降级策略
   *
   * CSR 是降级链的终点，没有进一步的降级方案。
   * 如果 CSR 也失败（通常意味着模板生成出了问题），
   * 将由上层错误处理返回 fallback.staticHTML 或 503。
   *
   * @returns null — 无降级渲染器
   */
  createFallbackRenderer(): BaseRenderer | null {
    return null;
  }

  // ==================== 私有方法 ====================

  /**
   * 生成 CSR 空壳 HTML
   *
   * 构建一个最小化但完整的 HTML 文档，包含：
   * - 正确的 DOCTYPE 和字符编码
   * - viewport meta 标签（移动端适配）
   * - 页面标题和描述
   * - CSS 资源链接
   * - 空的 React 挂载容器
   * - 客户端 JS Bundle（defer 加载）
   *
   * @param context - 渲染上下文
   * @returns 空壳 HTML 字符串
   */
  private generateShellHTML(context: RenderContext): string {
    const { config } = this;
    const publicPath = config.assets.publicPath;
    const containerId = 'nami-root';

    // 页面标题：路由 meta 中的 title > 全局配置 title > 应用名称
    const title =
      (context.route.meta?.title as string) ??
      config.title ??
      config.appName;

    // 页面描述
    const description =
      (context.route.meta?.description as string) ??
      config.description ??
      '';

    // 构建 CSS 资源标签
    const cssLinks = this.buildCSSLinks(publicPath);

    // 构建 JS 资源标签
    const jsScripts = this.buildJSScripts(publicPath);

    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${this.escapeHTML(title)}</title>`,
      description ? `  <meta name="description" content="${this.escapeHTML(description)}">` : '',
      '  <meta name="renderer" content="csr">',
      cssLinks,
      '</head>',
      '<body>',
      `  <div id="${containerId}"></div>`,
      jsScripts,
      '</body>',
      '</html>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 构建 CSS 资源 link 标签
   *
   * 根据 assets 配置中的 publicPath 生成 CSS 文件引用。
   * 生产环境下文件名包含 content hash，确保缓存有效性。
   *
   * @param publicPath - 静态资源公共路径前缀
   * @returns CSS link 标签字符串
   */
  private buildCSSLinks(publicPath: string): string {
    // 实际项目中应从 asset-manifest.json 读取真实文件名
    // 这里使用约定的入口文件名
    const cssFile = `${publicPath}static/css/main.css`;
    return `  <link rel="stylesheet" href="${cssFile}">`;
  }

  /**
   * 构建 JS 资源 script 标签
   *
   * 使用 defer 属性加载，确保：
   * 1. 不阻塞 HTML 解析
   * 2. 按照文档顺序执行
   * 3. 在 DOMContentLoaded 前执行完毕
   *
   * @param publicPath - 静态资源公共路径前缀
   * @returns JS script 标签字符串
   */
  private buildJSScripts(publicPath: string): string {
    // 实际项目中应从 asset-manifest.json 读取真实文件名
    // 这里使用约定的入口文件名
    const jsFile = `${publicPath}static/js/main.js`;
    return `  <script defer src="${jsFile}"></script>`;
  }

  /**
   * 转义 HTML 特殊字符
   *
   * 防止 title、description 等用户可控内容中的 HTML 注入。
   *
   * @param str - 原始字符串
   * @returns 转义后的安全字符串
   */
  private escapeHTML(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
