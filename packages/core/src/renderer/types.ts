/**
 * @nami/core - 渲染器层类型定义
 *
 * 本文件定义渲染器层专属的类型，与 @nami/shared 中的通用类型互补。
 *
 * 设计原则：
 * - @nami/shared 中的类型是跨包共享的"公共契约"
 * - 本文件中的类型仅在 @nami/core 渲染器模块内部使用
 * - 对外暴露的接口尽量精简，降低包间耦合
 */

import type {
  NamiConfig,
  NamiPlugin,
  RenderMode,
  RenderContext,
  RenderResult,
  PrefetchResult,
  CacheStore,
  ISRCacheResult,
} from '@nami/shared';

// ==================== 渲染器配置 ====================

/**
 * 渲染器配置选项
 *
 * 创建渲染器实例时的核心配置。每个渲染器都需要框架主配置，
 * 部分渲染器还需要插件管理器引用来触发渲染生命周期钩子。
 *
 * @example
 * ```typescript
 * const options: RendererOptions = {
 *   config: namiConfig,
 *   pluginManager: pluginManagerInstance,
 * };
 * const renderer = new SSRRenderer(options);
 * ```
 */
export interface RendererOptions {
  /** Nami 框架主配置（必须是完整的合并后配置，非 UserNamiConfig） */
  config: NamiConfig;

  /**
   * 插件管理器引用
   *
   * 渲染器通过插件管理器触发 beforeRender / afterRender / renderError 等钩子。
   * 这里使用宽松的接口类型而非具体类，避免 core 模块内部产生循环依赖。
   *
   * 如果不传则跳过插件钩子调用（适用于单元测试或纯静态场景）。
   */
  pluginManager?: PluginManagerLike;
}

/**
 * 创建渲染器的工厂选项
 *
 * 扩展了 RendererOptions，增加了模式选择和 ISR 特有配置。
 * 供 RendererFactory.create() 方法使用。
 */
export interface CreateRendererOptions extends RendererOptions {
  /** 目标渲染模式 — 决定工厂返回哪种渲染器实例 */
  mode: RenderMode;

  /**
   * ISR 缓存存储实例
   * 仅在 mode 为 ISR 时需要提供。
   * 如果不传，ISRRenderer 将使用内存缓存作为后备。
   */
  cacheStore?: CacheStore;

  /**
   * SSR 渲染时的 React 组件树工厂函数
   *
   * 由业务入口提供，渲染器调用它获取待渲染的 React 元素树。
   * 仅 SSR 和 ISR 模式需要此选项。
   *
   * @param context - 当前渲染上下文
   * @returns React 元素（JSX 树的根节点）
   */
  appElementFactory?: AppElementFactory;
}

// ==================== 辅助类型 ====================

/**
 * React 组件树工厂函数
 *
 * 接收渲染上下文，返回可被 renderToString 处理的 React 元素。
 * 这是 SSR/ISR 渲染器与业务 React 代码的桥梁。
 *
 * 使用 React.ReactElement 类型需要 @types/react，
 * 这里使用 unknown 来避免强制依赖 React 类型包，
 * 实际传入时由调用方保证类型安全。
 */
export type AppElementFactory = (context: RenderContext) => unknown;

/**
 * 插件管理器的最小接口
 *
 * 渲染器只需要调用插件管理器的 callHook 方法，
 * 因此这里只声明渲染器实际需要的最小接口，
 * 避免引入完整的 PluginManager 类型产生循环依赖。
 */
export interface PluginManagerLike {
  /**
   * 调用指定生命周期钩子
   *
   * @param hookName - 钩子名称（如 'beforeRender'、'afterRender'、'renderError'）
   * @param args - 传递给钩子函数的参数
   */
  callHook(hookName: string, ...args: unknown[]): Promise<void>;
}

/**
 * ISR 管理器接口
 *
 * ISRRenderer 依赖此接口完成缓存查询和后台重验证。
 * 具体实现由 @nami/core 的缓存模块提供。
 */
export interface ISRManagerLike {
  /**
   * 获取缓存或触发重验证
   *
   * 实现 stale-while-revalidate 语义：
   * 1. 缓存命中且未过期 → 直接返回
   * 2. 缓存命中但已过期 → 返回旧内容，同时后台触发重新渲染
   * 3. 缓存未命中 → 阻塞渲染并缓存结果
   *
   * @param key - 缓存键（通常是请求路径）
   * @param revalidate - 重验证间隔（秒）
   * @returns ISR 缓存结果
   */
  getOrRevalidate(key: string, revalidate: number): Promise<ISRCacheResult | null>;

  /**
   * 将渲染结果写入缓存
   *
   * @param key - 缓存键
   * @param html - HTML 内容
   * @param revalidate - 重验证间隔（秒）
   * @param tags - 缓存标签（用于按标签失效）
   */
  set(key: string, html: string, revalidate: number, tags?: string[]): Promise<void>;

  /**
   * 触发后台重验证
   *
   * 异步执行，不阻塞当前请求。
   * 重验证完成后自动更新缓存。
   *
   * @param key - 缓存键
   * @param renderFn - 重新渲染的函数
   */
  scheduleRevalidation(key: string, renderFn: () => Promise<string>): void;
}

/**
 * 静态文件读取器接口
 *
 * SSGRenderer 通过此接口读取构建时生成的静态 HTML 文件，
 * 使用接口而非直接调用 fs，便于测试和自定义存储后端。
 */
export interface StaticFileReader {
  /**
   * 读取指定路径的静态文件内容
   *
   * @param filePath - 文件绝对路径
   * @returns 文件内容字符串，文件不存在时返回 null
   */
  readFile(filePath: string): Promise<string | null>;

  /**
   * 检查指定路径的静态文件是否存在
   *
   * @param filePath - 文件绝对路径
   */
  exists(filePath: string): Promise<boolean>;
}
