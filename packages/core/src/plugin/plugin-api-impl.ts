/**
 * @nami/core - 插件 API 实现
 *
 * PluginAPIImpl 是 PluginAPI 接口的具体实现，
 * 框架在调用每个插件的 setup() 方法时，会传入一个 PluginAPIImpl 实例。
 *
 * 每个插件获得独立的 PluginAPIImpl 实例，因此：
 * 1. 可以准确追踪每个钩子是由哪个插件注册的
 * 2. 可以准确追踪每个中间件是由哪个插件添加的
 * 3. 在插件卸载时可以精确清理对应资源
 *
 * 设计要点：
 * - 所有钩子注册方法都委托给 HookRegistry
 * - addServerMiddleware 收集的中间件存储在独立列表中
 * - getConfig 返回只读配置，防止插件篡改全局配置
 * - getLogger 返回带有插件前缀的日志实例
 */

import type {
  PluginAPI,
  NamiConfig,
  Logger,
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
} from '@nami/shared';
import type Koa from 'koa';
import type { HookRegistry } from './hook-registry';

// ==================== 类型定义 ====================

/**
 * 服务端中间件条目
 *
 * 记录中间件及其来源插件，便于调试和卸载。
 */
export interface MiddlewareEntry {
  /** Koa 中间件函数 */
  middleware: Koa.Middleware;
  /** 添加此中间件的插件名称 */
  pluginName: string;
}

// ==================== PluginAPIImpl 类 ====================

/**
 * 插件 API 实现类
 *
 * 实现 PluginAPI 接口，为插件提供钩子注册和框架能力访问。
 * 每个插件实例拥有独立的 PluginAPIImpl，确保来源可追踪。
 *
 * @example
 * ```typescript
 * // 框架内部使用（插件不直接实例化此类）
 * const api = new PluginAPIImpl(registry, config, logger, 'my-plugin');
 * await plugin.setup(api);
 *
 * // 获取该插件添加的中间件
 * const middlewares = api.getMiddlewares();
 * ```
 */
export class PluginAPIImpl implements PluginAPI {
  /** 钩子注册表引用 */
  private readonly hookRegistry: HookRegistry;

  /** 框架配置（只读） */
  private readonly config: NamiConfig;

  /** 日志实例 */
  private readonly logger: Logger;

  /** 当前插件名称 */
  private readonly pluginName: string;

  /** 当前插件的 enforce 属性，用于钩子排序 */
  private readonly enforce?: 'pre' | 'post';

  /** 该插件添加的服务端中间件列表 */
  private readonly middlewares: MiddlewareEntry[] = [];

  /**
   * 创建插件 API 实例
   *
   * @param hookRegistry - 全局钩子注册表
   * @param config       - 框架配置
   * @param logger       - 日志实例
   * @param pluginName   - 当前插件名称
   * @param enforce      - 插件的 enforce 属性
   */
  constructor(
    hookRegistry: HookRegistry,
    config: NamiConfig,
    logger: Logger,
    pluginName: string,
    enforce?: 'pre' | 'post',
  ) {
    this.hookRegistry = hookRegistry;
    this.config = config;
    this.logger = logger;
    this.pluginName = pluginName;
    this.enforce = enforce;
  }

  // ==================== 构建阶段钩子 ====================

  /**
   * 注册 Webpack 配置修改钩子
   * 钩子类型: waterfall - 每个插件依次修改配置
   */
  modifyWebpackConfig(fn: WebpackConfigModifier): void {
    this.registerHook('modifyWebpackConfig', fn);
  }

  /**
   * 注册路由修改钩子
   * 钩子类型: waterfall - 每个插件依次修改路由表
   */
  modifyRoutes(fn: RouteModifier): void {
    this.registerHook('modifyRoutes', fn);
  }

  /**
   * 注册构建开始回调
   * 钩子类型: parallel - 所有处理器并行执行
   */
  onBuildStart(fn: BuildHook): void {
    this.registerHook('onBuildStart', fn);
  }

  /**
   * 注册构建结束回调
   * 钩子类型: parallel
   */
  onBuildEnd(fn: BuildHook): void {
    this.registerHook('onBuildEnd', fn);
  }

  // ==================== 服务端阶段钩子 ====================

  /**
   * 添加自定义 Koa 中间件
   *
   * 中间件将被插入到 Koa 应用的错误隔离层和渲染层之间。
   * 中间件的执行顺序取决于插件的注册顺序和 enforce 属性。
   *
   * @param middleware - Koa 中间件函数
   */
  addServerMiddleware(middleware: Koa.Middleware): void {
    if (typeof middleware !== 'function') {
      this.logger.warn(
        `插件 [${this.pluginName}] 添加了非函数类型的中间件，已忽略`,
        { pluginName: this.pluginName },
      );
      return;
    }

    this.middlewares.push({
      middleware,
      pluginName: this.pluginName,
    });

    this.logger.debug(
      `插件 [${this.pluginName}] 添加了一个服务端中间件`,
      { pluginName: this.pluginName, totalMiddlewares: this.middlewares.length },
    );
  }

  /**
   * 注册服务启动回调
   * 钩子类型: parallel
   */
  onServerStart(fn: ServerStartHook): void {
    this.registerHook('onServerStart', fn);
  }

  /**
   * 注册请求到达回调
   * 钩子类型: parallel - 在路由匹配之前执行
   */
  onRequest(fn: RequestHook): void {
    this.registerHook('onRequest', fn);
  }

  /**
   * 注册渲染前回调
   * 钩子类型: parallel - 在数据预取和渲染之前执行
   */
  onBeforeRender(fn: BeforeRenderHook): void {
    this.registerHook('onBeforeRender', fn);
  }

  /**
   * 注册渲染后回调
   * 钩子类型: parallel - 在渲染完成后执行
   */
  onAfterRender(fn: AfterRenderHook): void {
    this.registerHook('onAfterRender', fn);
  }

  /**
   * 注册渲染错误回调
   * 钩子类型: parallel - 在渲染发生错误时触发
   */
  onRenderError(fn: RenderErrorHook): void {
    this.registerHook('onRenderError', fn);
  }

  // ==================== 客户端阶段钩子 ====================

  /**
   * 注册客户端初始化回调
   * 钩子类型: parallel - 在 React 应用挂载前执行
   */
  onClientInit(fn: ClientInitHook): void {
    this.registerHook('onClientInit', fn);
  }

  /**
   * 注册 Hydration 完成回调
   * 钩子类型: parallel
   */
  onHydrated(fn: HydratedHook): void {
    this.registerHook('onHydrated', fn);
  }

  /**
   * 注册根组件包裹钩子
   * 钩子类型: waterfall - 层层包裹应用根节点
   */
  wrapApp(fn: AppWrapper): void {
    this.registerHook('wrapApp', fn);
  }

  /**
   * 注册路由变化回调
   * 钩子类型: parallel - 客户端路由切换时触发
   */
  onRouteChange(fn: RouteChangeHook): void {
    this.registerHook('onRouteChange', fn);
  }

  // ==================== 通用钩子 ====================

  /**
   * 注册统一错误处理器
   * 钩子类型: parallel - 任何阶段的未捕获错误都会触发
   */
  onError(fn: ErrorHandler): void {
    this.registerHook('onError', fn);
  }

  /**
   * 注册插件销毁回调
   * 钩子类型: parallel - 在框架关闭或热更新时调用
   */
  onDispose(fn: DisposeHook): void {
    this.registerHook('onDispose', fn);
  }

  // ==================== 框架能力访问 ====================

  /**
   * 获取当前框架配置
   *
   * 返回只读配置对象，插件不应直接修改配置。
   * 如需修改配置，请使用对应的 modify* 钩子。
   *
   * @returns 冻结的框架配置对象
   */
  getConfig(): Readonly<NamiConfig> {
    return Object.freeze({ ...this.config });
  }

  /**
   * 获取日志实例
   *
   * 返回带有当前插件名称标记的日志实例，
   * 便于在日志中区分不同插件的输出。
   *
   * @returns 带插件前缀的 Logger 实例
   */
  getLogger(): Logger {
    return this.logger.child({ plugin: this.pluginName });
  }

  // ==================== 内部方法（供 PluginManager 使用） ====================

  /**
   * 获取该插件添加的所有中间件
   *
   * @returns 中间件条目列表
   */
  getMiddlewares(): MiddlewareEntry[] {
    return [...this.middlewares];
  }

  /**
   * 获取该 API 实例对应的插件名称
   *
   * @returns 插件名称
   */
  getPluginName(): string {
    return this.pluginName;
  }

  // ==================== 私有方法 ====================

  /**
   * 通用钩子注册方法
   *
   * 将处理函数注册到全局钩子注册表中，
   * 自动关联当前插件名称和 enforce 属性。
   *
   * 注意：此处使用 Function 类型是有意为之，
   * 因为各钩子的函数签名各不相同，无法用统一的泛型约束。
   * 类型安全由各个公开方法的参数类型保证。
   *
   * @param hookName - 钩子名称
   * @param fn       - 处理函数
   */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private registerHook(hookName: string, fn: Function): void {
    this.hookRegistry.register(
      hookName,
      fn as (...args: unknown[]) => unknown,
      this.pluginName,
      this.enforce,
    );

    this.logger.debug(
      `插件 [${this.pluginName}] 注册了钩子: ${hookName}`,
      { pluginName: this.pluginName, hookName, enforce: this.enforce ?? 'normal' },
    );
  }
}
