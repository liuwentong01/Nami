/**
 * @nami/core - 包总入口
 *
 * Nami 框架核心运行时，包含：
 * - 渲染器抽象（CSR/SSR/SSG/ISR 统一接口）
 * - 插件系统（钩子注册、生命周期管理）
 * - 数据预取（服务端数据获取、序列化、React Context）
 * - 配置管理（加载、校验、合并）
 * - 错误处理（错误边界、多级降级）
 * - HTML 模板（文档结构、Head 管理、脚本注入）
 * - 路由管理（匹配、参数提取、懒加载）
 */

// 渲染器
export { RendererFactory } from './renderer';
export { BaseRenderer } from './renderer/base-renderer';
export { CSRRenderer } from './renderer/csr-renderer';
export { SSRRenderer } from './renderer/ssr-renderer';
export { SSGRenderer } from './renderer/ssg-renderer';
export { ISRRenderer } from './renderer/isr-renderer';
export type { ModuleLoaderLike } from './renderer/types';
export { StreamingSSRRenderer } from './renderer/streaming-ssr-renderer';

// 插件系统
export { PluginManager } from './plugin/plugin-manager';
export { HookRegistry } from './plugin/hook-registry';
export { PluginAPIImpl } from './plugin/plugin-api-impl';
export { PluginLoader } from './plugin/plugin-loader';

// 数据层
export { PrefetchManager } from './data/prefetch-manager';
export { NamiDataProvider, NamiDataContext } from './data/data-context';
export { useServerData } from './data/use-server-data';
export { DataSerializer } from './data/serializer';

// 配置
export { ConfigLoader } from './config/config-loader';
export { ConfigValidator } from './config/config-validator';
export { getDefaultConfig, defineConfig } from './config';

// 错误处理
export { ErrorHandler } from './error/error-handler';
export { NamiErrorBoundary } from './error/error-boundary';
export { DegradationManager } from './error/degradation';
export { ErrorReporter } from './error/error-reporter';

// HTML
export { DocumentTemplate } from './html/document';
export { HeadManager } from './html/head-manager';
export { ScriptInjector } from './html/script-injector';

// 模块加载器
export { ModuleLoader } from './module';
export type { ModuleLoaderOptions } from './module';

// 路由
export { RouteManager } from './router/route-manager';
export { RouteMatcher } from './router/route-matcher';
export { PathMatcher } from './router/path-matcher';
export { lazyRoute } from './router/lazy-route';

// 重新导出 @nami/shared 中常用的类型（便于业务方只引用 @nami/core）
export { RenderMode } from '@nami/shared';
export type {
  NamiConfig,
  UserNamiConfig,
  NamiPlugin,
  PluginAPI,
  NamiRoute,
  RenderContext,
  RenderResult,
} from '@nami/shared';
