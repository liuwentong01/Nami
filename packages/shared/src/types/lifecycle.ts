/**
 * @nami/shared - 生命周期钩子类型定义
 *
 * 汇总所有生命周期钩子的元信息定义。
 * 用于 HookRegistry 注册和管理钩子。
 */

import { HookType } from './plugin';
import type { HookDefinition } from './plugin';

/**
 * 所有框架生命周期钩子的定义
 *
 * 这份定义既作为类型文档，也用于运行时注册验证。
 * 每个钩子的 type 决定了执行模式（waterfall/parallel/bail）。
 */
export const HOOK_DEFINITIONS: Record<string, HookDefinition> = {
  // ==================== 构建阶段 ====================

  /** 修改 Webpack 配置（瀑布流：每个插件依次修改配置） */
  modifyWebpackConfig: {
    name: 'modifyWebpackConfig',
    type: HookType.Waterfall,
    stage: 'build',
  },

  /** 修改路由配置（瀑布流：每个插件依次修改路由表） */
  modifyRoutes: {
    name: 'modifyRoutes',
    type: HookType.Waterfall,
    stage: 'build',
  },

  /** 构建开始（并行：所有监听器同时执行） */
  onBuildStart: {
    name: 'onBuildStart',
    type: HookType.Parallel,
    stage: 'build',
  },

  /** 构建结束（并行） */
  onBuildEnd: {
    name: 'onBuildEnd',
    type: HookType.Parallel,
    stage: 'build',
  },

  // ==================== 服务端阶段 ====================

  /** 服务启动（并行） */
  onServerStart: {
    name: 'onServerStart',
    type: HookType.Parallel,
    stage: 'server',
  },

  /** 请求到达（并行：日志、埋点等） */
  onRequest: {
    name: 'onRequest',
    type: HookType.Parallel,
    stage: 'server',
  },

  /** 渲染前（并行：预处理、日志等） */
  onBeforeRender: {
    name: 'onBeforeRender',
    type: HookType.Parallel,
    stage: 'server',
  },

  /** 渲染后（并行：后处理、指标上报等） */
  onAfterRender: {
    name: 'onAfterRender',
    type: HookType.Parallel,
    stage: 'server',
  },

  /** 渲染错误（并行：错误上报、告警等） */
  onRenderError: {
    name: 'onRenderError',
    type: HookType.Parallel,
    stage: 'server',
  },

  // ==================== 客户端阶段 ====================

  /** 客户端初始化（并行：SDK 初始化等） */
  onClientInit: {
    name: 'onClientInit',
    type: HookType.Parallel,
    stage: 'client',
  },

  /** Hydration 完成（并行） */
  onHydrated: {
    name: 'onHydrated',
    type: HookType.Parallel,
    stage: 'client',
  },

  /** 包裹根组件（瀑布流：层层包裹） */
  wrapApp: {
    name: 'wrapApp',
    type: HookType.Waterfall,
    stage: 'client',
  },

  /** 路由变化（并行：页面埋点、统计等） */
  onRouteChange: {
    name: 'onRouteChange',
    type: HookType.Parallel,
    stage: 'client',
  },

  // ==================== 通用 ====================

  /** 统一错误处理（并行：多个错误处理器共存） */
  onError: {
    name: 'onError',
    type: HookType.Parallel,
    stage: 'common',
  },

  /** 插件销毁（并行：资源清理） */
  onDispose: {
    name: 'onDispose',
    type: HookType.Parallel,
    stage: 'common',
  },
};

/**
 * 获取所有钩子名称列表
 */
export const HOOK_NAMES = Object.keys(HOOK_DEFINITIONS);

/**
 * 按阶段分组的钩子名称
 */
export const HOOKS_BY_STAGE = {
  build: HOOK_NAMES.filter((name) => HOOK_DEFINITIONS[name]!.stage === 'build'),
  server: HOOK_NAMES.filter((name) => HOOK_DEFINITIONS[name]!.stage === 'server'),
  client: HOOK_NAMES.filter((name) => HOOK_DEFINITIONS[name]!.stage === 'client'),
  common: HOOK_NAMES.filter((name) => HOOK_DEFINITIONS[name]!.stage === 'common'),
};
