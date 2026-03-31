/**
 * @nami/server - 请求上下文中间件
 *
 * 为每个 HTTP 请求生成唯一的 requestId，并注入到 Koa 上下文中。
 * requestId 贯穿整个请求处理流程，用于：
 *
 * 1. 日志链路追踪 — 同一请求的所有日志都携带相同的 requestId
 * 2. 错误定位 — 错误发生时可通过 requestId 定位完整的请求链路
 * 3. 性能分析 — 将渲染各阶段耗时关联到同一个 requestId
 * 4. 分布式追踪 — requestId 可传递给下游微服务
 *
 * 工作流程：
 * 1. 检查请求头中是否已携带 X-Request-Id（由上游代理或网关设置）
 * 2. 如果没有，生成新的 UUID v4 作为 requestId
 * 3. 将 requestId 注入到 ctx.state.requestId
 * 4. 创建携带 requestId 的子 Logger 实例，存入 ctx.state.logger
 * 5. 在响应头中回传 X-Request-Id，便于客户端关联
 *
 * @example
 * ```typescript
 * import { requestContextMiddleware } from '@nami/server';
 *
 * app.use(requestContextMiddleware());
 *
 * // 下游中间件中使用
 * app.use(async (ctx, next) => {
 *   const { requestId, logger } = ctx.state;
 *   logger.info('处理请求', { url: ctx.url });
 *   await next();
 * });
 * ```
 */

import type Koa from 'koa';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@nami/shared';

/**
 * 请求上下文中间件配置选项
 */
export interface RequestContextOptions {
  /**
   * 请求头中携带 requestId 的头部名称
   * 支持上游代理（如 Nginx、API Gateway）注入的请求 ID
   * 默认: 'x-request-id'
   */
  requestIdHeader?: string;

  /**
   * 日志前缀
   * 默认: '@nami/server'
   */
  loggerPrefix?: string;
}

/**
 * 创建请求上下文中间件
 *
 * @param options - 配置选项（可选）
 * @returns Koa 中间件函数
 */
export function requestContextMiddleware(
  options: RequestContextOptions = {},
): Koa.Middleware {
  const {
    requestIdHeader = 'x-request-id',
    loggerPrefix = '@nami/server',
  } = options;

  /** 创建基础 Logger 实例，所有请求级子 Logger 都从此派生 */
  const baseLogger = createLogger(loggerPrefix);

  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    /**
     * 获取或生成 requestId：
     * - 优先使用上游代理（如 Nginx、API Gateway）注入的请求 ID
     * - 如果上游未注入，则生成新的 UUID v4
     *
     * 这确保了在分布式架构中，同一请求在不同服务间可以共享相同的追踪 ID
     */
    const existingRequestId = ctx.get(requestIdHeader);
    const requestId = existingRequestId || uuidv4();

    /**
     * 将 requestId 注入到 ctx.state 中
     * ctx.state 是 Koa 推荐的请求级数据传递方式，
     * 下游中间件和路由处理器都可以通过 ctx.state.requestId 访问
     */
    ctx.state.requestId = requestId;

    /**
     * 创建携带 requestId 的子 Logger 实例
     *
     * 子 Logger 自动在每条日志中附加 requestId 字段，
     * 无需下游中间件手动传入，降低日志追踪的使用门槛。
     */
    ctx.state.logger = baseLogger.child({ requestId });

    /**
     * 在响应头中回传 requestId
     * 便于客户端（如前端监控 SDK）将页面行为与服务端日志关联
     */
    ctx.set('X-Request-Id', requestId);

    // 执行下游中间件
    await next();
  };
}
