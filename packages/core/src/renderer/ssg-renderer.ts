/**
 * @nami/core - SSG（静态站点生成）渲染器
 *
 * SSG 在构建时预渲染 HTML 文件，部署后直接返回静态文件，无需服务端运行时。
 *
 * 两种运行阶段：
 *
 * 1. **构建阶段**（generateStatic 方法）
 *    在 `nami build` 时执行，遍历所有 SSG 路由，
 *    调用 getStaticProps 获取数据 → renderToString 生成 HTML → 写入 dist/static/。
 *    对于动态路由，先调用 getStaticPaths 获取路径参数列表，再逐一生成。
 *
 * 2. **运行阶段**（render 方法）
 *    服务端收到请求后，直接从文件系统读取预生成的 HTML 返回。
 *    文件不存在时降级到 CSR。
 *
 * 适用场景：
 * - 博客、文档、营销页等内容相对固定的页面
 * - 对 TTFB 要求极高的场景（静态文件 + CDN 分发）
 * - 不需要实时数据的页面
 *
 * 降级策略：
 * SSG 文件不存在时降级到 CSR（createFallbackRenderer 返回 CSRRenderer）
 *
 * 性能特征：
 * - TTFB 极快（直接返回静态文件，可被 CDN 缓存）
 * - FCP/LCP 快（HTML 已包含完整内容）
 * - 构建时间与页面数量成正比
 * - 内容更新需要重新构建和部署
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  RenderMode,
  RenderContext,
  RenderResult,
  RenderTiming,
  PrefetchResult,
  GetStaticPropsContext,
  GetStaticPropsResult,
  GetStaticPathsResult,
  NamiRoute,
} from '@nami/shared';
import {
  RenderMode as RenderModeEnum,
  RenderError,
  ErrorCode,
  generateDataScript,
} from '@nami/shared';

import { BaseRenderer } from './base-renderer';
import { CSRRenderer } from './csr-renderer';
import type { RendererOptions, AppElementFactory, StaticFileReader } from './types';

/**
 * SSG 渲染器配置
 */
export interface SSGRendererOptions extends RendererOptions {
  /**
   * React 组件树工厂函数（构建阶段使用）
   *
   * 运行阶段（读取静态文件）不需要此选项，
   * 仅在 generateStatic() 构建时需要。
   */
  appElementFactory?: AppElementFactory;

  /**
   * 静态文件读取器
   *
   * 可选，不传则使用默认的 Node.js fs 实现。
   * 自定义实现可用于：
   * - 从 CDN/OSS 读取静态文件
   * - 单元测试中的 Mock
   */
  staticFileReader?: StaticFileReader;
}

/**
 * 静态文件生成结果
 */
export interface StaticGenerationResult {
  /** 成功生成的文件路径列表 */
  generatedPaths: string[];
  /** 生成失败的路径及错误 */
  errors: Array<{ path: string; error: string }>;
  /** 总耗时（毫秒） */
  duration: number;
}

/**
 * SSG 渲染器
 *
 * 支持两种工作模式：
 * - 构建模式：调用 generateStatic() 预生成静态 HTML 文件
 * - 运行模式：调用 render() 读取并返回预生成的静态文件
 */
export class SSGRenderer extends BaseRenderer {
  /** React 组件树工厂函数（构建阶段使用） */
  private readonly appElementFactory?: AppElementFactory;

  /** 静态文件读取器 */
  private readonly fileReader: StaticFileReader;

  /** 静态文件输出目录（dist/static/） */
  private readonly staticDir: string;

  /** 模块加载器（用于解析数据预取函数） */
  private readonly moduleLoader?: import('./types').ModuleLoaderLike;

  constructor(options: SSGRendererOptions) {
    super(options);
    this.appElementFactory = options.appElementFactory;
    this.fileReader = options.staticFileReader ?? this.createDefaultFileReader();
    this.staticDir = path.join(options.config.outDir, 'static');
    this.moduleLoader = options.moduleLoader;

    this.logger.debug('SSG 渲染器已初始化', {
      staticDir: this.staticDir,
      hasAppElementFactory: !!this.appElementFactory,
    });
  }

  /**
   * 返回渲染模式标识
   */
  getMode(): RenderMode {
    return RenderModeEnum.SSG;
  }

  /**
   * SSG 运行阶段渲染
   *
   * 从文件系统读取构建时预生成的 HTML 文件并返回。
   *
   * 查找逻辑：
   * 1. 根据请求路径计算对应的静态文件路径
   *    /about → dist/static/about.html
   *    / → dist/static/index.html
   *    /blog/hello → dist/static/blog/hello.html
   * 2. 检查文件是否存在
   * 3. 存在则读取返回，不存在则抛出错误（由上层触发降级）
   *
   * @param context - 渲染上下文
   * @returns 包含预生成 HTML 的渲染结果
   * @throws {RenderError} 静态文件不存在时抛出
   */
  async render(context: RenderContext): Promise<RenderResult> {
    const timing = this.createRenderTiming();

    this.logger.debug('开始 SSG 渲染（读取静态文件）', { url: context.url });

    // 触发渲染前钩子
    await this.callPluginHook('beforeRender', context);

    timing.renderStart = Date.now();

    try {
      // 计算静态文件路径
      const filePath = this.resolveStaticFilePath(context.path);

      // 读取预生成的 HTML 文件
      const html = await this.fileReader.readFile(filePath);

      if (html === null) {
        throw new RenderError(
          `SSG 静态文件不存在: ${filePath}`,
          ErrorCode.RENDER_SSG_FAILED,
          {
            url: context.url,
            path: context.path,
            filePath,
          },
        );
      }

      timing.renderEnd = Date.now();
      timing.htmlEnd = Date.now();

      this.logger.debug('SSG 渲染完成（静态文件读取成功）', {
        url: context.url,
        filePath,
        duration: Date.now() - timing.startTime,
      });

      const result = this.createDefaultResult(
        html,
        200,
        RenderModeEnum.SSG,
        timing,
        {
          headers: {
            // SSG 页面可以长时间缓存，通过 CDN 分发
            // s-maxage 控制 CDN 缓存时间，max-age 控制浏览器缓存时间
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
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

      this.logger.error('SSG 渲染失败', {
        url: context.url,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * SSG 数据预取
   *
   * 在构建阶段执行，调用路由的 getStaticProps 获取页面数据。
   * 运行阶段（直接读取文件）不需要预取数据。
   *
   * @param context - 渲染上下文
   * @returns 预取结果
   */
  async prefetchData(context: RenderContext): Promise<PrefetchResult> {
    const startTime = Date.now();
    const { route } = context;

    // 路由未配置 getStaticProps，无需预取
    if (!route.getStaticProps) {
      return {
        data: {},
        errors: [],
        degraded: false,
        duration: 0,
      };
    }

    this.logger.debug('开始 SSG 数据预取', { path: route.path });

    try {
      // 构造 getStaticProps 上下文
      const gspContext: GetStaticPropsContext = {
        params: context.params,
      };

      // 解析并执行 getStaticProps
      const gspFn = await this.resolveGetStaticProps(route.component, route.getStaticProps);

      if (!gspFn) {
        this.logger.warn('getStaticProps 函数未找到', {
          component: route.component,
          functionName: route.getStaticProps,
        });
        return {
          data: {},
          errors: [new Error(`getStaticProps 函数 "${route.getStaticProps}" 未找到`)],
          degraded: true,
          duration: Date.now() - startTime,
        };
      }

      const result = await gspFn(gspContext);
      const duration = Date.now() - startTime;

      this.logger.debug('SSG 数据预取完成', {
        path: route.path,
        duration,
        hasProps: !!result.props,
        revalidate: result.revalidate,
      });

      return {
        data: result.props ?? {},
        errors: [],
        degraded: false,
        duration,
        details: [
          {
            key: 'getStaticProps',
            success: true,
            duration,
          },
        ],
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error('SSG 数据预取失败', {
        path: route.path,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });

      return {
        data: {},
        errors: [error instanceof Error ? error : new Error(String(error))],
        degraded: true,
        duration,
        details: [
          {
            key: 'getStaticProps',
            success: false,
            duration,
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /**
   * 创建降级渲染器
   *
   * SSG 降级到 CSR：静态文件不存在或读取失败时，
   * 返回 CSR 渲染器兜底。
   *
   * @returns CSRRenderer 实例
   */
  createFallbackRenderer(): BaseRenderer {
    this.logger.info('创建 CSR 降级渲染器（SSG 降级）');
    return new CSRRenderer({
      config: this.config,
      pluginManager: this.pluginManager,
    });
  }

  // ==================== 构建阶段方法 ====================

  /**
   * 构建时静态生成
   *
   * 遍历所有 SSG 模式的路由，为每个路由生成静态 HTML 文件：
   *
   * 1. 收集所有 SSG 路由
   * 2. 对动态路由调用 getStaticPaths 获取需要预生成的路径列表
   * 3. 逐一执行：getStaticProps → renderToString → 写入文件
   *
   * 此方法仅在 `nami build` 构建阶段调用。
   *
   * @param routes - SSG 模式的路由列表
   * @returns 静态生成结果（成功/失败的路径列表和总耗时）
   */
  async generateStatic(routes: NamiRoute[]): Promise<StaticGenerationResult> {
    const startTime = Date.now();
    const generatedPaths: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    if (!this.appElementFactory) {
      throw new RenderError(
        'SSG 构建需要提供 appElementFactory',
        ErrorCode.RENDER_SSG_FAILED,
        { message: '请在 SSGRendererOptions 中配置 appElementFactory' },
      );
    }

    this.logger.info('开始 SSG 静态生成', { routeCount: routes.length });

    // 确保输出目录存在
    await this.ensureDirectory(this.staticDir);

    for (const route of routes) {
      try {
        // 获取需要预生成的路径列表
        const pathsToGenerate = await this.getPathsForRoute(route);

        for (const pathInfo of pathsToGenerate) {
          try {
            await this.generateSinglePage(route, pathInfo.params);
            const outputPath = this.resolveStaticFilePath(
              this.interpolatePath(route.path, pathInfo.params),
            );
            generatedPaths.push(outputPath);

            this.logger.debug('页面生成成功', {
              route: route.path,
              params: pathInfo.params,
              output: outputPath,
            });
          } catch (pageError) {
            const errorMsg = pageError instanceof Error ? pageError.message : String(pageError);
            const pagePath = this.interpolatePath(route.path, pathInfo.params);
            errors.push({ path: pagePath, error: errorMsg });

            this.logger.error('页面生成失败', {
              route: route.path,
              params: pathInfo.params,
              error: errorMsg,
            });
          }
        }
      } catch (routeError) {
        const errorMsg = routeError instanceof Error ? routeError.message : String(routeError);
        errors.push({ path: route.path, error: errorMsg });

        this.logger.error('路由处理失败', {
          route: route.path,
          error: errorMsg,
        });
      }
    }

    const duration = Date.now() - startTime;

    this.logger.info('SSG 静态生成完成', {
      generated: generatedPaths.length,
      failed: errors.length,
      duration,
    });

    return { generatedPaths, errors, duration };
  }

  // ==================== 私有方法 ====================

  /**
   * 生成单个页面的静态 HTML
   *
   * @param route - 路由配置
   * @param params - 动态路由参数
   */
  private async generateSinglePage(
    route: NamiRoute,
    params: Record<string, string>,
  ): Promise<void> {
    if (!this.appElementFactory) {
      throw new Error('appElementFactory 未配置');
    }

    // 构造虚拟渲染上下文
    const pagePath = this.interpolatePath(route.path, params);
    const context: RenderContext = {
      url: pagePath,
      path: pagePath,
      query: {},
      headers: {},
      route,
      params,
      timing: this.createRenderTiming(),
      requestId: `ssg-build-${Date.now()}`,
      extra: {},
    };

    // 执行数据预取
    const prefetchResult = await this.prefetchData(context);
    context.initialData = prefetchResult.data as Record<string, unknown>;

    // 条件导入 react-dom/server
    const { renderToString } = await this.importRenderToString();

    // React 渲染
    const appElement = this.appElementFactory(context);
    const appHTML = renderToString(appElement as React.ReactElement);

    // 组装完整 HTML
    const fullHTML = this.assembleHTML(appHTML, context);

    // 写入文件
    const outputPath = this.resolveStaticFilePath(pagePath);
    await this.ensureDirectory(path.dirname(outputPath));
    await fs.promises.writeFile(outputPath, fullHTML, 'utf-8');
  }

  /**
   * 获取动态路由需要预生成的路径列表
   *
   * 对于静态路由（如 /about），返回单个空参数的条目。
   * 对于动态路由（如 /blog/:id），调用 getStaticPaths 获取路径列表。
   *
   * @param route - 路由配置
   * @returns 需要预生成的路径参数列表
   */
  private async getPathsForRoute(
    route: NamiRoute,
  ): Promise<Array<{ params: Record<string, string> }>> {
    // 检查是否是动态路由（包含 : 参数）
    const isDynamicRoute = route.path.includes(':');

    if (!isDynamicRoute) {
      // 静态路由只需生成一个页面
      return [{ params: {} }];
    }

    // 动态路由需要 getStaticPaths 函数
    if (!route.getStaticPaths) {
      this.logger.warn('动态路由未配置 getStaticPaths，跳过', {
        path: route.path,
      });
      return [];
    }

    // 通过 ModuleLoader 从 server bundle 加载 getStaticPaths
    if (this.moduleLoader && route.getStaticPaths) {
      const getStaticPathsFn = await this.moduleLoader.getExportedFunction<
        () => Promise<GetStaticPathsResult>
      >(route.component, route.getStaticPaths);

      if (getStaticPathsFn) {
        const result = await getStaticPathsFn();
        this.logger.debug('getStaticPaths 返回路径列表', {
          path: route.path,
          pathCount: result.paths.length,
        });
        return result.paths;
      }
    }

    this.logger.warn('getStaticPaths 函数未找到或 ModuleLoader 未配置', {
      component: route.component,
      functionName: route.getStaticPaths,
    });

    return [];
  }

  /**
   * 将动态路由模板与参数合并为实际路径
   *
   * @param routePath - 路由路径模板（如 /blog/:id）
   * @param params - 参数映射（如 { id: 'hello' }）
   * @returns 实际路径（如 /blog/hello）
   */
  private interpolatePath(
    routePath: string,
    params: Record<string, string>,
  ): string {
    let result = routePath;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(`:${key}`, value);
    }
    return result;
  }

  /**
   * 根据请求路径计算对应的静态文件路径
   *
   * 映射规则：
   * - / → dist/static/index.html
   * - /about → dist/static/about.html
   * - /blog/hello → dist/static/blog/hello.html
   * - /blog/ → dist/static/blog/index.html
   *
   * @param requestPath - 请求路径
   * @returns 静态文件的绝对路径
   */
  private resolveStaticFilePath(requestPath: string): string {
    // 移除开头的斜杠
    let normalizedPath = requestPath.replace(/^\//, '');

    // 空路径或以 / 结尾视为目录 → 使用 index.html
    if (!normalizedPath || normalizedPath.endsWith('/')) {
      normalizedPath += 'index';
    }

    // 确保有 .html 后缀
    if (!normalizedPath.endsWith('.html')) {
      normalizedPath += '.html';
    }

    return path.join(this.staticDir, normalizedPath);
  }

  /**
   * 组装完整的 HTML 文档
   *
   * @param appHTML - React 渲染输出
   * @param context - 渲染上下文
   * @returns 完整 HTML 字符串
   */
  private assembleHTML(appHTML: string, context: RenderContext): string {
    const containerId = 'nami-root';

    const title =
      (context.route.meta?.title as string) ??
      this.config.title ??
      this.config.appName;

    const description =
      (context.route.meta?.description as string) ??
      this.config.description ??
      '';

    const dataScript = context.initialData
      ? generateDataScript(context.initialData)
      : '';

    const { cssLinks, jsScripts } = this.resolveAssets();

    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${this.escapeHTML(title)}</title>`,
      description
        ? `  <meta name="description" content="${this.escapeHTML(description)}">`
        : '',
      '  <meta name="renderer" content="ssg">',
      cssLinks,
      '</head>',
      '<body>',
      `  <div id="${containerId}">${appHTML}</div>`,
      dataScript ? `  ${dataScript}` : '',
      jsScripts,
      '</body>',
      '</html>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 条件导入 react-dom/server
   */
  private async importRenderToString(): Promise<{
    renderToString: (element: React.ReactElement) => string;
  }> {
    try {
      const ReactDOMServer = await import(/* webpackIgnore: true */ 'react-dom/server');
      return { renderToString: ReactDOMServer.renderToString };
    } catch (error) {
      throw new RenderError(
        'react-dom/server 加载失败，请确保已安装 react-dom 依赖',
        ErrorCode.RENDER_SSG_FAILED,
        {
          originalError: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * 解析 getStaticProps 函数
   *
   * @param componentPath - 组件路径
   * @param functionName - 函数名
   * @returns getStaticProps 函数或 null
   */
  private async resolveGetStaticProps(
    componentPath: string,
    functionName: string,
  ): Promise<((ctx: GetStaticPropsContext) => Promise<GetStaticPropsResult>) | null> {
    try {
      this.logger.debug('解析 getStaticProps', {
        componentPath,
        functionName,
      });

      if (this.moduleLoader) {
        return await this.moduleLoader.getExportedFunction(componentPath, functionName);
      }

      this.logger.warn('ModuleLoader 未配置，无法解析 getStaticProps', {
        componentPath,
        functionName,
      });
      return null;
    } catch (error) {
      this.logger.error('getStaticProps 函数解析失败', {
        componentPath,
        functionName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 确保目录存在，不存在则递归创建
   *
   * @param dirPath - 目录路径
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (error) {
      // EEXIST 可忽略（目录已存在）
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * 创建默认的文件读取器
   *
   * 使用 Node.js fs 模块实现，适用于标准文件系统环境。
   *
   * @returns 基于 fs 的 StaticFileReader 实现
   */
  private createDefaultFileReader(): StaticFileReader {
    return {
      async readFile(filePath: string): Promise<string | null> {
        try {
          return await fs.promises.readFile(filePath, 'utf-8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
          }
          throw error;
        }
      },
      async exists(filePath: string): Promise<boolean> {
        try {
          await fs.promises.access(filePath, fs.constants.R_OK);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * 转义 HTML 特殊字符
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
