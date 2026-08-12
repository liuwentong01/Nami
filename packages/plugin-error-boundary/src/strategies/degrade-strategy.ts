/**
 * @nami/plugin-error-boundary - 渐进降级策略
 *
 * DegradeStrategy 实现渐进式降级，按照从优到劣的顺序尝试：
 *
 * Level 0: 正常 SSR 渲染（不在此策略内，是正常流程）
 * Level 1: 重试 SSR 渲染（可恢复错误时自动重试）
 * Level 2: 降级到 CSR（返回带临时骨架的 Shell，由客户端接管渲染）
 * Level 3: 返回静态应急页（不再假装页面仍处于可恢复的 loading）
 * Level 4: 返回兜底静态 HTML（纯静态的错误提示页面）
 * Level 5: 返回 503 Service Unavailable
 *
 * 设计原则：
 * - 尽可能保证用户看到有意义的内容
 * - 每一级降级都好过完全白屏
 * - 降级过程中记录完整的降级链路，便于排查
 */

import { DegradationLevel, ErrorSeverity, NamiError } from '@nami/shared';

/**
 * 降级策略配置
 */
export interface DegradeStrategyOptions {
  /**
   * 允许的最大降级等级
   * 超过此等级直接返回 503
   * @default DegradationLevel.StaticHTML (4)
   */
  maxDegradationLevel?: DegradationLevel;

  /**
   * CSR 降级的 HTML 模板
   * 应包含带临时骨架的 React 挂载点和客户端 JS 引用
   */
  csrFallbackHTML?: string;

  /**
   * Level 3 静态应急 HTML（字段名保留兼容）
   */
  skeletonHTML?: string;

  /**
   * 静态兜底 HTML
   * 最后的防线，纯静态页面
   */
  staticHTML?: string;

  /**
   * 自定义降级决策函数
   * 根据错误信息决定应该降级到哪个等级
   */
  customDecision?: (error: Error, currentLevel: DegradationLevel) => DegradationLevel;
}

/**
 * 降级结果
 */
export interface DegradeResult {
  /** 降级后使用的等级 */
  level: DegradationLevel;

  /** 降级等级名称（便于日志） */
  levelName: string;

  /** 降级后的 HTML 内容 */
  html: string;

  /** HTTP 状态码 */
  statusCode: number;

  /** 降级原因描述 */
  reason: string;

  /** 原始错误 */
  originalError: Error;

  /** 降级链路（经历了哪些降级步骤） */
  degradationPath: DegradationLevel[];
}

/**
 * 降级等级名称映射
 */
const LEVEL_NAMES: Record<DegradationLevel, string> = {
  [DegradationLevel.None]: '正常渲染',
  [DegradationLevel.Retry]: '重试成功',
  [DegradationLevel.CSRFallback]: 'CSR 降级',
  [DegradationLevel.Skeleton]: '静态应急兜底',
  [DegradationLevel.StaticHTML]: '静态 HTML 降级',
  [DegradationLevel.ServiceUnavailable]: '服务不可用',
};

/**
 * 渐进降级策略
 *
 * 根据错误类型和严重程度，决定应该降级到哪个等级，
 * 并返回对应等级的降级内容。
 *
 * @example
 * ```typescript
 * const strategy = new DegradeStrategy({
 *   maxDegradationLevel: DegradationLevel.StaticHTML,
 *   csrFallbackHTML: '<div id="root"></div><script src="/client.js"></script>',
 *   skeletonHTML: '<div class="skeleton">...</div>',
 * });
 *
 * // 当渲染错误发生时
 * const result = strategy.degrade(error, renderContext);
 * res.status(result.statusCode).send(result.html);
 * ```
 */
export class DegradeStrategy {
  /** 最大降级等级 */
  private readonly maxLevel: DegradationLevel;

  /** CSR 降级 HTML */
  private readonly csrFallbackHTML: string;

  /** Level 3 静态应急 HTML（字段名保留兼容） */
  private readonly skeletonHTML: string;

  /** 静态兜底 HTML */
  private readonly staticHTML: string;

  /** 自定义决策函数 */
  private readonly customDecision?: (
    error: Error,
    currentLevel: DegradationLevel,
  ) => DegradationLevel;

  constructor(options: DegradeStrategyOptions = {}) {
    this.maxLevel = options.maxDegradationLevel ?? DegradationLevel.StaticHTML;
    this.csrFallbackHTML = options.csrFallbackHTML ?? this.getDefaultCSRHTML();
    this.skeletonHTML = options.skeletonHTML ?? this.getDefaultSkeletonHTML();
    this.staticHTML = options.staticHTML ?? this.getDefaultStaticHTML();
    this.customDecision = options.customDecision;
  }

  /**
   * 执行降级
   *
   * 根据错误信息决定降级等级，并返回对应的降级结果。
   *
   * @param error - 触发降级的错误
   * @param currentLevel - 当前已经处于的降级等级（避免重复降级）
   * @returns 降级结果
   */
  degrade(error: Error, currentLevel: DegradationLevel = DegradationLevel.None): DegradeResult {
    const degradationPath: DegradationLevel[] = [currentLevel];

    // 决定目标降级等级
    let targetLevel = this.decideLevel(error, currentLevel);

    // 确保不超过最大允许的降级等级
    if (targetLevel > this.maxLevel) {
      targetLevel = DegradationLevel.ServiceUnavailable;
    }

    // 确保降级等级是递进的（不允许回退到更高等级）
    if (targetLevel <= currentLevel) {
      targetLevel = Math.min(
        currentLevel + 1,
        DegradationLevel.ServiceUnavailable,
      ) as DegradationLevel;
    }

    degradationPath.push(targetLevel);

    // 获取降级内容
    const { html, statusCode } = this.getContent(targetLevel);

    return {
      level: targetLevel,
      levelName: LEVEL_NAMES[targetLevel] ?? '未知',
      html,
      statusCode,
      reason: this.getReasonDescription(error, targetLevel),
      originalError: error,
      degradationPath,
    };
  }

  /**
   * 判断错误应该降级到哪个等级
   *
   * 决策逻辑：
   * 1. 有自定义决策函数时使用自定义逻辑
   * 2. Fatal 错误直接降级到静态 HTML 或 503
   * 3. 超时/数据预取错误可以降级到 CSR
   * 4. 渲染错误降级到静态应急页
   * 5. 其他错误降级到下一级
   */
  private decideLevel(error: Error, currentLevel: DegradationLevel): DegradationLevel {
    // 使用自定义决策函数
    if (this.customDecision) {
      return this.customDecision(error, currentLevel);
    }

    // NamiError：根据严重等级和错误码决策
    if (error instanceof NamiError) {
      // Fatal 错误：直接跳到静态 HTML
      if (error.severity === ErrorSeverity.Fatal) {
        return DegradationLevel.StaticHTML;
      }

      // Warning 级别：降级到 CSR（还有希望在客户端恢复）
      if (error.severity === ErrorSeverity.Warning) {
        return Math.max(currentLevel + 1, DegradationLevel.CSRFallback) as DegradationLevel;
      }
    }

    // 默认：降级到下一级
    return (currentLevel + 1) as DegradationLevel;
  }

  /**
   * 获取指定降级等级的内容
   */
  private getContent(level: DegradationLevel): { html: string; statusCode: number } {
    switch (level) {
      case DegradationLevel.CSRFallback:
        return {
          html: this.csrFallbackHTML,
          statusCode: 200, // CSR 降级对用户透明，返回 200
        };

      case DegradationLevel.Skeleton:
        return {
          html: this.skeletonHTML,
          // 保留历史状态码，避免影响既有代理和监控规则；语义已改为静态应急。
          statusCode: 200,
        };

      case DegradationLevel.StaticHTML:
        return {
          html: this.staticHTML,
          statusCode: 500, // 静态错误页返回 500
        };

      case DegradationLevel.ServiceUnavailable:
        return {
          html: this.get503HTML(),
          statusCode: 503,
        };

      default:
        // Retry 和 None 不应走到这里
        return {
          html: this.staticHTML,
          statusCode: 500,
        };
    }
  }

  /**
   * 生成降级原因描述
   */
  private getReasonDescription(error: Error, level: DegradationLevel): string {
    const levelName = LEVEL_NAMES[level] ?? '未知';
    if (error instanceof NamiError) {
      return `[${error.code}] ${error.message} -> 降级至: ${levelName}`;
    }
    return `${error.message} -> 降级至: ${levelName}`;
  }

  // ==================== 默认 HTML 模板 ====================

  /**
   * 默认 CSR 降级 HTML
   *
   * 返回包含临时骨架与 React 挂载点的 Shell，客户端 JS 将接管渲染。
   */
  private getDefaultCSRHTML(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading...</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root">
    <div data-nami-csr-shell="loading" role="status" aria-live="polite" aria-busy="true" style="max-width:800px;margin:0 auto;padding:24px">
      <div style="height:24px;width:60%;background:#f0f0f0;border-radius:4px;margin-bottom:16px"></div>
      <div style="height:16px;width:100%;background:#f0f0f0;border-radius:4px;margin-bottom:12px"></div>
      <div style="height:16px;width:80%;background:#f0f0f0;border-radius:4px"></div>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * 默认静态应急 HTML（方法名保留兼容）
   */
  private getDefaultSkeletonHTML(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>页面暂时不可用</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
    .sk { background: #e0e0e0; border-radius: 4px; animation: pulse 1.5s ease-in-out infinite; }
    .sk-container { max-width: 800px; margin: 0 auto; padding: 16px; }
  </style>
</head>
<body>
  <div id="root">
    <main role="alert" style="max-width:800px;margin:0 auto;padding:24px">
      <h1>页面暂时不可用</h1>
      <p>服务端和客户端降级均未能完成，请稍后重试。</p>
      <a href="">重新加载</a>
    </main>
    <div class="sk-container">
      <div class="sk" style="width:100%;height:48px;margin-bottom:16px;border-radius:0"></div>
      <div class="sk" style="width:100%;height:200px;margin-bottom:16px;border-radius:8px"></div>
      <div class="sk" style="width:70%;height:28px;margin-bottom:12px"></div>
      <div class="sk" style="width:40%;height:20px;margin-bottom:16px"></div>
      <div class="sk" style="width:100%;height:16px;margin-bottom:10px"></div>
      <div class="sk" style="width:100%;height:16px;margin-bottom:10px"></div>
      <div class="sk" style="width:80%;height:16px;margin-bottom:10px"></div>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * 默认静态错误页 HTML
   */
  private getDefaultStaticHTML(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>页面暂时不可用</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #fafafa;
      color: #333;
    }
    .container { text-align: center; padding: 40px 20px; }
    .icon { font-size: 64px; margin-bottom: 24px; }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 12px; }
    p { font-size: 16px; color: #666; margin-bottom: 32px; line-height: 1.6; }
    .btn {
      display: inline-block;
      padding: 10px 24px;
      background: #1677ff;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      text-decoration: none;
    }
    .btn:hover { background: #4096ff; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#9888;</div>
    <h1>页面暂时不可用</h1>
    <p>很抱歉，页面遇到了意外错误。请稍后再试。</p>
    <a href="/" class="btn">返回首页</a>
  </div>
</body>
</html>`;
  }

  /**
   * 503 Service Unavailable HTML
   */
  private get503HTML(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>503 - 服务暂时不可用</title>
  <meta http-equiv="retry-after" content="60">
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #fafafa;
      color: #333;
    }
    .container { text-align: center; padding: 40px 20px; }
    h1 { font-size: 72px; font-weight: 200; color: #999; margin-bottom: 8px; }
    h2 { font-size: 20px; font-weight: 400; margin-bottom: 16px; }
    p { font-size: 14px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <h1>503</h1>
    <h2>服务暂时不可用</h2>
    <p>服务器正在维护中，请稍后再试。</p>
  </div>
</body>
</html>`;
  }
}
