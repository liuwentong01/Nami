/**
 * @nami/core - 插件管理器
 *
 * PluginManager 是插件系统的中央控制器，负责：
 * 1. 插件的注册与生命周期管理
 * 2. 钩子的调度执行（支持三种模式：waterfall、parallel、bail）
 * 3. 错误隔离（单个钩子失败不影响其他钩子）
 * 4. 服务端中间件的收集与管理
 * 5. 插件的销毁与清理
 *
 * 设计原则：
 * - 插件执行顺序：enforce='pre' -> 普通插件 -> enforce='post'
 * - 错误隔离：钩子执行中的异常会被捕获并记录，不会中断整个钩子链
 * - 可追踪性：所有钩子调用都带有插件来源信息，便于调试
 */

import {
  HookType,
  HOOK_DEFINITIONS,
  NamiError,
  ErrorCode,
  ErrorSeverity,
  createLogger,
} from '@nami/shared';
import type { NamiPlugin, NamiConfig, Logger } from '@nami/shared';
import type Koa from 'koa';
import { HookRegistry } from './hook-registry';
import { PluginAPIImpl } from './plugin-api-impl';
import type { MiddlewareEntry } from './plugin-api-impl';

// ==================== 类型定义 ====================

/**
 * 插件注册条目
 *
 * 存储每个已注册插件的完整信息，包括插件实例和对应的 API 实例。
 */
interface PluginEntry {
  /** 插件实例 */
  plugin: NamiPlugin;
  /** 该插件对应的 API 实例（用于收集中间件等） */
  api: PluginAPIImpl;
}

/**
 * enforce 排序优先级映射
 *
 * 用于对插件注册列表按 enforce 属性排序：
 * - pre:      0（最先初始化和执行）
 * - normal:   1（默认）
 * - post:     2（最后初始化和执行）
 */
const PLUGIN_ENFORCE_ORDER: Record<string, number> = {
  pre: 0,
  normal: 1,
  post: 2,
};

// ==================== PluginManager 类 ====================

/**
 * 插件管理器
 *
 * 框架核心模块之一，管理插件的完整生命周期。
 *
 * @example
 * ```typescript
 * const manager = new PluginManager(config, logger);
 *
 * // 注册插件
 * await manager.registerPlugin(monitorPlugin);
 * await manager.registerPlugin(cachePlugin);
 *
 * // 执行钩子
 * const finalConfig = await manager.runWaterfallHook(
 *   'modifyWebpackConfig',
 *   webpackConfig,
 *   { isServer: true, isDev: false },
 * );
 *
 * // 并行执行钩子
 * await manager.runParallelHook('onBeforeRender', renderContext);
 *
 * // 关闭时清理
 * await manager.dispose();
 * ```
 */
export class PluginManager {
  /** 已注册的插件映射表（按插件名称索引） */
  private readonly plugins: Map<string, PluginEntry> = new Map();

  /** 全局钩子注册表 */
  private readonly hookRegistry: HookRegistry;

  /** 框架配置 */
  private readonly config: NamiConfig;

  /** 日志实例 */
  private readonly logger: Logger;

  /** 是否已销毁 */
  private disposed: boolean = false;

  /**
   * 创建插件管理器
   *
   * @param config - 框架配置
   * @param logger - 日志实例（可选，默认创建内部 logger）
   */
  constructor(config: NamiConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? createLogger('@nami/plugin-manager');
    this.hookRegistry = new HookRegistry();
  }

  // ==================== 插件注册 ====================

  /**
   * 注册一个插件
   *
   * 注册流程：
   * 1. 校验插件合法性（name、setup 字段）
   * 2. 检查是否重复注册
   * 3. 创建该插件专属的 PluginAPI 实例
   * 4. 调用插件的 setup() 方法，让插件注册钩子
   *
   * @param plugin - 插件实例
   * @throws NamiError 当插件不合法或初始化失败时抛出错误
   */
  async registerPlugin(plugin: NamiPlugin): Promise<void> {
    // 检查管理器是否已销毁
    if (this.disposed) {
      throw new NamiError(
        '插件管理器已销毁，无法注册新插件',
        ErrorCode.PLUGIN_SETUP_FAILED,
        ErrorSeverity.Error,
        { pluginName: plugin.name },
      );
    }

    // 校验插件必要字段
    if (!plugin.name || typeof plugin.name !== 'string') {
      throw new NamiError(
        '插件缺少必要的 name 字段',
        ErrorCode.PLUGIN_LOAD_FAILED,
        ErrorSeverity.Error,
        { plugin: String(plugin) },
      );
    }

    if (typeof plugin.setup !== 'function') {
      throw new NamiError(
        `插件 [${plugin.name}] 缺少必要的 setup 方法`,
        ErrorCode.PLUGIN_LOAD_FAILED,
        ErrorSeverity.Error,
        { pluginName: plugin.name },
      );
    }

    // 检查是否重复注册
    if (this.plugins.has(plugin.name)) {
      this.logger.warn(
        `插件 [${plugin.name}] 已注册，跳过重复注册`,
        { pluginName: plugin.name },
      );
      return;
    }

    // 创建该插件专属的 API 实例
    const api = new PluginAPIImpl(
      this.hookRegistry,
      this.config,
      this.logger,
      plugin.name,
      plugin.enforce,
    );

    // 调用插件的 setup 方法
    try {
      this.logger.info(
        `正在初始化插件: ${plugin.name}${plugin.version ? ` v${plugin.version}` : ''}`,
        {
          pluginName: plugin.name,
          version: plugin.version,
          enforce: plugin.enforce ?? 'normal',
        },
      );

      await plugin.setup(api);

      // 注册成功，保存插件条目
      this.plugins.set(plugin.name, { plugin, api });

      this.logger.info(
        `插件 [${plugin.name}] 初始化完成`,
        { pluginName: plugin.name },
      );
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      throw new NamiError(
        `插件 [${plugin.name}] 初始化失败: ${errMessage}`,
        ErrorCode.PLUGIN_SETUP_FAILED,
        ErrorSeverity.Error,
        {
          pluginName: plugin.name,
          originalError: errMessage,
        },
      );
    }
  }

  /**
   * 批量注册插件
   *
   * 按照 enforce 属性排序后依次注册：
   * pre -> normal -> post
   *
   * @param plugins - 插件实例列表
   */
  async registerPlugins(plugins: NamiPlugin[]): Promise<void> {
    // 按 enforce 排序：pre -> normal -> post
    const sorted = [...plugins].sort((a, b) => {
      const orderA = PLUGIN_ENFORCE_ORDER[a.enforce ?? 'normal'] ?? 1;
      const orderB = PLUGIN_ENFORCE_ORDER[b.enforce ?? 'normal'] ?? 1;
      return orderA - orderB;
    });

    // 依次注册（保证顺序）
    for (const plugin of sorted) {
      await this.registerPlugin(plugin);
    }
  }

  // ==================== 钩子执行 ====================

  /**
   * 执行瀑布流钩子（Waterfall）
   *
   * 处理器按顺序执行，前一个的输出作为下一个的输入。
   * 最终返回经过所有处理器修改后的值。
   *
   * 适用场景：modifyWebpackConfig、modifyRoutes、wrapApp 等需要累积修改的钩子。
   *
   * 错误隔离：如果某个处理器执行失败，跳过该处理器，
   * 使用上一个处理器的输出继续传递给下一个处理器。
   *
   * @param hookName     - 钩子名称
   * @param initialValue - 初始值
   * @param args         - 额外参数，传递给每个处理器
   * @returns 经过所有处理器修改后的最终值
   */
  async runWaterfallHook<T>(
    hookName: string,
    initialValue: T,
    ...args: unknown[]
  ): Promise<T> {
    this.ensureNotDisposed(hookName);
    this.validateHookType(hookName, HookType.Waterfall);

    const handlers = this.hookRegistry.getHandlers(hookName);
    if (handlers.length === 0) {
      return initialValue;
    }

    this.logger.debug(
      `执行瀑布流钩子 [${hookName}]，共 ${handlers.length} 个处理器`,
      { hookName, handlerCount: handlers.length },
    );

    let currentValue: T = initialValue;

    for (const handler of handlers) {
      try {
        const result = await handler.fn(currentValue, ...args);

        // 瀑布流模式：如果处理器返回了非 undefined 的值，则更新当前值
        // 如果返回 undefined，保持上一个值（容错机制）
        if (result !== undefined) {
          currentValue = result as T;
        }
      } catch (error) {
        // 错误隔离：记录错误但不中断链路
        this.handleHookError(hookName, handler.pluginName, error);
      }
    }

    return currentValue;
  }

  /**
   * 执行并行钩子（Parallel）
   *
   * 所有处理器通过 Promise.all 并发执行，没有先后依赖。
   * 等待所有处理器完成后返回。
   *
   * 适用场景：onBeforeRender、onAfterRender、onBuildStart 等通知型钩子。
   *
   * 错误隔离：使用 Promise.allSettled 确保所有处理器都有机会执行，
   * 失败的处理器会被记录但不影响其他处理器。
   *
   * @param hookName - 钩子名称
   * @param args     - 传递给每个处理器的参数
   */
  async runParallelHook(hookName: string, ...args: unknown[]): Promise<void> {
    this.ensureNotDisposed(hookName);
    this.validateHookType(hookName, HookType.Parallel);

    const handlers = this.hookRegistry.getHandlers(hookName);
    if (handlers.length === 0) {
      return;
    }

    this.logger.debug(
      `执行并行钩子 [${hookName}]，共 ${handlers.length} 个处理器`,
      { hookName, handlerCount: handlers.length },
    );

    // 使用 allSettled 确保所有处理器都能执行
    const results = await Promise.allSettled(
      handlers.map(async (handler) => {
        try {
          await handler.fn(...args);
        } catch (error) {
          this.handleHookError(hookName, handler.pluginName, error);
          // 记录日志后仍需 re-throw，否则 allSettled 无法感知 rejected 状态
          throw error;
        }
      }),
    );

    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount > 0) {
      this.logger.warn(
        `并行钩子 [${hookName}] 中有 ${failedCount} 个处理器执行失败`,
        { hookName, failedCount, totalCount: handlers.length },
      );
    }
  }

  /**
   * 执行短路钩子（Bail）
   *
   * 处理器按顺序执行，第一个返回非 null/undefined 值的处理器结果
   * 即为最终结果，后续处理器不再执行。
   *
   * 适用场景：需要在多个处理器中选取第一个有效结果的情况。
   *
   * 错误隔离：如果某个处理器执行失败，跳过并继续下一个。
   *
   * @param hookName - 钩子名称
   * @param args     - 传递给每个处理器的参数
   * @returns 第一个非空结果，如果所有处理器都返回空值则返回 undefined
   */
  async runBailHook<T>(hookName: string, ...args: unknown[]): Promise<T | undefined> {
    this.ensureNotDisposed(hookName);
    this.validateHookType(hookName, HookType.Bail);

    const handlers = this.hookRegistry.getHandlers(hookName);
    if (handlers.length === 0) {
      return undefined;
    }

    this.logger.debug(
      `执行短路钩子 [${hookName}]，共 ${handlers.length} 个处理器`,
      { hookName, handlerCount: handlers.length },
    );

    for (const handler of handlers) {
      try {
        const result = await handler.fn(...args);

        // 短路模式：第一个返回非 null/undefined 值的结果即为最终结果
        if (result !== null && result !== undefined) {
          this.logger.debug(
            `短路钩子 [${hookName}] 被插件 [${handler.pluginName}] 短路`,
            { hookName, pluginName: handler.pluginName },
          );
          return result as T;
        }
      } catch (error) {
        // 错误隔离：记录错误，继续下一个处理器
        this.handleHookError(hookName, handler.pluginName, error);
      }
    }

    // 所有处理器都没有返回有效值
    return undefined;
  }

  /**
   * 兼容旧渲染器调用的统一钩子入口
   *
   * `BaseRenderer` 历史上通过 `callHook('beforeRender')` 之类的名称
   * 触发插件钩子，而插件系统当前的正式钩子名是
   * `onBeforeRender / onAfterRender / onRenderError`。
   *
   * 这里做一层名称适配，把旧调用统一映射到现有的 parallel hook，
   * 以最小改动打通 renderer -> pluginManager 的链路，
   * 同时不影响已经直接调用 `runParallelHook()` 的历史逻辑。
   */
  async callHook(hookName: string, ...args: unknown[]): Promise<void> {
    const hookAliasMap: Record<string, string> = {
      beforeRender: 'onBeforeRender',
      afterRender: 'onAfterRender',
      renderError: 'onRenderError',
      clientInit: 'onClientInit',
      hydrated: 'onHydrated',
      routeChange: 'onRouteChange',
      serverStart: 'onServerStart',
      buildStart: 'onBuildStart',
      buildEnd: 'onBuildEnd',
      error: 'onError',
      dispose: 'onDispose',
    };

    const resolvedHookName = hookAliasMap[hookName] ?? hookName;
    await this.runParallelHook(resolvedHookName, ...args);
  }

  // ==================== 中间件管理 ====================

  /**
   * 获取所有插件添加的服务端中间件
   *
   * 中间件按照插件的 enforce 顺序排列：
   * pre 插件的中间件 -> 普通插件的中间件 -> post 插件的中间件
   *
   * @returns Koa 中间件函数列表
   */
  getServerMiddlewares(): Koa.Middleware[] {
    const allMiddlewares: MiddlewareEntry[] = [];

    // 按照插件注册顺序收集中间件（注册时已按 enforce 排序）
    for (const [, entry] of this.plugins) {
      const middlewares = entry.api.getMiddlewares();
      allMiddlewares.push(...middlewares);
    }

    this.logger.debug(
      `收集到 ${allMiddlewares.length} 个服务端中间件`,
      {
        middlewares: allMiddlewares.map((m) => ({
          pluginName: m.pluginName,
        })),
      },
    );

    return allMiddlewares.map((entry) => entry.middleware);
  }

  // ==================== 生命周期管理 ====================

  /**
   * 销毁插件管理器
   *
   * 执行所有插件的 onDispose 钩子，清理内部状态。
   * 销毁后不可再注册插件或执行钩子。
   *
   * 注意：dispose 钩子的执行也有错误隔离，确保所有插件都有机会清理资源。
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      this.logger.warn('插件管理器已经销毁，忽略重复调用');
      return;
    }

    this.logger.info('开始销毁插件管理器...');

    // 执行所有 onDispose 钩子（绕过 disposed 检查）
    const handlers = this.hookRegistry.getHandlers('onDispose');
    if (handlers.length > 0) {
      const results = await Promise.allSettled(
        handlers.map(async (handler) => {
          try {
            await handler.fn();
          } catch (error) {
            this.handleHookError('onDispose', handler.pluginName, error);
            throw error;
          }
        }),
      );

      const failedCount = results.filter((r) => r.status === 'rejected').length;
      if (failedCount > 0) {
        this.logger.warn(
          `销毁过程中有 ${failedCount} 个 onDispose 处理器执行失败`,
          { failedCount },
        );
      }
    }

    // 清理内部状态
    this.hookRegistry.clear();
    this.plugins.clear();
    this.disposed = true;

    this.logger.info('插件管理器已销毁');
  }

  // ==================== 查询方法 ====================

  /**
   * 获取已注册的插件列表
   *
   * @returns 插件实例列表
   */
  getRegisteredPlugins(): NamiPlugin[] {
    return Array.from(this.plugins.values()).map((entry) => entry.plugin);
  }

  /**
   * 检查指定插件是否已注册
   *
   * @param pluginName - 插件名称
   * @returns 是否已注册
   */
  hasPlugin(pluginName: string): boolean {
    return this.plugins.has(pluginName);
  }

  /**
   * 获取已注册的插件数量
   */
  getPluginCount(): number {
    return this.plugins.size;
  }

  /**
   * 获取钩子注册表的统计信息
   *
   * 用于调试和监控。
   *
   * @returns 钩子注册统计
   */
  getHookStats(): Record<string, number> {
    return this.hookRegistry.getStats();
  }

  /**
   * 检查管理器是否已销毁
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ==================== 私有方法 ====================

  /**
   * 确保管理器未被销毁
   *
   * @param hookName - 当前操作的钩子名称（用于错误信息）
   * @throws NamiError 当管理器已销毁时抛出
   */
  private ensureNotDisposed(hookName: string): void {
    if (this.disposed) {
      throw new NamiError(
        `插件管理器已销毁，无法执行钩子 [${hookName}]`,
        ErrorCode.PLUGIN_HOOK_FAILED,
        ErrorSeverity.Error,
        { hookName },
      );
    }
  }

  /**
   * 验证钩子执行类型是否匹配
   *
   * 确保以正确的执行模式调用钩子。
   * 例如：不应用 runParallelHook 执行一个 waterfall 类型的钩子。
   *
   * @param hookName     - 钩子名称
   * @param expectedType - 期望的钩子类型
   */
  private validateHookType(hookName: string, expectedType: HookType): void {
    const definition = HOOK_DEFINITIONS[hookName];

    if (!definition) {
      this.logger.warn(
        `尝试执行未定义的钩子: ${hookName}`,
        { hookName, expectedType },
      );
      return;
    }

    if (definition.type !== expectedType) {
      this.logger.warn(
        `钩子 [${hookName}] 的类型为 ${definition.type}，` +
        `但当前以 ${expectedType} 模式调用。请检查调用是否正确。`,
        { hookName, definedType: definition.type, calledType: expectedType },
      );
    }
  }

  /**
   * 统一的钩子错误处理
   *
   * 记录错误日志但不抛出异常，确保钩子链的执行不被中断。
   * 同时触发 onError 钩子（如果有注册的话），但不递归触发以避免死循环。
   *
   * @param hookName   - 钩子名称
   * @param pluginName - 出错的插件名称
   * @param error      - 错误对象
   */
  private handleHookError(hookName: string, pluginName: string, error: unknown): void {
    const errMessage = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;

    this.logger.error(
      `钩子 [${hookName}] 在插件 [${pluginName}] 中执行失败: ${errMessage}`,
      {
        hookName,
        pluginName,
        error: errMessage,
        stack: errStack,
      },
    );

    // 触发 onError 钩子通知其他插件（避免递归：不在 onError 钩子失败时再触发 onError）
    if (hookName !== 'onError') {
      const errorHandlers = this.hookRegistry.getHandlers('onError');
      if (errorHandlers.length > 0) {
        // 异步触发错误处理器，但不等待其完成（避免阻塞主流程）
        const namiError = error instanceof NamiError
          ? error
          : new NamiError(
              errMessage,
              ErrorCode.PLUGIN_HOOK_FAILED,
              ErrorSeverity.Warning,
              { hookName, pluginName },
            );

        // 使用 void 表明我们有意不等待这个 Promise
        void Promise.allSettled(
          errorHandlers.map(async (handler) => {
            try {
              await handler.fn(namiError, { hookName, pluginName });
            } catch {
              // onError 处理器本身失败，仅记录日志，不再递归
              this.logger.error(
                `onError 处理器 [${handler.pluginName}] 执行失败`,
                { pluginName: handler.pluginName },
              );
            }
          }),
        );
      }
    }
  }
}
