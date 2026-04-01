/**
 * @nami/server - HMR 中间件包装器
 *
 * 将 webpack-hot-middleware 适配为 Koa 中间件。
 *
 * webpack-hot-middleware 原生是 Express 中间件格式（req, res, next），
 * 本模块将其包装为 Koa 中间件格式（ctx, next）。
 *
 * HMR（Hot Module Replacement）工作原理：
 * 1. 客户端代码中注入 HMR runtime（由 webpack HotModuleReplacementPlugin 处理）
 * 2. HMR runtime 通过 EventSource（SSE）连接到此中间件
 * 3. Webpack 编译完成后，此中间件通过 SSE 推送更新通知给客户端
 * 4. 客户端收到通知后，通过 JSONP 下载更新的模块代码
 * 5. HMR runtime 执行模块热替换，无需刷新页面
 *
 * SSE 连接路径：/__webpack_hmr
 *
 * @example
 * ```typescript
 * import { createHMRMiddleware } from '@nami/server';
 *
 * const hmrMiddleware = createHMRMiddleware(compiler, { logger });
 * app.use(hmrMiddleware);
 * ```
 */

import type Koa from 'koa';
import type { Compiler } from 'webpack';
import type { Logger } from '@nami/shared';
import { createLogger } from '@nami/shared';

/**
 * HMR 中间件配置选项
 */
export interface HMRMiddlewareOptions {
  /**
   * SSE 推送路径
   * 默认: '/__webpack_hmr'
   */
  path?: string;

  /**
   * 心跳间隔（毫秒）
   * 防止 SSE 连接超时断开
   * 默认: 10000
   */
  heartbeat?: number;

  /**
   * 自定义日志实例
   */
  logger?: Logger;
}

/** 模块级日志实例 */
const defaultLogger: Logger = createLogger('@nami/server:hmr');

/**
 * 创建 HMR 中间件（Koa 适配）
 *
 * @param compiler - Webpack Compiler 实例
 * @param options - HMR 中间件配置
 * @returns Koa 中间件函数
 */
export function createHMRMiddleware(
  compiler: Compiler,
  options: HMRMiddlewareOptions = {},
): Koa.Middleware {
  const logger = options.logger ?? defaultLogger;
  type ExpressStyleMiddleware = (
    req: Koa.Context['req'],
    res: Koa.Context['res'],
    next: () => void,
  ) => void;

  /**
   * 动态导入 webpack-hot-middleware
   *
   * webpack-hot-middleware 是开发依赖，仅在开发模式下加载。
   * 使用动态 require 避免在生产环境中引入。
   */
  let hotMiddleware: ExpressStyleMiddleware | null = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpackHotMiddleware = require('webpack-hot-middleware');
    hotMiddleware = webpackHotMiddleware(compiler, {
      path: options.path ?? '/__webpack_hmr',
      heartbeat: options.heartbeat ?? 10000,
      log: false, // 使用我们自己的日志系统
    }) as ExpressStyleMiddleware;

    logger.info('HMR 中间件已初始化', {
      path: options.path ?? '/__webpack_hmr',
    });
  } catch {
    logger.warn(
      'webpack-hot-middleware 未安装，HMR 功能不可用。' +
      '请安装: pnpm add -D webpack-hot-middleware',
    );
  }

  /**
   * Koa 中间件适配器
   *
   * 将 Express 风格的中间件 (req, res, next) 转换为 Koa 风格 (ctx, next)。
   * 核心思路是将 Koa 的 ctx.req 和 ctx.res 传给 Express 中间件。
   */
  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    if (!hotMiddleware) {
      await next();
      return;
    }

    /**
     * Express → Koa 适配器（无竞态版本）
     *
     * HMR 中间件的特殊之处：SSE 连接建立后，响应不会 finish，
     * 但 headers 已经发送。因此除了 finish/close 事件外，
     * 还需要通过 res.writeHead 拦截来检测 SSE 响应的开始。
     *
     * 三种互斥信号：
     * 1. next() 被调用 → 非 HMR 请求，继续 Koa 管线
     * 2. res 写入响应头（headersSent） → SSE 连接已建立
     * 3. 超时兜底 → 防止 Promise 永远挂起
     */
    const ADAPTER_TIMEOUT_MS = 30_000;
    const handled = await new Promise<boolean>((resolve, reject) => {
      let resolved = false;

      /** 统一的清理 + resolve 入口，保证只执行一次 */
      const settle = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        ctx.res.removeListener('finish', onResponse);
        ctx.res.removeListener('close', onResponse);
        // 恢复原始 writeHead（如果已被拦截）
        if (originalWriteHead) {
          ctx.res.writeHead = originalWriteHead;
        }
        resolve(value);
      };

      // 信号 1：中间件完成响应（普通 HTTP 请求场景）
      const onResponse = () => settle(true);
      ctx.res.once('finish', onResponse);
      ctx.res.once('close', onResponse);

      /**
       * 拦截 writeHead 以检测 SSE 连接建立
       *
       * HMR 的 SSE 连接会调用 writeHead 设置响应头后持续保持连接，
       * 不会触发 finish 事件。通过拦截 writeHead 来及时检测。
       */
      const originalWriteHead = ctx.res.writeHead;
      ctx.res.writeHead = function interceptedWriteHead(
        this: typeof ctx.res,
        ...args: Parameters<typeof originalWriteHead>
      ) {
        const result = originalWriteHead.apply(this, args);
        // 响应头已发送，说明中间件接管了此请求
        settle(true);
        return result;
      } as typeof ctx.res.writeHead;

      // 信号 2：超时兜底，防止 Promise 永远挂起
      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          logger.warn('HMR 中间件适配器超时，跳过该请求', {
            path: ctx.path,
            timeoutMs: ADAPTER_TIMEOUT_MS,
          });
          settle(false);
        }
      }, ADAPTER_TIMEOUT_MS);

      // 调用 Express 中间件
      try {
        hotMiddleware(ctx.req, ctx.res, () => {
          // 信号 3：HMR 中间件调用了 next()，说明不是 HMR 请求
          settle(false);
        });
      } catch (err) {
        // 同步异常：清理资源后向上抛出
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          ctx.res.removeListener('finish', onResponse);
          ctx.res.removeListener('close', onResponse);
          if (originalWriteHead) {
            ctx.res.writeHead = originalWriteHead;
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    if (!handled) {
      await next();
    }
  };
}
