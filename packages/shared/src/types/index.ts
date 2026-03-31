/**
 * @nami/shared - 类型定义总入口
 *
 * 统一导出所有类型定义，业务方和其他包只需从此处导入。
 */

// 渲染模式
export { RenderMode } from './render-mode';
export type { ISRFallbackStrategy, RenderModeConfig } from './render-mode';

// 路由
export type {
  NamiRoute,
  GetServerSidePropsContext,
  GetServerSidePropsResult,
  GetStaticPropsContext,
  GetStaticPropsResult,
  GetStaticPathsResult,
  RouteMatchResult,
} from './route';

// 插件系统
export { HookType } from './plugin';
export type {
  NamiPlugin,
  PluginAPI,
  HookDefinition,
  WebpackConfigModifier,
  RouteModifier,
  BuildHook,
  ServerStartHook,
  RequestHook,
  BeforeRenderHook,
  AfterRenderHook,
  RenderErrorHook,
  ClientInitHook,
  HydratedHook,
  AppWrapper,
  RouteChangeHook,
  ErrorHandler,
  DisposeHook,
} from './plugin';

// 渲染上下文
export type {
  KoaContextSubset,
  RenderTiming,
  RenderContext,
  RenderResult,
  RenderMeta,
  ClientOptions,
} from './context';

// 框架配置
export type {
  NamiConfig,
  UserNamiConfig,
  ServerConfig,
  WebpackCustomConfig,
  ISRConfig,
  MonitorConfig,
  FallbackConfig,
  AssetsConfig,
} from './config';

// 数据预取
export type {
  PrefetchResult,
  PrefetchDetail,
  PrefetchOptions,
  SerializeOptions,
} from './data-fetch';

// 缓存
export type {
  CacheEntry,
  CacheStore,
  ISRCacheResult,
  CacheStats,
  CacheOptions,
} from './cache';

// 错误
export {
  ErrorCode,
  ErrorSeverity,
  DegradationLevel,
  NamiError,
  RenderError,
  DataFetchError,
  ConfigError,
} from './error';

// 生命周期
export { HOOK_DEFINITIONS, HOOK_NAMES, HOOKS_BY_STAGE } from './lifecycle';
