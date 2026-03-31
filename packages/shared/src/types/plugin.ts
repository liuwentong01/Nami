/**
 * @nami/shared - 插件系统类型定义
 *
 * 框架的插件系统设计参考了 Vite 的插件模型，
 * 支持构建阶段、服务端阶段、客户端阶段的全生命周期钩子。
 *
 * 钩子执行模式：
 * - waterfall: 瀑布流模式，前一个钩子的输出是下一个的输入
 * - parallel:  并行模式，所有钩子并行执行
 * - bail:      短路模式，第一个返回非空值的钩子结果即为最终结果
 */

import type { RenderContext, RenderResult } from './context';
import type { NamiConfig } from './config';
import type { NamiRoute } from './route';
import type { Logger } from '../utils/logger';
import type Koa from 'koa';
import type { Configuration as WebpackConfiguration } from 'webpack';

/**
 * Nami 插件接口
 *
 * 所有插件必须实现此接口。插件通过 setup 方法注册钩子，
 * 框架在相应生命周期节点调用已注册的钩子。
 *
 * @example
 * ```typescript
 * const myPlugin: NamiPlugin = {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   enforce: 'pre',
 *   setup(api) {
 *     api.onBeforeRender(async (context) => {
 *       console.log(`开始渲染: ${context.url}`);
 *     });
 *   }
 * };
 * ```
 */
export interface NamiPlugin {
  /** 插件唯一名称 */
  name: string;

  /** 插件版本号 */
  version?: string;

  /**
   * 插件执行顺序控制
   * - 'pre':  在普通插件之前执行
   * - 'post': 在普通插件之后执行
   * - 不设置: 按注册顺序执行
   */
  enforce?: 'pre' | 'post';

  /**
   * 插件初始化方法
   * 框架在启动时调用此方法，插件在其中注册各种生命周期钩子
   *
   * @param api - 插件 API，提供钩子注册和框架能力访问
   */
  setup: (api: PluginAPI) => void | Promise<void>;
}

/**
 * 插件 API 接口
 *
 * 提供给插件的核心 API，包括：
 * - 构建阶段钩子注册
 * - 服务端阶段钩子注册
 * - 客户端阶段钩子注册
 * - 框架配置和日志访问
 */
export interface PluginAPI {
  // ==================== 构建阶段钩子 ====================

  /**
   * 修改 Webpack 配置
   * 钩子类型: waterfall
   * 允许插件在构建前修改 Webpack 配置
   *
   * @param fn - 配置修改函数
   */
  modifyWebpackConfig: (fn: WebpackConfigModifier) => void;

  /**
   * 修改路由配置
   * 钩子类型: waterfall
   * 允许插件动态添加、修改、删除路由
   *
   * @param fn - 路由修改函数
   */
  modifyRoutes: (fn: RouteModifier) => void;

  /**
   * 构建开始回调
   * 钩子类型: parallel
   */
  onBuildStart: (fn: BuildHook) => void;

  /**
   * 构建结束回调
   * 钩子类型: parallel
   */
  onBuildEnd: (fn: BuildHook) => void;

  // ==================== 服务端阶段钩子 ====================

  /**
   * 添加自定义 Koa 中间件
   * 中间件将被插入到错误隔离层和渲染层之间
   *
   * @param middleware - Koa 中间件函数
   */
  addServerMiddleware: (middleware: Koa.Middleware) => void;

  /**
   * 服务启动回调
   * 钩子类型: parallel
   */
  onServerStart: (fn: ServerStartHook) => void;

  /**
   * 请求到达回调
   * 钩子类型: parallel
   * 在路由匹配之前执行，可用于请求级埋点、日志等
   */
  onRequest: (fn: RequestHook) => void;

  /**
   * 渲染前回调
   * 钩子类型: parallel
   * 在数据预取和渲染执行之前调用
   */
  onBeforeRender: (fn: BeforeRenderHook) => void;

  /**
   * 渲染后回调
   * 钩子类型: parallel
   * 在渲染完成后调用，可用于结果后处理、指标采集等
   */
  onAfterRender: (fn: AfterRenderHook) => void;

  /**
   * 渲染错误回调
   * 钩子类型: parallel
   * 在渲染过程中发生错误时调用（降级前）
   */
  onRenderError: (fn: RenderErrorHook) => void;

  // ==================== 客户端阶段钩子 ====================

  /**
   * 客户端初始化回调
   * 钩子类型: parallel
   * 在 React 应用挂载之前执行
   */
  onClientInit: (fn: ClientInitHook) => void;

  /**
   * Hydration 完成回调
   * 钩子类型: parallel
   */
  onHydrated: (fn: HydratedHook) => void;

  /**
   * 包裹根组件
   * 钩子类型: waterfall
   * 允许插件用 Provider 等组件包裹应用根节点
   *
   * @example
   * ```typescript
   * api.wrapApp((app) => (
   *   <ThemeProvider theme={theme}>{app}</ThemeProvider>
   * ));
   * ```
   */
  wrapApp: (fn: AppWrapper) => void;

  /**
   * 路由变化回调
   * 钩子类型: parallel
   * 客户端路由切换时触发
   */
  onRouteChange: (fn: RouteChangeHook) => void;

  // ==================== 通用钩子 ====================

  /**
   * 统一错误处理
   * 钩子类型: parallel
   * 任何阶段的未捕获错误都会触发
   */
  onError: (fn: ErrorHandler) => void;

  /**
   * 插件销毁回调
   * 钩子类型: parallel
   * 在框架关闭或热更新时调用
   */
  onDispose: (fn: DisposeHook) => void;

  // ==================== 框架能力访问 ====================

  /** 获取当前框架配置（只读） */
  getConfig: () => Readonly<NamiConfig>;

  /** 获取日志实例 */
  getLogger: () => Logger;
}

// ==================== 钩子函数签名类型 ====================

/** Webpack 配置修改器 */
export type WebpackConfigModifier = (
  config: WebpackConfiguration,
  context: { isServer: boolean; isDev: boolean },
) => WebpackConfiguration | Promise<WebpackConfiguration>;

/** 路由修改器 */
export type RouteModifier = (routes: NamiRoute[]) => NamiRoute[] | Promise<NamiRoute[]>;

/** 构建生命周期钩子 */
export type BuildHook = () => void | Promise<void>;

/** 服务启动钩子 */
export type ServerStartHook = (info: { port: number; host: string }) => void | Promise<void>;

/** 请求钩子 */
export type RequestHook = (ctx: Koa.Context) => void | Promise<void>;

/** 渲染前钩子 */
export type BeforeRenderHook = (context: RenderContext) => void | Promise<void>;

/** 渲染后钩子 */
export type AfterRenderHook = (
  context: RenderContext,
  result: RenderResult,
) => void | Promise<void>;

/** 渲染错误钩子 */
export type RenderErrorHook = (context: RenderContext, error: Error) => void | Promise<void>;

/** 客户端初始化钩子 */
export type ClientInitHook = () => void | Promise<void>;

/** Hydration 完成钩子 */
export type HydratedHook = () => void | Promise<void>;

/** 应用包裹器 */
export type AppWrapper = (app: React.ReactElement) => React.ReactElement;

/** 路由变化钩子 */
export type RouteChangeHook = (info: {
  from: string;
  to: string;
  params: Record<string, string>;
}) => void | Promise<void>;

/** 统一错误处理器 */
export type ErrorHandler = (error: Error, context?: Record<string, unknown>) => void | Promise<void>;

/** 销毁钩子 */
export type DisposeHook = () => void | Promise<void>;

// ==================== 钩子注册表类型 ====================

/**
 * 钩子执行模式
 */
export enum HookType {
  /** 瀑布流: 前一个输出是后一个输入 */
  Waterfall = 'waterfall',
  /** 并行: 所有钩子并行执行 */
  Parallel = 'parallel',
  /** 短路: 第一个返回非空值的结果即为最终结果 */
  Bail = 'bail',
}

/**
 * 钩子定义
 * 用于钩子注册表中描述每个钩子的元信息
 */
export interface HookDefinition {
  /** 钩子名称 */
  name: string;
  /** 执行模式 */
  type: HookType;
  /** 钩子所属阶段 */
  stage: 'build' | 'server' | 'client' | 'common';
}
