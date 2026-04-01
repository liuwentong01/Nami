/**
 * @nami/server - 安全响应头中间件
 *
 * 为所有 HTTP 响应注入安全相关的头部信息，防御常见的 Web 攻击：
 *
 * 1. X-Frame-Options: SAMEORIGIN
 *    - 防止页面被嵌入到第三方 iframe 中（点击劫持防护）
 *    - SAMEORIGIN 允许同源 iframe 嵌套
 *
 * 2. X-Content-Type-Options: nosniff
 *    - 阻止浏览器对响应内容进行 MIME 类型嗅探
 *    - 防止攻击者将非可执行内容伪装为可执行脚本
 *
 * 3. X-XSS-Protection: 1; mode=block
 *    - 启用浏览器内置的 XSS 过滤器
 *    - mode=block 表示检测到 XSS 时直接阻断页面渲染
 *
 * 4. Strict-Transport-Security (HSTS)
 *    - 强制浏览器在指定时间内只通过 HTTPS 访问
 *    - max-age=31536000 表示有效期一年
 *    - includeSubDomains 覆盖所有子域名
 *
 * 5. Content-Security-Policy (CSP)
 *    - 限制页面可加载资源的来源，防止 XSS 和数据注入攻击
 *    - 默认策略仅允许同源资源，可通过配置自定义
 *
 * @example
 * ```typescript
 * import { securityMiddleware } from '@nami/server';
 *
 * // 使用默认配置
 * app.use(securityMiddleware());
 *
 * // 自定义 CSP 策略
 * app.use(securityMiddleware({
 *   csp: "default-src 'self'; script-src 'self' cdn.example.com",
 * }));
 * ```
 */

import type Koa from 'koa';

/**
 * 安全中间件配置选项
 */
export interface SecurityOptions {
  /**
   * 是否启用 X-Frame-Options
   * 默认: true
   */
  frameOptions?: boolean;

  /**
   * X-Frame-Options 的值
   * 默认: 'SAMEORIGIN'
   * 可选值: 'DENY' | 'SAMEORIGIN'
   */
  frameOptionsValue?: 'DENY' | 'SAMEORIGIN';

  /**
   * 是否启用 X-Content-Type-Options
   * 默认: true
   */
  contentTypeOptions?: boolean;

  /**
   * 是否启用 X-XSS-Protection
   * 默认: true
   */
  xssProtection?: boolean;

  /**
   * 是否启用 HSTS（仅 HTTPS 环境下有意义）
   * 默认: true
   */
  hsts?: boolean;

  /**
   * HSTS max-age 秒数
   * 默认: 31536000（一年）
   */
  hstsMaxAge?: number;

  /**
   * 是否启用 Content-Security-Policy
   * 默认: true
   */
  cspEnabled?: boolean;

  /**
   * 自定义 CSP 策略字符串
   * 默认: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:;"
   *
   * 注意：默认策略中包含 'unsafe-inline' 和 'unsafe-eval' 以兼容
   * SSR 场景中 React hydration 需要的内联脚本。
   * 生产环境应根据实际情况收紧策略。
   */
  csp?: string;
}

/**
 * 默认 CSP 策略
 *
 * 基础安全策略，兼容 SSR 框架的常见需求：
 * - 'unsafe-inline': React SSR 会注入内联脚本（__NAMI_DATA__ 等）
 * - 'unsafe-eval': 部分场景下需要动态 eval（如开发模式 HMR）
 * - data: URI: 允许 base64 内联图片和字体
 * - https: 图片来源: 允许通过 HTTPS 加载外部图片资源
 */
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * 创建安全响应头中间件
 *
 * @param options - 安全配置选项（可选）
 * @returns Koa 中间件函数
 */
export function securityMiddleware(options: SecurityOptions = {}): Koa.Middleware {
  // 合并默认配置
  const {
    frameOptions = true,
    frameOptionsValue = 'SAMEORIGIN',
    contentTypeOptions = true,
    xssProtection = true,
    hsts = true,
    hstsMaxAge = 31536000,
    cspEnabled = true,
    csp = DEFAULT_CSP,
  } = options;

  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    // 执行下游中间件
    await next();

    /**
     * 某些历史链路会在更内层或更外层中间件里覆盖 Cache-Control。
     * 如果当前请求已经由框架核心计算出明确的缓存语义，
     * 则在响应收尾阶段再统一回写一次，确保最终对外协议稳定。
     */
    if (typeof ctx.state.namiCacheControl === 'string' && ctx.state.namiCacheControl.length > 0) {
      ctx.set('Cache-Control', ctx.state.namiCacheControl);
    }

    // ===== 1. 点击劫持防护 =====
    if (frameOptions) {
      ctx.set('X-Frame-Options', frameOptionsValue);
    }

    // ===== 2. MIME 类型嗅探防护 =====
    if (contentTypeOptions) {
      ctx.set('X-Content-Type-Options', 'nosniff');
    }

    // ===== 3. XSS 过滤器 =====
    if (xssProtection) {
      ctx.set('X-XSS-Protection', '1; mode=block');
    }

    // ===== 4. HSTS（HTTP Strict Transport Security） =====
    if (hsts) {
      ctx.set(
        'Strict-Transport-Security',
        `max-age=${hstsMaxAge}; includeSubDomains`,
      );
    }

    // ===== 5. Content Security Policy =====
    if (cspEnabled) {
      ctx.set('Content-Security-Policy', csp);
    }

    /**
     * 移除 X-Powered-By 头部信息，避免暴露服务端技术栈。
     * Koa 默认不会设置此头部，但某些代理或中间件可能会添加。
     */
    ctx.remove('X-Powered-By');
  };
}
