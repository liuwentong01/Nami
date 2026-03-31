/**
 * @nami/server - 错误隔离中间件
 *
 * 这是 Nami 服务端最关键的中间件之一，负责防止单个请求的异常导致整个进程崩溃。
 *
 * 核心职责：
 * 1. 包裹下游所有中间件的执行（try-catch）
 * 2. 捕获任何未处理的同步异常和 Promise rejection
 * 3. 记录错误日志（包含请求上下文信息）
 * 4. 返回统一的错误页面（500 状态码）
 * 5. 确保进程不会因为单个请求的错误而退出
 *
 * 在中间件链中的位置：
 * ```
 * timing → security → requestContext → healthCheck → staticServe
 *   → [plugin middlewares] → 【errorIsolation】→ isrCache → render
 * ```
 *
 * errorIsolation 位于插件中间件之后、ISR 缓存和渲染中间件之前。
 * 这意味着：
 * - 它保护的是 ISR 缓存层和渲染层的错误
 * - 插件中间件的错误不在其保护范围（插件中间件应自行处理错误）
 *
 * 设计原则：
 * - 绝不让错误向上冒泡到 Koa 的全局错误处理
 * - 错误日志必须包含足够的上下文信息用于排查
 * - 错误页面应该是纯静态的，不依赖任何渲染逻辑
 *
 * @example
 * ```typescript
 * import { errorIsolationMiddleware } from '@nami/server';
 *
 * app.use(errorIsolationMiddleware());
 * ```
 */

import type Koa from 'koa';
import { createLogger } from '@nami/shared';
import type { Logger } from '@nami/shared';

/**
 * 错误隔离中间件配置选项
 */
export interface ErrorIsolationOptions {
  /**
   * 自定义错误页面 HTML 模板
   *
   * 如果提供，错误发生时将返回此 HTML 作为响应体。
   * 如果不提供，使用内置的默认错误页面。
   *
   * 模板中可使用以下占位符：
   * - {{statusCode}}: HTTP 状态码
   * - {{message}}: 错误消息（生产环境下为通用消息，开发环境下为详细错误）
   * - {{requestId}}: 请求 ID
   */
  errorPageHTML?: string;

  /**
   * 自定义错误处理回调
   *
   * 在默认的错误处理逻辑之外，额外执行的回调函数。
   * 适用于错误上报、告警等场景。
   *
   * @param error - 捕获到的错误
   * @param ctx - Koa 上下文
   */
  onError?: (error: Error, ctx: Koa.Context) => void | Promise<void>;
}

/** 模块级日志实例 */
const logger: Logger = createLogger('@nami/server:error-isolation');

/**
 * 默认的 500 错误页面 HTML
 *
 * 这是一个纯静态的 HTML 页面，不依赖任何外部资源（CSS、JS），
 * 确保在任何异常情况下都能正常渲染。
 */
function getDefaultErrorPage(requestId: string, isDev: boolean, error?: Error): string {
  /**
   * 开发环境下显示详细的错误信息和堆栈，便于快速定位问题。
   * 生产环境下只显示通用错误提示和 requestId，避免泄露内部实现细节。
   */
  const errorDetail = isDev && error
    ? `
    <div style="margin-top:24px;padding:16px;background:#fff5f5;border:1px solid #feb2b2;border-radius:8px;text-align:left;">
      <p style="margin:0 0 8px 0;font-weight:600;color:#c53030;">${escapeHtml(error.message)}</p>
      <pre style="margin:0;font-size:12px;color:#742a2a;overflow-x:auto;white-space:pre-wrap;">${escapeHtml(error.stack || '')}</pre>
    </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>500 - 服务器内部错误</title>
</head>
<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7f7f7;">
  <div style="text-align:center;max-width:600px;padding:40px 20px;">
    <h1 style="font-size:72px;color:#e53e3e;margin:0;">500</h1>
    <p style="font-size:18px;color:#4a5568;margin:16px 0 0 0;">服务器内部错误</p>
    <p style="font-size:14px;color:#a0aec0;margin:8px 0 0 0;">请求 ID: ${escapeHtml(requestId)}</p>
    ${errorDetail}
  </div>
</body>
</html>`;
}

/**
 * HTML 转义函数
 *
 * 防止错误消息中包含的特殊字符被浏览器解释为 HTML 标签，
 * 避免 XSS 攻击风险（虽然这是错误页面，也要保持安全习惯）。
 *
 * @param str - 需要转义的字符串
 * @returns 转义后的安全字符串
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 创建错误隔离中间件
 *
 * @param options - 配置选项（可选）
 * @returns Koa 中间件函数
 */
export function errorIsolationMiddleware(
  options: ErrorIsolationOptions = {},
): Koa.Middleware {
  const { errorPageHTML, onError } = options;

  /** 判断是否为开发环境 */
  const isDev = process.env.NODE_ENV !== 'production';

  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    try {
      /**
       * 执行所有下游中间件
       * 这里是核心的 try-catch 边界
       */
      await next();
    } catch (error) {
      /**
       * 规范化错误对象
       * 确保我们总是操作 Error 实例，即使 throw 了非 Error 值
       */
      const normalizedError = error instanceof Error
        ? error
        : new Error(String(error));

      /**
       * 获取请求上下文信息
       * requestId 由上游的 requestContextMiddleware 注入
       */
      const requestId = (ctx.state.requestId as string) || 'unknown';
      const requestLogger = (ctx.state.logger as Logger) || logger;

      /**
       * 记录错误日志
       *
       * 包含完整的请求上下文信息，便于事后排查：
       * - requestId: 请求唯一标识
       * - method: HTTP 方法
       * - url: 完整请求 URL
       * - userAgent: 客户端标识
       * - ip: 客户端 IP
       * - error: 错误消息
       * - stack: 错误堆栈
       */
      requestLogger.error('请求处理异常，已被错误隔离中间件捕获', {
        requestId,
        method: ctx.method,
        url: ctx.url,
        userAgent: ctx.get('user-agent'),
        ip: ctx.ip,
        error: normalizedError.message,
        stack: normalizedError.stack,
      });

      /**
       * 执行自定义错误处理回调
       *
       * 使用 try-catch 包裹，确保自定义回调的异常不会影响错误页面的返回。
       * 自定义回调通常用于错误上报（如 Sentry）、告警（如钉钉/企业微信）等。
       */
      if (onError) {
        try {
          await onError(normalizedError, ctx);
        } catch (callbackError) {
          requestLogger.error('自定义错误处理回调执行失败', {
            requestId,
            error: callbackError instanceof Error
              ? callbackError.message
              : String(callbackError),
          });
        }
      }

      /**
       * 设置错误响应
       *
       * - 状态码: 500（服务器内部错误）
       * - Content-Type: text/html
       * - X-Nami-Error: true（标记响应为错误页面，便于监控系统识别）
       */
      ctx.status = 500;
      ctx.type = 'text/html; charset=utf-8';
      ctx.set('X-Nami-Error', 'true');

      /**
       * 设置响应体：
       * - 如果提供了自定义错误页面模板，使用模板并替换占位符
       * - 否则使用内置的默认错误页面
       */
      if (errorPageHTML) {
        ctx.body = errorPageHTML
          .replace(/\{\{statusCode\}\}/g, '500')
          .replace(/\{\{message\}\}/g, isDev ? escapeHtml(normalizedError.message) : '服务器内部错误')
          .replace(/\{\{requestId\}\}/g, escapeHtml(requestId));
      } else {
        ctx.body = getDefaultErrorPage(requestId, isDev, normalizedError);
      }
    }
  };
}
