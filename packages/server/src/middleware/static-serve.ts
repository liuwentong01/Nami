/**
 * @nami/server - 静态资源服务中间件
 *
 * 为客户端构建产物（JS、CSS、图片等）提供静态文件服务。
 *
 * 功能特性：
 * 1. 基于 koa-static 提供静态文件服务
 * 2. 针对不同文件类型设置差异化的缓存策略：
 *    - 带 hash 的资源文件（如 main.abc123.js）：强缓存一年
 *    - 不带 hash 的资源文件（如 index.html）：协商缓存（no-cache）
 * 3. 支持 gzip/brotli 预压缩文件（如 main.js.gz、main.js.br）
 *
 * 缓存策略说明：
 * - immutable: 告知浏览器该资源永远不会变化，避免不必要的条件请求
 * - public: 允许 CDN 等中间代理缓存
 * - max-age: 浏览器缓存过期时间
 *
 * @example
 * ```typescript
 * import { staticServeMiddleware } from '@nami/server';
 *
 * // 使用默认配置
 * app.use(staticServeMiddleware());
 *
 * // 自定义静态资源目录
 * app.use(staticServeMiddleware({
 *   root: path.join(process.cwd(), 'dist/client'),
 * }));
 * ```
 */

import type Koa from 'koa';
import koaStatic from 'koa-static';
import path from 'path';

/**
 * 静态资源服务配置选项
 */
export interface StaticServeOptions {
  /**
   * 静态资源根目录
   * 默认: `${process.cwd()}/dist/client`
   */
  root?: string;

  /**
   * 带 hash 的资源最大缓存时间（秒）
   * 默认: 31536000（一年）
   */
  maxAge?: number;

  /**
   * 不带 hash 的资源最大缓存时间（秒）
   * 默认: 0（协商缓存）
   */
  htmlMaxAge?: number;

  /**
   * 是否启用 gzip 预压缩文件检测
   * 默认: true
   */
  gzip?: boolean;

  /**
   * 是否启用 brotli 预压缩文件检测
   * 默认: true
   */
  brotli?: boolean;

  /**
   * 是否在文件未找到时调用 next()
   * 默认: true（让后续中间件继续处理，如渲染中间件）
   */
  defer?: boolean;
}

/**
 * 用于匹配带内容哈希的文件名
 *
 * 匹配规则：
 * - 文件名中包含 8 位或以上十六进制字符的 hash 段
 * - 例如：main.abc12345.js、styles.9f8e7d6c.css
 *
 * 这类文件的 URL 会随内容变化而变化，因此可以安全地设置超长缓存。
 */
const HASHED_FILE_PATTERN = /\.[a-f0-9]{8,}\.\w+$/i;

/**
 * 创建静态资源服务中间件
 *
 * @param options - 配置选项（可选）
 * @returns Koa 中间件函数
 */
export function staticServeMiddleware(
  options: StaticServeOptions = {},
): Koa.Middleware {
  const {
    root = path.join(process.cwd(), 'dist', 'client'),
    maxAge = 31536000,  // 一年，用于带 hash 的资源
    htmlMaxAge = 0,     // 协商缓存，用于 HTML 等非 hash 资源
    gzip = true,
    brotli = true,
    defer = true,
  } = options;

  /**
   * 创建 koa-static 实例
   *
   * koa-static 内部使用 koa-send 发送文件，支持：
   * - ETag 计算（用于条件请求）
   * - Last-Modified 头（用于协商缓存）
   * - Range 请求（用于大文件断点续传）
   * - 安全路径校验（防止目录穿越攻击）
   */
  const staticMiddleware = koaStatic(root, {
    /**
     * 默认使用较短的缓存时间。
     * 带 hash 的文件会在下方的包装器中覆盖为更长的缓存时间。
     */
    maxage: htmlMaxAge * 1000, // koa-static 接受毫秒
    gzip,
    brotli,
    defer,
  });

  /**
   * 包装 koa-static 中间件，根据文件类型设置差异化缓存策略
   */
  return async (ctx: Koa.Context, next: Koa.Next): Promise<void> => {
    // 先执行 koa-static（defer 模式下会先执行 next 再检查文件）
    await staticMiddleware(ctx, next);

    /**
     * 如果 koa-static 成功匹配并发送了文件（状态码为 2xx），
     * 则根据文件名是否包含 hash 来设置缓存策略。
     */
    if (ctx.status >= 200 && ctx.status < 300 && ctx.path) {
      if (HASHED_FILE_PATTERN.test(ctx.path)) {
        /**
         * 带 hash 的资源文件 → 强缓存
         *
         * 这类文件的 URL 包含内容哈希（如 main.abc12345.js），
         * 文件内容变化时 URL 也会变化，因此可以安全地设置超长缓存。
         * immutable 指令告诉浏览器不需要发送条件请求来验证缓存。
         */
        ctx.set(
          'Cache-Control',
          `public, max-age=${maxAge}, immutable`,
        );
      } else {
        /**
         * 不带 hash 的资源文件 → 协商缓存
         *
         * 这类文件（如 index.html）的 URL 不会随内容变化，
         * 使用 no-cache 指令强制浏览器每次都发送条件请求验证。
         * 如果资源未变化，服务端返回 304 Not Modified。
         */
        ctx.set(
          'Cache-Control',
          'public, no-cache',
        );
      }
    }
  };
}
