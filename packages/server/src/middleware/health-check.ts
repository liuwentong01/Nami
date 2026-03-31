/**
 * @nami/server - 健康检查中间件
 *
 * 提供 HTTP 健康检查端点（GET /_health），用于：
 *
 * 1. 负载均衡器健康探测 — K8s liveness/readiness probe、Nginx upstream check
 * 2. 监控系统存活检测 — Prometheus、Grafana 等监控工具的可用性探针
 * 3. 部署验证 — CI/CD 流水线中验证服务是否正常启动
 *
 * 响应格式：
 * ```json
 * {
 *   "status": "ok",
 *   "uptime": 12345.67,
 *   "timestamp": "2024-01-01T00:00:00.000Z"
 * }
 * ```
 *
 * 设计决策：
 * - 使用 short-circuit（短路）模式：命中健康检查路径后直接返回，不调用 next()
 *   以避免触发下游中间件（如渲染中间件），确保健康检查响应极快
 * - 仅响应 GET 请求，其他方法返回 405 Method Not Allowed
 * - 返回 JSON 格式，便于监控系统解析
 *
 * @example
 * ```typescript
 * import { healthCheckMiddleware } from '@nami/server';
 *
 * app.use(healthCheckMiddleware());
 *
 * // 自定义路径
 * app.use(healthCheckMiddleware({ path: '/health' }));
 * ```
 */

import type Koa from 'koa';
import { HEALTH_CHECK_PATH } from '@nami/shared';

/**
 * 健康检查中间件配置选项
 */
export interface HealthCheckOptions {
  /**
   * 健康检查端点路径
   * 默认: '/_health'（来自 @nami/shared 常量）
   */
  path?: string;

  /**
   * 自定义健康检查逻辑
   *
   * 如果提供了此函数，中间件会在基础检查之外调用它。
   * 函数返回 true 表示健康，返回 false 或抛出异常表示不健康。
   *
   * 使用场景：
   * - 检查数据库连接是否正常
   * - 检查 Redis 是否可达
   * - 检查下游服务是否可用
   *
   * @returns 是否健康
   */
  checker?: () => Promise<boolean> | boolean;
}

/**
 * 服务启动时间戳
 * 用于计算 uptime（服务运行时长）
 */
const serverStartTime = Date.now();

/**
 * 创建健康检查中间件
 *
 * @param options - 配置选项（可选）
 * @returns Koa 中间件函数
 */
export function healthCheckMiddleware(
  options: HealthCheckOptions = {},
): Koa.Middleware {
  const {
    path = HEALTH_CHECK_PATH,
    checker,
  } = options;

  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    /**
     * 路径匹配检查：
     * 如果请求路径不是健康检查路径，直接跳过，交给下游中间件处理
     */
    if (ctx.path !== path) {
      await next();
      return;
    }

    /**
     * HTTP 方法检查：
     * 健康检查仅接受 GET 和 HEAD 请求，其他方法返回 405
     */
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      ctx.status = 405;
      ctx.body = { error: 'Method Not Allowed' };
      // 不调用 next()，短路返回
      return;
    }

    try {
      /**
       * 执行自定义健康检查（如果配置了的话）
       *
       * 自定义检查器可用于验证数据库连接、缓存服务等外部依赖的可用性。
       * 如果自定义检查失败，返回 503 表示服务暂时不可用。
       */
      if (checker) {
        const isHealthy = await checker();
        if (!isHealthy) {
          ctx.status = 503;
          ctx.body = {
            status: 'unhealthy',
            uptime: (Date.now() - serverStartTime) / 1000,
            timestamp: new Date().toISOString(),
          };
          return;
        }
      }

      /**
       * 返回健康状态响应
       *
       * - status: 固定为 'ok'，表示服务正常运行
       * - uptime: 服务运行时长（秒），精确到小数点后两位
       * - timestamp: 当前 ISO 8601 格式时间戳
       */
      ctx.status = 200;
      ctx.type = 'application/json';
      ctx.body = {
        status: 'ok',
        uptime: Number(((Date.now() - serverStartTime) / 1000).toFixed(2)),
        timestamp: new Date().toISOString(),
      };

      /**
       * 注意：此处不调用 next()
       * 这是有意为之的短路设计 — 健康检查不需要经过渲染中间件等下游逻辑，
       * 确保响应极快（通常 < 1ms），不受渲染流程影响。
       */
    } catch (error) {
      /**
       * 健康检查自身出错时返回 503
       * 这种情况极为罕见，但需要处理以防万一
       */
      ctx.status = 503;
      ctx.body = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        uptime: (Date.now() - serverStartTime) / 1000,
        timestamp: new Date().toISOString(),
      };
    }
  };
}
