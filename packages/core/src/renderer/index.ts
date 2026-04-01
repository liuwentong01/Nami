/**
 * @nami/core - 渲染器层入口
 *
 * 统一导出渲染器系统的所有组件：
 * - RendererFactory: 工厂类，根据渲染模式创建对应的渲染器实例
 * - BaseRenderer: 渲染器抽象基类
 * - CSRRenderer / SSRRenderer / SSGRenderer / ISRRenderer: 四种渲染器实现
 * - 类型定义: RendererOptions / CreateRendererOptions 等
 *
 * 使用方式：
 *
 * @example
 * ```typescript
 * import { RendererFactory, RenderMode } from '@nami/core';
 *
 * // 方式一：通过工厂创建渲染器
 * const renderer = RendererFactory.create({
 *   mode: RenderMode.SSR,
 *   config: namiConfig,
 *   appElementFactory: (ctx) => <App {...ctx} />,
 * });
 *
 * // 方式二：直接实例化特定渲染器
 * const ssrRenderer = new SSRRenderer({
 *   config: namiConfig,
 *   appElementFactory: (ctx) => <App {...ctx} />,
 * });
 *
 * // 执行渲染
 * const result = await renderer.render(context);
 *
 * // 降级处理
 * try {
 *   const result = await renderer.render(context);
 * } catch (error) {
 *   const fallback = renderer.createFallbackRenderer();
 *   if (fallback) {
 *     const result = await fallback.render(context);
 *   }
 * }
 * ```
 */

import type { RenderMode } from '@nami/shared';
import { RenderMode as RenderModeEnum, RenderError, ErrorCode } from '@nami/shared';

import { BaseRenderer } from './base-renderer';
import { CSRRenderer } from './csr-renderer';
import { SSRRenderer } from './ssr-renderer';
import { SSGRenderer } from './ssg-renderer';
import { ISRRenderer } from './isr-renderer';
import type { CreateRendererOptions } from './types';

// ==================== 导出类型 ====================

export type {
  RendererOptions,
  CreateRendererOptions,
  AppElementFactory,
  HTMLRenderer,
  PluginManagerLike,
  ISRManagerLike,
  StaticFileReader,
  ModuleLoaderLike,
} from './types';

export type { SSRRendererOptions } from './ssr-renderer';
export type { SSGRendererOptions, StaticGenerationResult } from './ssg-renderer';
export type { ISRRendererOptions } from './isr-renderer';
export type { StreamingSSRRendererOptions, StreamingRenderResult } from './streaming-ssr-renderer';

// ==================== 导出渲染器类 ====================

export { BaseRenderer } from './base-renderer';
export { CSRRenderer } from './csr-renderer';
export { SSRRenderer } from './ssr-renderer';
export { SSGRenderer } from './ssg-renderer';
export { ISRRenderer } from './isr-renderer';
export { StreamingSSRRenderer } from './streaming-ssr-renderer';

// ==================== 渲染器工厂 ====================

/**
 * 渲染器工厂
 *
 * 根据渲染模式创建对应的渲染器实例。
 * 封装了不同渲染器的创建逻辑和参数校验，
 * 调用方只需指定模式即可获取正确配置的渲染器。
 *
 * 设计考量：
 * - 使用静态方法而非实例方法，因为工厂本身无状态
 * - create() 方法返回 BaseRenderer 类型，调用方无需关心具体实现
 * - 参数校验在创建时执行，尽早发现配置错误
 *
 * @example
 * ```typescript
 * // 创建 SSR 渲染器
 * const renderer = RendererFactory.create({
 *   mode: RenderMode.SSR,
 *   config: namiConfig,
 *   pluginManager: pluginManagerInstance,
 *   appElementFactory: (ctx) => <App {...ctx} />,
 * });
 *
 * // 创建 ISR 渲染器（需要额外的 ISRManager）
 * const isrRenderer = RendererFactory.create({
 *   mode: RenderMode.ISR,
 *   config: namiConfig,
 *   appElementFactory: (ctx) => <App {...ctx} />,
 *   cacheStore: redisCacheStore,
 * });
 * ```
 */
export class RendererFactory {
  /**
   * 根据渲染模式创建渲染器实例
   *
   * @param options - 创建选项（包含模式、配置和模式特有参数）
   * @returns 渲染器实例（BaseRenderer 的具体子类）
   * @throws {RenderError} 渲染模式无效或必要参数缺失时抛出
   */
  static create(options: CreateRendererOptions): BaseRenderer {
    const { mode, config, pluginManager, appElementFactory, htmlRenderer, moduleLoader } = options;

    switch (mode) {
      // ==================== CSR ====================
      case RenderModeEnum.CSR:
        return new CSRRenderer({
          config,
          pluginManager,
        });

      // ==================== SSR ====================
      case RenderModeEnum.SSR: {
        // SSR 至少需要一种可用的服务端渲染入口：
        // 1. appElementFactory：新的 React 元素工厂协议
        // 2. htmlRenderer：兼容已有 entry-server.renderToHTML() 协议
        if (!appElementFactory && !htmlRenderer) {
          throw new RenderError(
            '创建 SSR 渲染器需要提供 appElementFactory 或 htmlRenderer 参数',
            ErrorCode.RENDER_SSR_FAILED,
            {
              mode,
              hint: '请提供 React 元素工厂，或提供兼容 entry-server 的 HTML 渲染入口',
            },
          );
        }

        return new SSRRenderer({
          config,
          pluginManager,
          appElementFactory,
          htmlRenderer,
          moduleLoader,
        });
      }

      // ==================== SSG ====================
      case RenderModeEnum.SSG: {
        return new SSGRenderer({
          config,
          pluginManager,
          appElementFactory,
          moduleLoader,
        });
      }

      // ==================== ISR ====================
      case RenderModeEnum.ISR: {
        // ISR 缓存未命中时同样需要一个真正可执行的服务端渲染入口。
        if (!appElementFactory && !htmlRenderer) {
          throw new RenderError(
            '创建 ISR 渲染器需要提供 appElementFactory 或 htmlRenderer 参数',
            ErrorCode.RENDER_ISR_REVALIDATE_FAILED,
            {
              mode,
              hint: 'ISRRenderer 在缓存未命中时需要执行 React 渲染或 HTML 渲染',
            },
          );
        }

        return new ISRRenderer({
          config,
          pluginManager,
          appElementFactory,
          htmlRenderer,
          moduleLoader,
        });
      }

      // ==================== 未知模式 ====================
      default: {
        // 利用 TypeScript 的 exhaustive check 确保处理了所有枚举值
        // 如果后续新增渲染模式但忘记在此处添加分支，编译时会报错
        const exhaustiveCheck: never = mode;
        throw new RenderError(
          `未知的渲染模式: ${exhaustiveCheck}`,
          ErrorCode.RENDER_SSR_FAILED,
          {
            mode: String(mode),
            supportedModes: Object.values(RenderModeEnum),
          },
        );
      }
    }
  }

  /**
   * 获取指定渲染模式的降级模式
   *
   * 返回当渲染失败时应该降级到的模式。
   * 降级链: SSR → CSR, SSG → CSR, ISR → CSR, CSR → null
   *
   * @param mode - 当前渲染模式
   * @returns 降级模式，或 null 表示没有降级方案
   */
  static getFallbackMode(mode: RenderMode): RenderMode | null {
    switch (mode) {
      case RenderModeEnum.SSR:
      case RenderModeEnum.SSG:
      case RenderModeEnum.ISR:
        return RenderModeEnum.CSR;
      case RenderModeEnum.CSR:
        return null;
      default:
        return null;
    }
  }

  /**
   * 检查指定渲染模式是否需要服务端运行时
   *
   * CSR 和 SSG（运行阶段）不需要服务端运行时，
   * SSR 和 ISR 需要服务端持续运行。
   *
   * @param mode - 渲染模式
   * @returns 是否需要服务端运行时
   */
  static requiresServerRuntime(mode: RenderMode): boolean {
    return mode === RenderModeEnum.SSR || mode === RenderModeEnum.ISR;
  }

  /**
   * 检查指定渲染模式是否需要构建时生成
   *
   * SSG 和 ISR 需要在构建时执行静态生成。
   *
   * @param mode - 渲染模式
   * @returns 是否需要构建时生成
   */
  static requiresBuildGeneration(mode: RenderMode): boolean {
    return mode === RenderModeEnum.SSG || mode === RenderModeEnum.ISR;
  }
}
