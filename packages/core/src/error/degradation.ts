/**
 * @nami/core - 降级管理器
 *
 * DegradationManager 实现了框架的 5 级降级策略，
 * 确保在各种异常情况下都能返回可用的页面内容。
 *
 * 降级等级（从 Level 0 到 Level 5）：
 *
 * Level 0 - 正常渲染
 *   一切正常，SSR 渲染成功返回完整 HTML
 *
 * Level 1 - 重试
 *   渲染失败后自动重试一次（短暂故障可能恢复）
 *
 * Level 2 - CSR 降级
 *   SSR 失败后返回带 loading 骨架的 CSR Shell，由客户端 JS 接管渲染
 *
 * Level 3 - 静态应急兜底（兼容枚举名 Skeleton）
 *   可恢复的 CSR 也不可用时，返回不依赖客户端运行时的应急内容
 *
 * Level 4 - 静态 HTML
 *   返回预配置的兜底静态 HTML（可能是上一次成功的快照）
 *
 * Level 5 - 503 服务不可用
 *   所有降级手段均失败，返回 503 错误页
 *
 * 设计原则：
 * - 逐级降级，每一级都尝试给用户最好的体验
 * - 快速失败，不在已失败的等级上浪费时间
 * - 全链路可观测，每次降级都记录日志和指标
 */

import type { RenderContext, RenderResult, FallbackConfig } from '@nami/shared';
import { DegradationLevel, RenderMode, createLogger, createTimer } from '@nami/shared';
import type { AssetManifest } from '../html/script-injector';
import { ScriptInjector } from '../html/script-injector';
import { createCSRRootContainer, resolveStaticEmergencyHTML } from '../html/csr-shell-loading';

/** 降级管理器日志 */
const logger = createLogger('@nami/core:degradation');

/**
 * 降级页面不能进入浏览器、CDN 或 ISR 页面缓存。
 * 否则一次瞬时渲染故障可能把 CSR Shell、静态应急页甚至 503 固化为正常页面。
 */
const NO_STORE_CACHE_CONTROL = 'private, no-store, max-age=0';

/**
 * 渲染函数类型
 * 传入渲染上下文，返回渲染结果
 */
type RenderFunction = (context: RenderContext) => Promise<RenderResult>;

/**
 * 降级执行结果
 */
export interface DegradationResult {
  /** 最终的渲染结果 */
  result: RenderResult;
  /** 最终降级等级 */
  level: DegradationLevel;
  /** 降级过程中的错误列表 */
  errors: Error[];
}

/**
 * 降级管理器
 *
 * 封装 5 级降级策略的执行逻辑，对外提供简单的 executeWithDegradation 接口。
 *
 * @example
 * ```typescript
 * const degradation = new DegradationManager();
 *
 * const { result, level, errors } = await degradation.executeWithDegradation(
 *   async (ctx) => await ssrRenderer.render(ctx),
 *   renderContext,
 *   fallbackConfig,
 * );
 *
 * if (level > DegradationLevel.None) {
 *   logger.warn(`渲染已降级到 Level ${level}`);
 * }
 * ```
 */
export interface DegradationManagerOptions {
  /** 静态资源公共路径前缀 */
  publicPath?: string;
  /** 构建产物资源清单 */
  assetManifest?: AssetManifest;
}

export class DegradationManager {
  private readonly publicPath: string;
  private readonly assetManifest?: AssetManifest;
  private readonly scriptInjector: ScriptInjector;

  constructor(options: DegradationManagerOptions = {}) {
    this.publicPath = options.publicPath ?? '/';
    this.assetManifest = options.assetManifest;
    this.scriptInjector = new ScriptInjector(this.publicPath);
  }

  /**
   * 解析 JS/CSS 资源标签，与 BaseRenderer.resolveAssets 保持一致
   */
  private resolveAssets(): { cssLinks: string; jsScripts: string } {
    if (this.assetManifest) {
      return {
        cssLinks: this.scriptInjector.injectStyles(this.assetManifest),
        jsScripts: this.scriptInjector.injectChunks(this.assetManifest, { defer: true }),
      };
    }
    return {
      cssLinks: `  <link rel="stylesheet" href="${this.publicPath}static/css/main.css">`,
      jsScripts: `  <script defer src="${this.publicPath}static/js/main.js"></script>`,
    };
  }

  /**
   * 带降级保护的渲染执行
   *
   * 按照 Level 0 → Level 5 的顺序依次尝试，
   * 在某一级成功后立即返回结果，不再尝试后续级别。
   *
   * @param renderFn - 原始渲染函数
   * @param context - 渲染上下文
   * @param config - 降级配置
   * @returns 降级执行结果
   */
  async executeWithDegradation(
    renderFn: RenderFunction,
    context: RenderContext,
    config: FallbackConfig,
  ): Promise<DegradationResult> {
    const timer = createTimer();
    const errors: Error[] = [];

    // ===== Level 0: 正常渲染 =====
    try {
      logger.debug('Level 0: 尝试正常渲染', {
        url: context.url,
        requestId: context.requestId,
      });

      const result = await renderFn(context);

      logger.debug('Level 0: 正常渲染成功', {
        url: context.url,
        duration: timer.total(),
      });

      return {
        result,
        level: DegradationLevel.None,
        errors: [],
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      errors.push(err);

      logger.warn('Level 0: 正常渲染失败，进入降级流程', {
        url: context.url,
        error: err.message,
      });
    }

    // ===== Level 1: 重试 =====
    if (config.maxRetries > 0) {
      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
          logger.debug(`Level 1: 第 ${attempt} 次重试`, {
            url: context.url,
            attempt,
            maxRetries: config.maxRetries,
          });

          const result = await renderFn(context);

          // 标记降级信息
          const retryResultWasAlreadyDegraded = result.meta.degraded;
          result.meta.degraded = true;
          result.meta.degradeReason = `重试第 ${attempt} 次成功`;
          result.headers['X-Nami-Degraded'] = 'retry';
          context.extra.__retry_result_cacheable = !retryResultWasAlreadyDegraded;

          // 如果重试只得到数据层的部分降级结果，仍不能进入页面缓存。
          if (retryResultWasAlreadyDegraded) {
            result.headers['Cache-Control'] = NO_STORE_CACHE_CONTROL;
            result.cacheControl = undefined;
          }

          logger.info(`Level 1: 重试成功（第 ${attempt} 次）`, {
            url: context.url,
            duration: timer.total(),
          });

          return {
            result,
            level: DegradationLevel.Retry,
            errors,
          };
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(err);

          logger.warn(`Level 1: 第 ${attempt} 次重试失败`, {
            url: context.url,
            error: err.message,
          });
        }
      }
    }

    // ===== Level 2: CSR 降级 =====
    if (config.ssrToCSR) {
      try {
        logger.debug('Level 2: 降级到 CSR', { url: context.url });

        const result = this.createCSRFallback(context);

        logger.info('Level 2: CSR 降级成功', {
          url: context.url,
          duration: timer.total(),
        });

        return {
          result,
          level: DegradationLevel.CSRFallback,
          errors,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);

        logger.warn('Level 2: CSR 降级失败', {
          url: context.url,
          error: err.message,
        });
      }
    }

    // ===== Level 3: 静态应急兜底（保留 Skeleton 枚举以兼容历史逻辑） =====
    // plugin-skeleton 或其他错误插件会在 onRenderError 中写入候选静态 HTML。
    // 它只是本级的候选内容，不能越过重试和 CSR 抢占整个降级链。
    const errorBoundarySkeletonHTML =
      context.extra.__degradation_level === DegradationLevel.Skeleton
        ? context.extra.__degradation_html
        : undefined;
    const pluginSkeletonHTML =
      [context.extra.__skeleton_fallback, errorBoundarySkeletonHTML]
        .find(
          (candidate): candidate is string =>
            typeof candidate === 'string' && candidate.trim().length > 0,
        )
        ?.trim() ?? '';

    if (pluginSkeletonHTML || context.route.skeleton) {
      try {
        logger.debug('Level 3: 返回静态应急兜底', { url: context.url });

        const result = this.createSkeletonFallback(context, pluginSkeletonHTML || undefined);

        if (pluginSkeletonHTML) {
          context.extra.__skeleton_fallback_used = true;
        }

        logger.info('Level 3: 静态应急兜底返回成功', {
          url: context.url,
          duration: timer.total(),
        });

        return {
          result,
          level: DegradationLevel.Skeleton,
          errors,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);

        logger.warn('Level 3: 静态应急兜底失败', {
          url: context.url,
          error: err.message,
        });
      }
    }

    // ===== Level 4: 静态 HTML =====
    if (config.staticHTML) {
      try {
        logger.debug('Level 4: 返回兜底静态 HTML', { url: context.url });

        const result = this.createStaticHTMLFallback(config.staticHTML, context);

        logger.info('Level 4: 静态 HTML 返回成功', {
          url: context.url,
          duration: timer.total(),
        });

        return {
          result,
          level: DegradationLevel.StaticHTML,
          errors,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);

        logger.warn('Level 4: 静态 HTML 降级失败', {
          url: context.url,
          error: err.message,
        });
      }
    }

    // ===== Level 5: 503 服务不可用 =====
    logger.error('Level 5: 所有降级手段均失败，返回 503', {
      url: context.url,
      totalErrors: errors.length,
      duration: timer.total(),
    });

    return {
      result: this.create503Response(context),
      level: DegradationLevel.ServiceUnavailable,
      errors,
    };
  }

  /**
   * 创建 CSR 降级响应
   *
   * 返回带临时 loading 骨架的 HTML Shell，并保留必要的 JS 入口文件引用。
   * 浏览器加载 JS 后在客户端完成完整渲染并替换骨架。
   *
   * @param context - 渲染上下文
   * @returns CSR 降级的渲染结果
   */
  private createCSRFallback(context: RenderContext): RenderResult {
    const { cssLinks, jsScripts } = this.resolveAssets();

    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '  <meta name="renderer" content="csr">',
      cssLinks,
      '</head>',
      '<body>',
      createCSRRootContainer(context.extra.__csr_shell_skeleton),
      jsScripts,
      '</body>',
      '</html>',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      html,
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Nami-Degraded': 'csr-fallback',
        'X-Nami-Render-Mode': RenderMode.CSR,
        'Cache-Control': NO_STORE_CACHE_CONTROL,
      },
      meta: {
        renderMode: RenderMode.CSR,
        duration: 0,
        degraded: true,
        degradeReason: 'SSR 失败，降级到 CSR',
        dataFetchDuration: 0,
      },
    };
  }

  /**
   * 创建静态应急兜底响应
   *
   * 使用插件准备的静态 HTML 或内置应急内容。此级不再表示"页面仍在加载"，
   * 且不会依赖客户端 JS 恢复；历史枚举、响应头和值保持兼容。
   *
   * @param context - 渲染上下文
   * @returns 静态应急渲染结果
   */
  private createSkeletonFallback(
    context: RenderContext,
    pluginSkeletonHTML?: string,
  ): RenderResult {
    // route.skeleton 当前只负责开启本级；没有插件内容时使用内置应急页。
    // 插件候选必须符合被动 HTML 允许列表；不安全内容回退到 Core 静态应急文档。
    const builtInEmergencyHTML = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '</head>',
      '<body>',
      '  <div id="nami-root">',
      '    <main data-nami-fallback="static-emergency" role="alert" style="padding:20px;max-width:720px;margin:0 auto;">',
      '      <h1 style="font-size:24px;margin:0 0 8px;">页面暂时不可用</h1>',
      '      <p style="color:#666;margin:0 0 16px;">页面渲染未能完成，请稍后重试。</p>',
      '      <a href="" style="color:#2563eb;">重新加载</a>',
      '    </main>',
      '    <div class="nami-skeleton" aria-hidden="true" style="padding:20px;max-width:720px;margin:0 auto;">',
      '      <div style="height:24px;width:60%;background:#f0f0f0;border-radius:4px;margin-bottom:16px;"></div>',
      '      <div style="height:16px;width:100%;background:#f0f0f0;border-radius:4px;margin-bottom:12px;"></div>',
      '      <div style="height:16px;width:80%;background:#f0f0f0;border-radius:4px;margin-bottom:12px;"></div>',
      '      <div style="height:16px;width:90%;background:#f0f0f0;border-radius:4px;"></div>',
      '    </div>',
      '  </div>',
      '</body>',
      '</html>',
    ].join('\n');
    const html = pluginSkeletonHTML
      ? resolveStaticEmergencyHTML(
          [
            '<!DOCTYPE html>',
            '<html lang="zh-CN">',
            '<head>',
            '  <meta charset="utf-8">',
            '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '  <title>页面暂时不可用</title>',
            '</head>',
            '<body>',
            pluginSkeletonHTML,
            '</body>',
            '</html>',
          ].join('\n'),
        )
      : builtInEmergencyHTML;

    return {
      html,
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Nami-Degraded': 'skeleton',
        'X-Nami-Render-Mode': 'skeleton-fallback',
        'X-Nami-Fallback-Type': 'static-emergency',
        'Cache-Control': NO_STORE_CACHE_CONTROL,
      },
      meta: {
        renderMode: RenderMode.CSR,
        duration: 0,
        degraded: true,
        degradeReason: '降级到静态应急兜底',
        dataFetchDuration: 0,
      },
    };
  }

  /**
   * 创建静态 HTML 降级响应
   *
   * 使用配置中预设的静态 HTML 内容作为最后的降级手段。
   * 该 HTML 通常是上一次成功渲染的快照或人工编写的兜底页面。
   *
   * @param staticHTML - 预配置的静态 HTML 内容
   * @param context - 渲染上下文
   * @returns 静态 HTML 渲染结果
   */
  private createStaticHTMLFallback(staticHTML: string, context: RenderContext): RenderResult {
    return {
      html: staticHTML,
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Nami-Degraded': 'static-html',
        'Cache-Control': NO_STORE_CACHE_CONTROL,
      },
      meta: {
        renderMode: RenderMode.CSR,
        duration: 0,
        degraded: true,
        degradeReason: '降级到静态 HTML',
        dataFetchDuration: 0,
      },
    };
  }

  /**
   * 创建 503 服务不可用响应
   *
   * 所有降级手段均失败时的最终兜底。
   * 返回简单的 503 错误页面。
   *
   * @param context - 渲染上下文
   * @returns 503 渲染结果
   */
  private create503Response(context: RenderContext): RenderResult {
    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '  <title>503 Service Unavailable</title>',
      '</head>',
      '<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:sans-serif;background:#fafafa;">',
      '  <div style="text-align:center;">',
      '    <h1 style="font-size:48px;color:#999;margin:0;">503</h1>',
      '    <p style="font-size:16px;color:#666;margin:16px 0 0 0;">\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5</p>',
      '  </div>',
      '</body>',
      '</html>',
    ].join('\n');

    return {
      html,
      statusCode: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Nami-Degraded': 'service-unavailable',
        'Retry-After': '30',
        'Cache-Control': NO_STORE_CACHE_CONTROL,
      },
      meta: {
        renderMode: RenderMode.CSR,
        duration: 0,
        degraded: true,
        degradeReason: '所有降级手段失败，返回 503',
        dataFetchDuration: 0,
      },
    };
  }
}
