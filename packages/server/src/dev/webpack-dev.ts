/**
 * @nami/server - Webpack Dev 中间件包装器
 *
 * 将 webpack-dev-middleware 适配为 Koa 中间件。
 *
 * webpack-dev-middleware 的核心功能：
 * 1. 拦截对 Webpack 输出文件的请求
 * 2. 从内存文件系统（memfs）中提供文件，不写入磁盘
 * 3. 在编译完成前自动延迟请求（等待编译完成后再响应）
 * 4. 编译错误时返回错误信息
 *
 * 相比直接使用 koa-static：
 * - 内存文件系统，无磁盘 I/O，响应更快
 * - 自动感知 Webpack 编译状态
 * - 编译过程中的请求会被缓冲，编译完成后再响应
 *
 * @example
 * ```typescript
 * import { createWebpackDevMiddleware } from '@nami/server';
 *
 * const devMiddleware = createWebpackDevMiddleware(compiler, {
 *   publicPath: '/',
 * });
 * app.use(devMiddleware);
 * ```
 */

import type Koa from 'koa';
import type { Compiler } from 'webpack';
import type { Logger } from '@nami/shared';
import { createLogger } from '@nami/shared';

/**
 * Webpack Dev 中间件配置选项
 */
export interface WebpackDevMiddlewareOptions {
  /**
   * 资源公共路径前缀
   * 默认: '/'
   */
  publicPath?: string;

  /**
   * 自定义日志实例
   */
  logger?: Logger;

  /**
   * 是否将资源写入磁盘（用于调试）
   * 默认: false
   */
  writeToDisk?: boolean;
}

/** 模块级日志实例 */
const defaultLogger: Logger = createLogger('@nami/server:webpack-dev');

/**
 * 创建 Webpack Dev 中间件（Koa 适配）
 *
 * @param compiler - Webpack Compiler 实例
 * @param options - Webpack Dev 中间件配置
 * @returns Koa 中间件函数
 */
export function createWebpackDevMiddleware(
  compiler: Compiler,
  options: WebpackDevMiddlewareOptions = {},
): Koa.Middleware {
  const logger = options.logger ?? defaultLogger;

  /**
   * 动态导入 webpack-dev-middleware
   *
   * webpack-dev-middleware 是开发依赖，仅在开发模式下加载。
   */
  let devMiddlewareInstance: any = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpackDevMiddleware = require('webpack-dev-middleware');
    devMiddlewareInstance = webpackDevMiddleware(compiler, {
      publicPath: options.publicPath ?? '/',
      /**
       * 关闭 webpack-dev-middleware 自带的日志输出，
       * 使用 Nami 统一的日志系统
       */
      stats: 'none',
      writeToDisk: options.writeToDisk ?? false,
      /**
       * serverSideRender: true 允许在 SSR 场景下，
       * 通过 res.locals.webpack 访问编译状态和输出文件。
       */
      serverSideRender: true,
    });

    logger.info('Webpack Dev 中间件已初始化', {
      publicPath: options.publicPath ?? '/',
    });
  } catch {
    logger.warn(
      'webpack-dev-middleware 未安装，开发模式静态资源服务不可用。' +
      '请安装: pnpm add -D webpack-dev-middleware',
    );
  }

  /**
   * Koa 中间件适配器
   *
   * webpack-dev-middleware 是 Express 风格的中间件，
   * 需要适配为 Koa 风格。
   *
   * 适配策略：
   * 1. 将 ctx.req 和 ctx.res 传给 Express 中间件
   * 2. 如果中间件处理了请求（设置了 statusCode），标记 ctx.respond = false
   * 3. 如果中间件调用了 next()，继续 Koa 管线
   */
  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    if (!devMiddlewareInstance) {
      await next();
      return;
    }

    /**
     * Express → Koa 适配器（无竞态版本）
     *
     * 通过三种互斥信号判断 Express 中间件的处理结果：
     * 1. next() 被调用 → 中间件未处理，继续 Koa 管线
     * 2. res 'finish' / 'close' 事件 → 中间件已完成响应
     * 3. 超时兜底 → 防止 Promise 永远挂起
     *
     * resolved 标志确保只 resolve 一次，彻底避免竞态。
     */
    const ADAPTER_TIMEOUT_MS = 30_000;
    const handled = await new Promise<boolean>((resolve, reject) => {
      let resolved = false;

      /** 统一的清理 + resolve 入口，保证只执行一次 */
      const settle = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        ctx.res.removeListener('finish', onFinish);
        ctx.res.removeListener('close', onFinish);
        resolve(value);
      };

      // 信号 1：中间件直接写入 res 并完成响应（如返回编译后的静态文件）
      const onFinish = () => settle(true);
      ctx.res.once('finish', onFinish);
      ctx.res.once('close', onFinish);

      // 信号 2：超时兜底，防止 Promise 永远挂起
      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          logger.warn('webpack-dev-middleware 适配器超时，跳过该请求', {
            path: ctx.path,
            timeoutMs: ADAPTER_TIMEOUT_MS,
          });
          settle(false);
        }
      }, ADAPTER_TIMEOUT_MS);

      // 调用 Express 中间件
      try {
        devMiddlewareInstance(ctx.req, ctx.res, () => {
          // 信号 3：webpack-dev-middleware 调用了 next()，说明它未处理此请求
          settle(false);
        });
      } catch (err) {
        // 同步异常：清理资源后向上抛出
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          ctx.res.removeListener('finish', onFinish);
          ctx.res.removeListener('close', onFinish);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    if (handled) {
      /**
       * webpack-dev-middleware 已处理请求（如返回了编译后的 JS/CSS 文件）
       * 设置 ctx.respond = false 告诉 Koa 不要再写入响应
       */
      ctx.respond = false;
    } else {
      /**
       * webpack-dev-middleware 未处理请求，继续 Koa 管线
       *
       * 同时将 webpack devMiddleware 实例挂载到 ctx.state，
       * 以便 SSR 渲染中间件可以访问 Webpack 的内存文件系统
       */
      if (devMiddlewareInstance.context) {
        ctx.state.webpackDevMiddleware = devMiddlewareInstance.context;
      }
      await next();
    }
  };
}

/**
 * 获取 Webpack Dev 中间件的输出文件系统
 *
 * 用于 SSR 开发模式下，从 Webpack 内存文件系统中读取服务端 bundle。
 *
 * @param devMiddleware - webpack-dev-middleware 实例
 * @returns 内存文件系统实例
 */
export function getDevMiddlewareFileSystem(devMiddleware: any): any {
  return devMiddleware?.outputFileSystem ?? null;
}
