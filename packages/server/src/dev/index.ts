/**
 * @nami/server - 开发服务器导出入口
 *
 * 提供开发环境专用的服务器组件：
 *
 * - DevServer: 整合 Koa + Webpack 的开发服务器
 * - HMR Middleware: 热模块替换中间件（SSE 通道）
 * - Webpack Dev Middleware: Webpack 开发中间件（内存文件系统）
 *
 * 注意：这些模块仅在开发环境中使用，
 * 生产构建应该 tree-shake 掉这些模块以减小产物体积。
 */

// ===== 开发服务器 =====
export { createDevServer } from './dev-server';
export type { DevServerOptions, DevServer } from './dev-server';

// ===== HMR 中间件 =====
export { createHMRMiddleware } from './hmr-middleware';
export type { HMRMiddlewareOptions } from './hmr-middleware';

// ===== Webpack Dev 中间件 =====
export { createWebpackDevMiddleware, getDevMiddlewareFileSystem } from './webpack-dev';
export type { WebpackDevMiddlewareOptions } from './webpack-dev';
