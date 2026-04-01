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
 *   SSR 失败后返回空壳 HTML，由客户端 JS 接管渲染
 *
 * Level 3 - 骨架屏
 *   返回预渲染的骨架屏 HTML，用户体感为"加载中"
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
import {
  DegradationLevel,
  RenderMode,
  NamiError,
  ErrorCode,
  ErrorSeverity,
  createLogger,
  createTimer,
} from '@nami/shared';
import type { AssetManifest } from '../html/script-injector';
import { ScriptInjector } from '../html/script-injector';

/** 降级管理器日志 */
const logger = createLogger('@nami/core:degradation');

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
          result.meta.degraded = true;
          result.meta.degradeReason = `重试第 ${attempt} 次成功`;

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

    // ===== Level 3: 骨架屏 =====
    if (context.route.skeleton) {
      try {
        logger.debug('Level 3: 返回骨架屏', { url: context.url });

        const result = this.createSkeletonFallback(context);

        logger.info('Level 3: 骨架屏返回成功', {
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

        logger.warn('Level 3: 骨架屏降级失败', {
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
   * 返回一个空壳 HTML 页面，只包含必要的 JS 入口文件引用。
   * 浏览器加载 JS 后在客户端完成完整渲染。
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
      cssLinks,
      '</head>',
      '<body>',
      '  <div id="nami-root"></div>',
      jsScripts,
      '</body>',
      '</html>',
    ].filter(Boolean).join('\n');

    return {
      html,
      statusCode: 200,
      headers: {
        'X-Nami-Degraded': 'csr-fallback',
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
   * 创建骨架屏降级响应
   *
   * 使用路由配置中定义的骨架屏组件作为降级内容。
   * 如果骨架屏组件未配置或加载失败，此方法不会被调用。
   *
   * @param context - 渲染上下文
   * @returns 骨架屏渲染结果
   */
  private createSkeletonFallback(context: RenderContext): RenderResult {
    // 骨架屏内容（实际项目中应从组件渲染或静态文件加载）
    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '</head>',
      '<body>',
      '  <div id="nami-root">',
      '    <div class="nami-skeleton" style="padding:20px;">',
      '      <div style="height:24px;width:60%;background:#f0f0f0;border-radius:4px;margin-bottom:16px;"></div>',
      '      <div style="height:16px;width:100%;background:#f0f0f0;border-radius:4px;margin-bottom:12px;"></div>',
      '      <div style="height:16px;width:80%;background:#f0f0f0;border-radius:4px;margin-bottom:12px;"></div>',
      '      <div style="height:16px;width:90%;background:#f0f0f0;border-radius:4px;"></div>',
      '    </div>',
      '  </div>',
      '</body>',
      '</html>',
    ].join('\n');

    return {
      html,
      statusCode: 200,
      headers: {
        'X-Nami-Degraded': 'skeleton',
      },
      meta: {
        renderMode: RenderMode.CSR,
        duration: 0,
        degraded: true,
        degradeReason: '降级到骨架屏',
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
  private createStaticHTMLFallback(
    staticHTML: string,
    context: RenderContext,
  ): RenderResult {
    return {
      html: staticHTML,
      statusCode: 200,
      headers: {
        'X-Nami-Degraded': 'static-html',
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
        'X-Nami-Degraded': 'service-unavailable',
        'Retry-After': '30',
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
