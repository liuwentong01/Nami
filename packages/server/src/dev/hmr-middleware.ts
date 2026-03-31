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

  /**
   * 动态导入 webpack-hot-middleware
   *
   * webpack-hot-middleware 是开发依赖，仅在开发模式下加载。
   * 使用动态 require 避免在生产环境中引入。
   */
  let hotMiddleware: ReturnType<typeof import('webpack-hot-middleware')> | null = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpackHotMiddleware = require('webpack-hot-middleware');
    hotMiddleware = webpackHotMiddleware(compiler, {
      path: options.path ?? '/__webpack_hmr',
      heartbeat: options.heartbeat ?? 10000,
      log: false, // 使用我们自己的日志系统
    });

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
     * 检查是否是 HMR SSE 请求
     * webpack-hot-middleware 只处理 /__webpack_hmr 路径的请求
     */
    const handled = await new Promise<boolean>((resolve) => {
      /**
       * 将请求传递给 webpack-hot-middleware
       *
       * 如果中间件处理了请求（如 SSE 连接），不会调用 next()。
       * 如果不是 HMR 请求，会调用 next()，我们将 resolve(false) 并继续 Koa 管线。
       */
      (hotMiddleware as any)(ctx.req, ctx.res, () => {
        resolve(false);
      });

      /**
       * 如果 webpack-hot-middleware 处理了请求（SSE 连接），
       * 它会直接写入 res，此时我们不需要继续 Koa 管线。
       *
       * 通过检查 res.headersSent 来判断中间件是否已处理。
       */
      // 给一个短暂的延迟让中间件有机会处理
      setImmediate(() => {
        if (ctx.res.headersSent) {
          resolve(true);
        }
      });
    });

    if (!handled) {
      await next();
    }
  };
}
