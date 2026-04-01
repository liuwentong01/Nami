/**
 * @nami/core - 渲染器抽象基类
 *
 * BaseRenderer 是所有渲染器（CSR / SSR / SSG / ISR）的公共父类，
 * 定义了统一的渲染契约和可复用的基础设施：
 *
 * 1. **统一契约**：render() / prefetchData() / getMode() 三个抽象方法，
 *    确保所有渲染器对外暴露一致的 API，调用方无需关心具体实现。
 *
 * 2. **降级链**：createFallbackRenderer() 方法构建渲染器降级链：
 *    SSR → CSR, SSG → CSR, ISR → CSR
 *    当高级渲染模式失败时，自动沿降级链尝试下一个渲染器。
 *
 * 3. **基础设施**：
 *    - 性能计时（RenderTiming）的创建和填充
 *    - 标准 RenderResult 的构造
 *    - 统一的日志实例
 *    - 插件钩子的触发
 *
 * 设计决策：
 * - 使用抽象类而非接口，因为需要提供通用实现代码（模板方法模式）
 * - config 作为 protected 属性，子类可直接访问但外部不可
 * - 日志前缀自动携带渲染模式，方便问题排查
 */

import type {
  NamiConfig,
  RenderMode,
  RenderContext,
  RenderResult,
  RenderMeta,
  RenderTiming,
  PrefetchResult,
} from '@nami/shared';
import {
  createLogger,
  createTimer,
  Logger,
} from '@nami/shared';

import type { RendererOptions, PluginManagerLike } from './types';
import type { AssetManifest } from '../html/script-injector';
import { ScriptInjector } from '../html/script-injector';

/**
 * 渲染器抽象基类
 *
 * 所有渲染模式的具体实现都必须继承此类并实现三个抽象方法：
 * - render(): 执行渲染并返回 RenderResult
 * - prefetchData(): 执行数据预取
 * - getMode(): 返回当前渲染模式标识
 *
 * @example
 * ```typescript
 * class MyRenderer extends BaseRenderer {
 *   async render(context: RenderContext): Promise<RenderResult> { ... }
 *   async prefetchData(context: RenderContext): Promise<PrefetchResult> { ... }
 *   getMode(): RenderMode { return RenderMode.CSR; }
 * }
 * ```
 */
export abstract class BaseRenderer {
  /** 框架主配置（只读，子类可访问） */
  protected readonly config: NamiConfig;

  /** 日志实例（子类可直接使用，前缀已包含渲染模式） */
  protected readonly logger: Logger;

  /** 插件管理器引用（可选，未提供时跳过钩子调用） */
  protected readonly pluginManager?: PluginManagerLike;

  /** 构建产物资源清单 — 从 asset-manifest.json 中读取 */
  protected readonly assetManifest?: AssetManifest;

  /** 脚本注入器 — 基于 manifest 生成正确的 JS/CSS 标签 */
  protected readonly scriptInjector: ScriptInjector;

  /**
   * @param options - 渲染器配置选项
   */
  constructor(options: RendererOptions) {
    this.config = options.config;
    this.pluginManager = options.pluginManager;
    this.assetManifest = options.assetManifest;
    this.scriptInjector = new ScriptInjector(options.config.assets.publicPath);

    // 创建带渲染模式前缀的日志实例，方便在日志中区分不同渲染器的输出
    this.logger = createLogger(`@nami/renderer:${this.getMode()}`);
  }

  // ==================== 抽象方法（子类必须实现） ====================

  /**
   * 执行渲染
   *
   * 将 RenderContext 转化为完整的 RenderResult，
   * 包含 HTML 字符串、HTTP 状态码、响应头和渲染元信息。
   *
   * 子类实现时应注意：
   * 1. 正确填充 timing 信息（使用 createRenderTiming）
   * 2. 捕获渲染异常并抛出 RenderError
   * 3. 设置合适的 Cache-Control 头
   *
   * @param context - 渲染上下文（包含 URL、路由、请求头等信息）
   * @returns 渲染结果
   * @throws {RenderError} 渲染失败时抛出
   */
  abstract render(context: RenderContext): Promise<RenderResult>;

  /**
   * 执行数据预取
   *
   * 在渲染之前获取页面所需的数据。
   * 不同渲染模式的数据预取策略不同：
   * - CSR: 返回空数据（客户端自行获取）
   * - SSR: 每次请求执行 getServerSideProps
   * - SSG: 构建时执行 getStaticProps
   * - ISR: 重验证时执行 getStaticProps
   *
   * @param context - 渲染上下文
   * @returns 预取结果（包含数据、错误信息和耗时）
   */
  abstract prefetchData(context: RenderContext): Promise<PrefetchResult>;

  /**
   * 返回当前渲染器的渲染模式
   *
   * 用于日志标识、监控上报和降级决策。
   */
  abstract getMode(): RenderMode;

  // ==================== 可覆写方法 ====================

  /**
   * 创建降级渲染器
   *
   * 当当前渲染器执行失败时，返回一个降级渲染器继续尝试。
   * 构成降级链：SSR → CSR, SSG → CSR, ISR → CSR, CSR → null（终点）
   *
   * 默认返回 null 表示没有进一步的降级方案。
   * SSR / SSG / ISR 渲染器应覆写此方法返回 CSRRenderer 实例。
   *
   * @returns 降级渲染器实例，或 null 表示无法进一步降级
   */
  createFallbackRenderer(): BaseRenderer | null {
    return null;
  }

  // ==================== 受保护的工具方法（子类使用） ====================

  /**
   * 创建渲染性能计时对象
   *
   * 初始化一个包含起始时间的 RenderTiming 结构，
   * 子类在渲染流程的各个阶段填充对应的时间戳。
   *
   * @returns 初始化后的 RenderTiming 对象
   *
   * @example
   * ```typescript
   * const timing = this.createRenderTiming();
   * timing.dataFetchStart = Date.now();
   * // ... 执行数据预取 ...
   * timing.dataFetchEnd = Date.now();
   * ```
   */
  protected createRenderTiming(): RenderTiming {
    return {
      startTime: Date.now(),
    };
  }

  /**
   * 构造标准的渲染结果对象
   *
   * 封装了 RenderResult 的创建逻辑，确保所有渲染器返回格式一致的结果。
   * 自动计算渲染总耗时、填充渲染元信息。
   *
   * @param html - 渲染产出的 HTML 字符串
   * @param statusCode - HTTP 响应状态码
   * @param mode - 实际使用的渲染模式
   * @param timing - 性能计时对象
   * @param options - 可选的额外配置
   * @returns 标准格式的 RenderResult
   */
  protected createDefaultResult(
    html: string,
    statusCode: number,
    mode: RenderMode,
    timing?: RenderTiming,
    options?: {
      /** 自定义响应头 */
      headers?: Record<string, string>;
      /** 是否经历了降级处理 */
      degraded?: boolean;
      /** 降级原因 */
      degradeReason?: string;
      /** 缓存控制配置 */
      cacheControl?: RenderResult['cacheControl'];
      /** 是否命中 ISR 缓存 */
      cacheHit?: boolean;
      /** ISR 缓存是否过期 */
      cacheStale?: boolean;
    },
  ): RenderResult {
    const now = Date.now();
    const effectiveTiming = timing ?? this.createRenderTiming();

    // 计算总耗时
    const duration = now - effectiveTiming.startTime;
    effectiveTiming.duration = duration;

    // 计算数据预取耗时
    const dataFetchDuration =
      effectiveTiming.dataFetchStart && effectiveTiming.dataFetchEnd
        ? effectiveTiming.dataFetchEnd - effectiveTiming.dataFetchStart
        : 0;

    // 计算 React 渲染耗时
    const renderDuration =
      effectiveTiming.renderStart && effectiveTiming.renderEnd
        ? effectiveTiming.renderEnd - effectiveTiming.renderStart
        : undefined;

    // 组装渲染元信息
    const meta: RenderMeta = {
      renderMode: mode,
      duration,
      degraded: options?.degraded ?? false,
      degradeReason: options?.degradeReason,
      dataFetchDuration,
      renderDuration,
      cacheHit: options?.cacheHit,
      cacheStale: options?.cacheStale,
    };

    return {
      html,
      statusCode,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // 注入渲染模式响应头，便于调试和 CDN 识别
        'X-Nami-Render-Mode': mode,
        // 注入渲染耗时响应头，便于性能监控
        'X-Nami-Render-Duration': String(duration),
        ...options?.headers,
      },
      cacheControl: options?.cacheControl,
      meta,
    };
  }

  /**
   * 触发插件钩子
   *
   * 安全地调用插件管理器的 callHook 方法。
   * 如果插件管理器未配置或钩子执行异常，仅打印警告日志，
   * 不会阻断渲染流程（插件不应影响核心渲染稳定性）。
   *
   * @param hookName - 钩子名称
   * @param args - 传递给钩子的参数
   */
  protected async callPluginHook(hookName: string, ...args: unknown[]): Promise<void> {
    if (!this.pluginManager) return;

    try {
      await this.pluginManager.callHook(hookName, ...args);
    } catch (error) {
      // 插件钩子执行失败不应阻断渲染流程
      this.logger.warn(`插件钩子 [${hookName}] 执行失败，已忽略`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 解析 JS/CSS 资源标签
   *
   * 优先从 assetManifest 中获取真实文件路径（含 content hash），
   * 当 manifest 未提供时降级为约定路径 static/css/main.css + static/js/main.js。
   *
   * @returns { cssLinks: string, jsScripts: string } HTML 标签字符串
   */
  protected resolveAssets(): { cssLinks: string; jsScripts: string } {
    const publicPath = this.config.assets.publicPath;

    if (this.assetManifest) {
      return {
        cssLinks: this.scriptInjector.injectStyles(this.assetManifest),
        jsScripts: this.scriptInjector.injectChunks(this.assetManifest, { defer: true }),
      };
    }

    // 没有 manifest 时使用约定路径（开发模式 / 未做 hash 的场景）
    return {
      cssLinks: `  <link rel="stylesheet" href="${publicPath}static/css/main.css">`,
      jsScripts: `  <script defer src="${publicPath}static/js/main.js"></script>`,
    };
  }

  /**
   * 创建带超时的 Promise 包装
   *
   * 用于给数据预取或渲染操作添加超时保护，
   * 防止长时间阻塞导致请求堆积。
   *
   * @param promise - 需要添加超时的 Promise
   * @param timeoutMs - 超时时间（毫秒）
   * @param timeoutMessage - 超时时的错误消息
   * @returns Promise 执行结果
   * @throws 超时时抛出 Error
   */
  protected withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string = '操作超时',
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // 创建超时定时器
      const timer = setTimeout(() => {
        reject(new Error(`${timeoutMessage} (${timeoutMs}ms)`));
      }, timeoutMs);

      // 原始 Promise 完成后清除定时器
      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
