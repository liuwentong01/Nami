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

import type { AssetManifest } from '../html/script-injector';

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

  /**
   * 模块加载器
   *
   * 用于从 server bundle 中加载页面组件模块，
   * 提取 getServerSideProps / getStaticProps / getStaticPaths 等导出函数。
   * SSR/SSG/ISR 渲染器需要此选项来解析数据预取函数。
   */
  moduleLoader?: ModuleLoaderLike;

  /**
   * 构建产物资源清单
   *
   * 从 asset-manifest.json 读取的实际资源路径映射。
   * 生产环境下文件名含 content hash，必须通过 manifest 获取真实路径，
   * 否则浏览器会请求到不存在的固定路径而导致白屏。
   */
  assetManifest?: AssetManifest;
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
   * 是否优先使用 Streaming SSR
   *
   * 仅在 mode 为 SSR 时生效，用于让 server 中间件按路由或请求级策略
   * 切换到 React 18 的流式渲染实现，同时保持 RenderMode 枚举不变。
   */
  preferStreaming?: boolean;

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

  /**
   * 服务端 HTML 渲染函数
   *
   * 这是对 `appElementFactory` 的兼容补充，主要用于接入
   * `entry-server.tsx` 中导出的 `renderToHTML(url, props)` 风格入口。
   *
   * 当业务侧尚未迁移到 React 元素工厂协议时，
   * 渲染器可以直接复用这个 HTML 入口，避免默认 SSR/ISR 链路断开。
   */
  htmlRenderer?: HTMLRenderer;

  /**
   * ISR 管理器实例
   *
   * 该字段保留给上层 server 中间件传递 ISR 运行时依赖。
   * 当前默认链路中，缓存命中/重验证由 server 侧缓存层统一处理，
   * core 内部的 ISRRenderer 只负责产出可缓存的 HTML。
   */
  isrManager?: ISRManagerLike;

  /**
   * 模块加载器实例
   *
   * 用于从编译后的 server bundle 中加载组件模块，
   * 获取 getServerSideProps / getStaticProps / getStaticPaths 等数据预取函数。
   * 可选，不传时渲染器会尝试直接 require 组件路径作为降级方案。
   */
  moduleLoader?: ModuleLoaderLike;
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
 * 服务端 HTML 渲染函数
 *
 * 输入是完整的渲染上下文和已预取的数据，
 * 输出既可以是页面主体 HTML 片段，也可以是完整 HTML 文档。
 * 渲染器会在运行时判断输出形态，并在需要时补齐外层文档壳。
 */
export type HTMLRenderer = (
  context: RenderContext,
  initialData: Record<string, unknown>,
) => Promise<string> | string;

/**
 * 插件管理器的最小接口
 *
 * 渲染器通过这个最小接口触发生命周期钩子。
 * 当前核心会优先调用兼容入口 `callHook()`，
 * 由 `PluginManager` 内部将旧钩子名映射到正式生命周期名称，
 * 避免渲染器层和插件层出现双协议分叉。
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
 * 这是 server 层 ISR 缓存中间件依赖的最小能力接口。
 * 为了避免 core 渲染器和 server 缓存层各自维护一套 ISR 协议，
 * 这里收敛为与 `packages/server/src/isr/isr-manager.ts` 一致的签名。
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
   * @param renderFn - 缓存未命中或后台重验证时使用的渲染函数
   * @param revalidateSeconds - 重验证间隔（秒）
   * @returns ISR 缓存结果
   */
  getOrRevalidate(
    key: string,
    renderFn: () => Promise<string>,
    revalidateSeconds: number,
  ): Promise<ISRCacheResult>;
}

/**
 * 模块加载器的最小接口
 *
 * 渲染器只需要加载模块和提取导出函数的能力。
 */
export interface ModuleLoaderLike {
  /**
   * 从模块中提取指定的导出函数
   */
  getExportedFunction<T extends (...args: any[]) => any>(
    componentPath: string,
    functionName: string,
  ): Promise<T | null>;

  /**
   * 加载指定组件路径的模块
   */
  loadModule(componentPath: string): Promise<Record<string, unknown>>;
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
