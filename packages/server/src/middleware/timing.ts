/**
 * @nami/server - 请求计时中间件
 *
 * 记录每个 HTTP 请求的处理耗时，并通过 X-Response-Time 响应头返回给客户端。
 *
 * 工作原理：
 * 1. 请求到达时记录高精度起始时间戳（process.hrtime.bigint）
 * 2. 等待所有下游中间件执行完毕
 * 3. 计算耗时差值，设置 X-Response-Time 响应头
 *
 * 该中间件应位于中间件链的最外层（第一个注册），
 * 以确保统计的耗时覆盖所有下游中间件的处理时间。
 *
 * @example
 * ```typescript
 * import { timingMiddleware } from '@nami/server';
 *
 * app.use(timingMiddleware());
 * ```
 */

import type Koa from 'koa';

/**
 * 创建请求计时中间件
 *
 * @returns Koa 中间件函数
 */
export function timingMiddleware(): Koa.Middleware {
  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    /**
     * 使用 process.hrtime.bigint() 获取纳秒级精度的起始时间。
     * 相比 Date.now()，hrtime 不受系统时钟调整的影响，更适合计时场景。
     */
    const startTime = process.hrtime.bigint();

    /**
     * 将起始时间存入 ctx.state，供下游中间件（如渲染中间件）读取。
     * 这样其他中间件也可以基于同一起始点计算阶段耗时。
     */
    ctx.state.requestStartTime = startTime;

    // 执行所有下游中间件
    await next();

    /**
     * 计算请求总耗时：
     * hrtime.bigint() 返回纳秒，除以 1_000_000n 转为毫秒，
     * 再转为 Number 类型以便格式化输出。
     */
    const endTime = process.hrtime.bigint();
    const durationNs = endTime - startTime;
    const durationMs = Number(durationNs) / 1_000_000;

    /**
     * 设置 X-Response-Time 响应头。
     * 保留两位小数，单位为毫秒（ms）。
     * 该值可被 CDN、负载均衡器、前端监控等系统采集。
     */
    ctx.set('X-Response-Time', `${durationMs.toFixed(2)}ms`);
  };
}
