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
 *    `fallback=false` 的动态路由文件不存在时返回稳定 404；其他读取失败交给上层降级。
 *
 * 适用场景：
 * - 博客、文档、营销页等内容相对固定的页面
 * - 对 TTFB 要求极高的场景（静态文件 + CDN 分发）
 * - 不需要实时数据的页面
 *
 * 降级策略：
 * SSG 读取/产物异常时可降级到 CSR（createFallbackRenderer 返回 CSRRenderer）；
 * `fallback=false` 的动态路径缺失是正常 404，不属于异常降级。
 *
 * 性能特征：
 * - TTFB 极快（直接返回静态文件，可被 CDN 缓存）
 * - FCP/LCP 快（HTML 已包含完整内容）
 * - 构建时间与页面数量成正比
 * - 内容更新需要重新构建和部署
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ReactElement } from 'react';

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
import { RenderMode as RenderModeEnum, RenderError, ErrorCode } from '@nami/shared';

import { BaseRenderer } from './base-renderer';
import { CSRRenderer } from './csr-renderer';
import {
  assertValidStaticPropsResult,
  resolveStaticRedirectStatus,
} from '../data/static-props-result';
import { matchPath } from '../router/path-matcher';
import type {
  RendererOptions,
  AppElementFactory,
  StaticFileReader,
  ModuleLoaderLike,
} from './types';

function isOutsideDirectory(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
}

function assertStaticFileInsideDirectory(
  staticDir: string,
  filePath: string,
  requestPath: string,
): string {
  const resolvedStaticDir = path.resolve(staticDir);
  const resolvedFilePath = path.resolve(filePath);
  const relative = path.relative(resolvedStaticDir, resolvedFilePath);

  if (isOutsideDirectory(relative) || path.isAbsolute(relative)) {
    throw new RenderError(`SSG 静态文件路径非法: ${requestPath}`, ErrorCode.RENDER_SSG_FAILED, {
      requestPath,
      staticDir: resolvedStaticDir,
      filePath: resolvedFilePath,
    });
  }

  return resolvedFilePath;
}

type StaticRouteSegment = {
  kind: 'static';
  value: string;
};

type DynamicRouteSegment = {
  kind: 'dynamic';
  name: string;
  optional: boolean;
  multiSegment: boolean;
  allowEmpty: boolean;
};

type ParsedRouteSegment = StaticRouteSegment | DynamicRouteSegment;

interface ParsedRoutePattern {
  segments: ParsedRouteSegment[];
  isDynamic: boolean;
}

/**
 * 按与 path-matcher 相同的“路径段”语法解析路由模式。
 *
 * SSG 不可以只用 `path.includes(':')` 判断动态路由：Nami 还支持 `*` 与 `(.*)`；
 * 也不可以直接替换 `:key`：否则 `:id?`、`:id(\\d+)`、`:path+` 会把修饰符残留
 * 在输出文件名中。这里把构建期 URL 生成和运行期文件定位收敛到同一份解析结果。
 */
function parseRoutePattern(routePath: string): ParsedRoutePattern {
  const segments: ParsedRouteSegment[] = [];
  const parameterNames = new Set<string>();
  let parameterIndex = 0;

  for (const segment of routePath.split('/').filter(Boolean)) {
    let parsedSegment: ParsedRouteSegment;

    if (segment === '*') {
      parsedSegment = {
        kind: 'dynamic',
        name: '*',
        optional: false,
        multiSegment: true,
        allowEmpty: false,
      };
    } else {
      const groupMatch = segment.match(/^\((.+)\)$/);
      if (groupMatch) {
        parsedSegment = {
          kind: 'dynamic',
          // path-matcher 也按“此前已经出现的动态参数数量”命名正则分组。
          name: `$${parameterIndex}`,
          optional: false,
          multiSegment: true,
          allowEmpty: groupMatch[1] === '.*',
        };
      } else if (segment.startsWith(':')) {
        let parameterExpression = segment.slice(1);
        const optional = parameterExpression.endsWith('?');
        if (optional) {
          parameterExpression = parameterExpression.slice(0, -1);
        }

        const constraintMatch = parameterExpression.match(/^(\w+)\((.+)\)$/);
        const multiSegment = !constraintMatch && parameterExpression.endsWith('+');
        const name = constraintMatch
          ? constraintMatch[1]
          : multiSegment
            ? parameterExpression.slice(0, -1)
            : parameterExpression;

        if (!name) {
          throw new RenderError(`SSG 路由参数名称为空: ${routePath}`, ErrorCode.RENDER_SSG_FAILED, {
            route: routePath,
            segment,
          });
        }

        parsedSegment = {
          kind: 'dynamic',
          name,
          optional,
          multiSegment,
          allowEmpty: false,
        };
      } else {
        parsedSegment = { kind: 'static', value: segment };
      }
    }

    segments.push(parsedSegment);
    if (parsedSegment.kind === 'dynamic') {
      if (parameterNames.has(parsedSegment.name)) {
        throw new RenderError(
          `SSG 路由包含重复参数名: ${routePath}#${parsedSegment.name}`,
          ErrorCode.RENDER_SSG_FAILED,
          { route: routePath, parameter: parsedSegment.name },
        );
      }
      parameterNames.add(parsedSegment.name);
      parameterIndex++;
    }
  }

  return {
    segments,
    isDynamic: parameterIndex > 0,
  };
}

function encodeStaticPathSegment(value: string, routePath: string, parameterName: string): string {
  if (value === '.' || value === '..') {
    throw new RenderError(
      `SSG 路由参数不能是点路径段: ${routePath}#${parameterName}`,
      ErrorCode.RENDER_SSG_FAILED,
      { route: routePath, parameter: parameterName, value },
    );
  }

  return encodeURIComponent(value);
}

/**
 * 将路由模式和 getStaticPaths / 路由匹配参数安全地反向生成为具体 URL。
 * 生成后再交给正式 matchPath 做 round-trip 校验，避免两套语法日后漂移时静默写错文件。
 */
function materializeStaticRoutePath(
  routePath: string,
  params: Record<string, string>,
  parsedPattern = parseRoutePattern(routePath),
): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new RenderError(
      `getStaticPaths.params 必须是对象: ${routePath}`,
      ErrorCode.RENDER_SSG_FAILED,
      { route: routePath },
    );
  }

  const concreteSegments: string[] = [];
  const expectedValues = new Map<string, string>();

  for (const segment of parsedPattern.segments) {
    if (segment.kind === 'static') {
      concreteSegments.push(segment.value);
      continue;
    }

    const rawValue = params[segment.name];
    if (rawValue === undefined || (rawValue === '' && !segment.allowEmpty)) {
      if (segment.optional) {
        continue;
      }

      throw new RenderError(
        `getStaticPaths 缺少必需参数: ${routePath}#${segment.name}`,
        ErrorCode.RENDER_SSG_FAILED,
        { route: routePath, parameter: segment.name, params },
      );
    }

    if (typeof rawValue !== 'string') {
      throw new RenderError(
        `getStaticPaths 参数必须是字符串: ${routePath}#${segment.name}`,
        ErrorCode.RENDER_SSG_FAILED,
        { route: routePath, parameter: segment.name, value: rawValue },
      );
    }

    let encodedValue: string;
    if (segment.multiSegment) {
      const pathSegments = rawValue.split('/');
      if (rawValue !== '' && pathSegments.some((value) => value.length === 0)) {
        throw new RenderError(
          `getStaticPaths 多段参数包含空路径段: ${routePath}#${segment.name}`,
          ErrorCode.RENDER_SSG_FAILED,
          { route: routePath, parameter: segment.name, value: rawValue },
        );
      }
      encodedValue = pathSegments
        .map((value) => encodeStaticPathSegment(value, routePath, segment.name))
        .join('/');
    } else {
      if (rawValue.includes('/')) {
        throw new RenderError(
          `getStaticPaths 单段参数不能包含斜杠: ${routePath}#${segment.name}`,
          ErrorCode.RENDER_SSG_FAILED,
          { route: routePath, parameter: segment.name, value: rawValue },
        );
      }
      encodedValue = encodeStaticPathSegment(rawValue, routePath, segment.name);
    }

    concreteSegments.push(encodedValue);
    expectedValues.set(segment.name, rawValue);
  }

  const concretePath = concreteSegments.length > 0 ? `/${concreteSegments.join('/')}` : '/';
  const matchResult = matchPath(routePath, concretePath, { exact: true });

  if (!matchResult) {
    throw new RenderError(
      `getStaticPaths 参数无法生成匹配路由的 URL: ${routePath}`,
      ErrorCode.RENDER_SSG_FAILED,
      { route: routePath, params, concretePath },
    );
  }

  for (const [name, expectedValue] of expectedValues) {
    if (matchResult.params[name] !== expectedValue) {
      throw new RenderError(
        `getStaticPaths 参数与路由约束不匹配: ${routePath}#${name}`,
        ErrorCode.RENDER_SSG_FAILED,
        {
          route: routePath,
          parameter: name,
          value: expectedValue,
          matchedValue: matchResult.params[name],
          concretePath,
        },
      );
    }
  }

  return concretePath;
}

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
   * 静态 HTML 输出/读取目录。
   *
   * 默认解析为 `${config.outDir}/static`；构建器可传入绝对路径，
   * 避免其执行目录与项目根目录不一致时把产物写到错误位置。
   */
  staticDir?: string;

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

const STATIC_PAGE_METADATA_VERSION = 1;
const STATIC_PAGE_METADATA_SUFFIX = '.nami.json';

interface StaticPageMetadata {
  version: typeof STATIC_PAGE_METADATA_VERSION;
  kind: 'page' | 'redirect' | 'not-found';
  statusCode: number;
  headers: Record<string, string>;
  /** getStaticProps 为该页面动态声明的重验证间隔 */
  revalidate?: number;
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
  private readonly moduleLoader?: ModuleLoaderLike;

  constructor(options: SSGRendererOptions) {
    super(options);
    this.appElementFactory = options.appElementFactory;
    this.fileReader = options.staticFileReader ?? this.createDefaultFileReader();
    this.staticDir = path.resolve(options.staticDir ?? path.join(options.config.outDir, 'static'));
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

    const cachedResult = await this.resolvePluginCacheHit(context, timing);
    if (cachedResult) {
      return cachedResult;
    }

    timing.renderStart = Date.now();

    try {
      // 构建和运行必须用同一条“路由模式 + 参数 → canonical URL”链路。
      // 这也让 `/about/`、编码形式不同但参数相同的请求稳定定位到同一份静态产物。
      const routePattern = parseRoutePattern(context.route.path);
      const canonicalPath = materializeStaticRoutePath(
        context.route.path,
        context.params,
        routePattern,
      );
      const filePath = this.resolveStaticFilePath(canonicalPath);

      // 读取预生成的 HTML 文件
      const html = await this.fileReader.readFile(filePath);

      if (html === null) {
        if (
          context.route.renderMode === RenderModeEnum.SSG &&
          routePattern.isDynamic &&
          (context.route.fallback ?? false) === false
        ) {
          context.initialData = {};
          context.extra.__nami_data_degraded = false;
          timing.renderEnd = Date.now();
          timing.htmlEnd = Date.now();

          const notFoundResult = this.createDefaultResult(
            this.assembleHTML(this.createNotFoundAppHTML(), context, { hydrate: false }),
            404,
            RenderModeEnum.SSG,
            timing,
            {
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
              },
            },
          );
          await this.callPluginHook('afterRender', context, notFoundResult);
          return notFoundResult;
        }

        throw new RenderError(`SSG 静态文件不存在: ${filePath}`, ErrorCode.RENDER_SSG_FAILED, {
          url: context.url,
          path: context.path,
          canonicalPath,
          filePath,
        });
      }

      timing.renderEnd = Date.now();
      timing.htmlEnd = Date.now();

      const metadata = await this.readStaticPageMetadata(filePath);

      this.logger.debug('SSG 渲染完成（静态文件读取成功）', {
        url: context.url,
        filePath,
        duration: Date.now() - timing.startTime,
      });

      const result = this.createDefaultResult(
        html,
        metadata?.statusCode ?? 200,
        RenderModeEnum.SSG,
        timing,
        {
          headers: metadata?.headers ?? {
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
      assertValidStaticPropsResult(result);
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
        redirect: result.redirect,
        notFound: result.notFound,
        revalidate: result.revalidate,
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
      assetManifest: this.assetManifest,
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
    const claimedOutputPaths = new Map<string, { pagePath: string; routePath: string }>();

    if (!this.appElementFactory) {
      throw new RenderError('SSG 构建需要提供 appElementFactory', ErrorCode.RENDER_SSG_FAILED, {
        message: '请在 SSGRendererOptions 中配置 appElementFactory',
      });
    }

    this.logger.info('开始 SSG 静态生成', { routeCount: routes.length });

    // 确保输出目录存在
    await this.ensureDirectory(this.staticDir);

    for (const route of routes) {
      try {
        // 获取需要预生成的路径列表
        const pathsToGenerate = await this.getPathsForRoute(route);
        const routePattern = parseRoutePattern(route.path);

        for (const pathInfo of pathsToGenerate) {
          let pagePath = route.path;
          try {
            pagePath = materializeStaticRoutePath(route.path, pathInfo.params, routePattern);
            const outputPath = this.resolveStaticFilePath(pagePath);
            const existingOwner = claimedOutputPaths.get(outputPath);
            if (existingOwner) {
              throw new RenderError(
                `SSG 输出路径冲突: ${existingOwner.pagePath} 与 ${pagePath} 都映射到 ${outputPath}`,
                ErrorCode.RENDER_SSG_FAILED,
                {
                  outputPath,
                  firstPagePath: existingOwner.pagePath,
                  firstRoutePath: existingOwner.routePath,
                  secondPagePath: pagePath,
                  secondRoutePath: route.path,
                },
              );
            }

            claimedOutputPaths.set(outputPath, {
              pagePath,
              routePath: route.path,
            });
            await this.generateSinglePage(route, pathInfo.params, pagePath);
            generatedPaths.push(outputPath);

            this.logger.debug('页面生成成功', {
              route: route.path,
              params: pathInfo.params,
              output: outputPath,
            });
          } catch (pageError) {
            const errorMsg = pageError instanceof Error ? pageError.message : String(pageError);
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
    pagePath: string,
  ): Promise<void> {
    if (!this.appElementFactory) {
      throw new Error('appElementFactory 未配置');
    }

    // 构造虚拟渲染上下文
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
    if (prefetchResult.degraded) {
      const reasons = prefetchResult.errors.map((error) => error.message).join('; ');
      throw new RenderError(`SSG 数据预取失败: ${pagePath}`, ErrorCode.RENDER_SSG_FAILED, {
        route: route.path,
        pagePath,
        reasons,
      });
    }
    context.initialData = prefetchResult.data as Record<string, unknown>;
    context.extra.__nami_data_degraded = false;

    let fullHTML: string;
    let metadata: StaticPageMetadata;

    if (prefetchResult.redirect) {
      const statusCode = resolveStaticRedirectStatus(prefetchResult.redirect);
      fullHTML = this.createStaticRedirectHTML(prefetchResult.redirect.destination, statusCode);
      metadata = {
        version: STATIC_PAGE_METADATA_VERSION,
        kind: 'redirect',
        statusCode,
        headers: {
          Location: prefetchResult.redirect.destination,
          'Cache-Control': 'private, no-store, max-age=0',
        },
      };
    } else if (prefetchResult.notFound) {
      fullHTML = this.assembleHTML(this.createNotFoundAppHTML(), context, { hydrate: false });
      metadata = {
        version: STATIC_PAGE_METADATA_VERSION,
        kind: 'not-found',
        statusCode: 404,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
        },
      };
    } else {
      // 条件导入 react-dom/server
      const { renderToString } = await this.importRenderToString();

      // React 渲染
      const appElement = this.appElementFactory(context);
      const appHTML = renderToString(await this.prepareAppElement(appElement, context));

      // 组装完整 HTML
      fullHTML = this.assembleHTML(appHTML, context);
      metadata = {
        version: STATIC_PAGE_METADATA_VERSION,
        kind: 'page',
        statusCode: 200,
        headers: {
          'Cache-Control': this.buildStaticCacheControl(prefetchResult.revalidate),
        },
        revalidate: prefetchResult.revalidate,
      };
    }

    // 写入文件
    const outputPath = this.resolveStaticFilePath(pagePath);
    await this.ensureDirectory(path.dirname(outputPath));
    await fs.promises.writeFile(outputPath, fullHTML, 'utf-8');
    await fs.promises.writeFile(
      this.resolveStaticMetadataPath(outputPath),
      JSON.stringify(metadata, null, 2),
      'utf-8',
    );
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
    // 必须识别完整路由语法，而不只是裸 `:param`。
    const isDynamicRoute = parseRoutePattern(route.path).isDynamic;

    if (!isDynamicRoute) {
      // 静态路由只需生成一个页面
      return [{ params: {} }];
    }

    // 动态路由需要 getStaticPaths 函数
    if (!route.getStaticPaths) {
      throw new RenderError(
        `动态 SSG 路由必须配置 getStaticPaths: ${route.path}`,
        ErrorCode.RENDER_SSG_FAILED,
        { route: route.path },
      );
    }

    // 通过 ModuleLoader 从 server bundle 加载 getStaticPaths
    if (this.moduleLoader && route.getStaticPaths) {
      const getStaticPathsFn = await this.moduleLoader.getExportedFunction<
        () => Promise<GetStaticPathsResult>
      >(route.component, route.getStaticPaths);

      if (getStaticPathsFn) {
        const result = await getStaticPathsFn();
        this.assertSupportedStaticPathsFallback(route, result.fallback);
        this.logger.debug('getStaticPaths 返回路径列表', {
          path: route.path,
          pathCount: result.paths.length,
          fallback: result.fallback,
        });
        return result.paths;
      }
    }

    throw new RenderError(
      `getStaticPaths 函数未找到: ${route.component}#${route.getStaticPaths}`,
      ErrorCode.RENDER_SSG_FAILED,
      {
        component: route.component,
        functionName: route.getStaticPaths,
      },
    );
  }

  /**
   * getStaticPaths fallback 必须与当前运行时真正具备的能力一致。
   *
   * - SSG 只能可靠支持 false：未生成的动态路径由 SSGRenderer 返回静态 404。
   * - ISR 支持 blocking：冷 MISS 会同步执行 getStaticProps + React 渲染。
   * - true/static 需要首屏 fallback 与后续替换协议，当前尚未实现，构建时直接失败。
   */
  private assertSupportedStaticPathsFallback(
    route: NamiRoute,
    fallback: GetStaticPathsResult['fallback'],
  ): void {
    const expectedFallback =
      route.fallback ?? (route.renderMode === RenderModeEnum.ISR ? 'blocking' : false);

    if (fallback !== expectedFallback) {
      throw new RenderError(
        `getStaticPaths fallback 与路由配置不一致: ${route.path}`,
        ErrorCode.RENDER_SSG_FAILED,
        {
          route: route.path,
          routeFallback: expectedFallback,
          staticPathsFallback: fallback,
        },
      );
    }

    const supported =
      route.renderMode === RenderModeEnum.ISR ? fallback === 'blocking' : fallback === false;

    if (!supported) {
      throw new RenderError(
        `当前运行时不支持 ${route.renderMode} 路由的 getStaticPaths fallback=${String(fallback)}`,
        ErrorCode.RENDER_SSG_FAILED,
        {
          route: route.path,
          renderMode: route.renderMode,
          fallback,
          supportedFallback: route.renderMode === RenderModeEnum.ISR ? 'blocking' : false,
        },
      );
    }
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

    const filePath = path.join(this.staticDir, normalizedPath);
    return assertStaticFileInsideDirectory(this.staticDir, filePath, requestPath);
  }

  /** 返回 HTML 产物对应的状态 sidecar 路径。 */
  private resolveStaticMetadataPath(htmlFilePath: string): string {
    return assertStaticFileInsideDirectory(
      this.staticDir,
      `${htmlFilePath}${STATIC_PAGE_METADATA_SUFFIX}`,
      htmlFilePath,
    );
  }

  /**
   * 读取构建期写入的静态响应元数据。
   * 老产物没有 sidecar 时保持向后兼容并按普通 200 SSG 页面处理；
   * sidecar 一旦存在却损坏，则必须失败，避免把 redirect/notFound 静默恢复成 200。
   */
  private async readStaticPageMetadata(htmlFilePath: string): Promise<StaticPageMetadata | null> {
    const metadataPath = this.resolveStaticMetadataPath(htmlFilePath);
    const content = await this.fileReader.readFile(metadataPath);
    if (content === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(content) as Partial<StaticPageMetadata>;
      const validKinds: StaticPageMetadata['kind'][] = ['page', 'redirect', 'not-found'];
      const headersAreValid =
        parsed.headers !== null &&
        typeof parsed.headers === 'object' &&
        !Array.isArray(parsed.headers) &&
        Object.values(parsed.headers).every((value) => typeof value === 'string');
      const revalidateIsValid =
        parsed.revalidate === undefined ||
        (Number.isFinite(parsed.revalidate) &&
          Number.isInteger(parsed.revalidate) &&
          parsed.revalidate >= 0);

      if (!revalidateIsValid) {
        throw new TypeError('静态页面元数据 revalidate 的单位为秒，必须是非负有限整数');
      }

      if (
        parsed.version !== STATIC_PAGE_METADATA_VERSION ||
        !parsed.kind ||
        !validKinds.includes(parsed.kind) ||
        !Number.isInteger(parsed.statusCode) ||
        parsed.statusCode! < 100 ||
        parsed.statusCode! >= 600 ||
        !headersAreValid
      ) {
        throw new TypeError('静态页面元数据字段非法');
      }

      return parsed as StaticPageMetadata;
    } catch (error) {
      throw new RenderError(
        `SSG 静态页面元数据损坏: ${metadataPath}`,
        ErrorCode.RENDER_SSG_FAILED,
        {
          metadataPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private buildStaticCacheControl(revalidate?: number): string {
    if (revalidate === undefined) {
      return 'public, max-age=3600, s-maxage=86400';
    }

    return `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}`;
  }

  /** 生成无需 JavaScript/Hydration 也能工作的静态重定向文档。 */
  private createStaticRedirectHTML(destination: string, statusCode: number): string {
    const escapedDestination = this.escapeHTML(destination);
    const title = statusCode === 308 || statusCode === 301 ? '页面已永久移动' : '正在跳转';

    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <meta http-equiv="refresh" content="0; url=${escapedDestination}">`,
      `  <title>${title}</title>`,
      '</head>',
      '<body>',
      `  <p data-nami-redirect="true">页面已移动，<a href="${escapedDestination}">继续访问</a>。</p>`,
      '</body>',
      '</html>',
    ].join('\n');
  }

  /**
   * 组装完整的 HTML 文档
   *
   * @param appHTML - React 渲染输出
   * @param context - 渲染上下文
   * @returns 完整 HTML 字符串
   */
  private assembleHTML(
    appHTML: string,
    context: RenderContext,
    options: { hydrate?: boolean } = {},
  ): string {
    const hydrate = options.hydrate !== false;
    const containerId = 'nami-root';

    const title = hydrate
      ? ((context.route.meta?.title as string) ?? this.config.title ?? this.config.appName)
      : `404 - ${this.config.title ?? this.config.appName}`;

    const description = hydrate
      ? ((context.route.meta?.description as string) ?? this.config.description ?? '')
      : '';

    const dataScript = hydrate ? this.createHydrationDataScript(context) : '';

    const { cssLinks, jsScripts } = this.resolveAssets();

    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${this.escapeHTML(title)}</title>`,
      description ? `  <meta name="description" content="${this.escapeHTML(description)}">` : '',
      `  <meta name="renderer" content="${
        hydrate ? this.escapeHTML(String(context.route.renderMode)) : 'static-404'
      }">`,
      cssLinks,
      '</head>',
      '<body>',
      `  <div id="${containerId}">${appHTML}</div>`,
      dataScript ? `  ${dataScript}` : '',
      hydrate ? jsScripts : '',
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
    renderToString: (element: ReactElement) => string;
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
