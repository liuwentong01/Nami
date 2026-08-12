/**
 * @nami/plugin-skeleton - 骨架屏插件主体
 *
 * NamiSkeletonPlugin 是 Nami 框架的官方骨架屏插件，负责：
 *
 * 1. 在渲染前（onBeforeRender）准备可被 CSR Shell 消费的临时骨架 HTML
 * 2. 在渲染错误时（onRenderError）提供静态应急兜底内容
 * 3. 支持路由级别的骨架屏配置（routeSkeletons 映射）
 * 4. 支持自动从路由路径检测页面布局类型
 * 5. 通过同构 wrapApp 为服务端与客户端 Suspense 提供一致的骨架屏 fallback
 *
 * 骨架屏工作流程：
 * ```
 * 请求到达 → onBeforeRender
 *   ├─ SSR/SSG/ISR 正常完成 → 不生成 CSR Shell 片段
 *   └─ 正常 CSR → CSR Shell 立即展示，客户端接管后替换
 *
 * 渲染错误 → onRenderError
 *   ├─ 准备 SSR→CSR Shell 片段
 *   └─ 同时准备静态应急内容（只在可恢复 CSR 也不可用时消费）
 *
 * 服务端 / 客户端 → wrapApp（两端保持相同配置与注册顺序）
 *   └─ Suspense fallback 使用骨架屏组件
 * ```
 */

import React from 'react';
import type { NamiPlugin, PluginAPI, RenderContext, NamiRoute } from '@nami/shared';
import {
  SkeletonPage,
  detectLayoutFromRoute,
  type SkeletonPageLayout,
} from './components/skeleton-page';
import type { SkeletonAnimation } from './components/skeleton-screen';

/**
 * 骨架屏插件配置选项
 */
export interface SkeletonPluginOptions {
  /**
   * 默认骨架屏布局
   * 当路由未配置骨架屏时使用此默认布局
   * @default 'list'
   */
  defaultLayout?: SkeletonPageLayout;

  /**
   * 路由骨架屏映射
   * key 为路由路径模式，value 为对应的骨架屏布局
   *
   * @example
   * ```typescript
   * {
   *   '/users': 'list',
   *   '/users/:id': 'detail',
   *   '/dashboard': 'dashboard',
   * }
   * ```
   */
  routeSkeletons?: Record<string, SkeletonPageLayout>;

  /**
   * 动画类型
   * @default 'pulse'
   */
  animation?: SkeletonAnimation;

  /**
   * 骨架屏背景色
   * @default '#e0e0e0'
   */
  backgroundColor?: string;

  /**
   * 高亮色（波浪动画使用）
   * @default '#f5f5f5'
   */
  highlightColor?: string;

  /**
   * 是否自动从路由路径检测布局类型
   * 当路由未在 routeSkeletons 中配置时，尝试自动检测
   * @default true
   */
  autoDetectLayout?: boolean;

  /**
   * 是否在渲染错误时提供静态应急内容
   * @default true
   */
  useAsFallback?: boolean;

  /**
   * 是否把骨架作为 CSR HTML Shell 的临时加载内容
   *
   * 开启后，正常 CSR 与 SSR→CSR 降级都会在客户端 JS 下载、初始化和首次
   * React commit 之前展示骨架；客户端成功接管后由 React 自动替换。
   * @default true
   */
  useAsShell?: boolean;

  /**
   * 是否使用 Suspense 包裹应用
   * @default true
   */
  enableSuspense?: boolean;

  /**
   * 自定义骨架屏 React 组件
   * 如果提供，将优先使用此组件替代内置骨架屏
   */
  customSkeletonComponent?: React.ComponentType<{ route?: NamiRoute }>;

  /**
   * 静态应急 HTML 字符串
   * 如果提供，将作为 Level 3 候选；不会跳过重试或可恢复 CSR
   */
  fallbackHTML?: string;

  /**
   * 自定义 CSR Shell 骨架 HTML 片段
   *
   * 只能提供放入 `#nami-root` 的片段，不应包含 html/body/script。完整文档会由
   * Core 拒绝并回退到内置 Shell 骨架，避免产生嵌套文档或执行任意脚本。
   */
  shellHTML?: string;

  /**
   * 是否启用骨架屏
   * @default true
   */
  enabled?: boolean;

  /**
   * 日志前缀
   * @default '[NamiSkeleton]'
   */
  logPrefix?: string;
}

/**
 * Nami 骨架屏插件
 *
 * @example
 * ```typescript
 * import { NamiSkeletonPlugin } from '@nami/plugin-skeleton';
 *
 * export default {
 *   plugins: [
 *     new NamiSkeletonPlugin({
 *       defaultLayout: 'list',
 *       animation: 'pulse',
 *       routeSkeletons: {
 *         '/dashboard': 'dashboard',
 *         '/articles/:id': 'detail',
 *       },
 *     }),
 *   ],
 * };
 * ```
 */
export class NamiSkeletonPlugin implements NamiPlugin {
  /** 插件唯一名称 */
  readonly name = 'nami:skeleton';

  /** 插件版本号 */
  readonly version = '0.1.0';

  /**
   * 执行顺序：post（在缓存等前置插件之后执行）
   * 由 Core 的缓存短路决定最终是否生成页面；本插件只准备上下文候选内容。
   */
  readonly enforce = 'post' as const;

  /** 插件配置 */
  private readonly options: Required<
    Pick<
      SkeletonPluginOptions,
      | 'defaultLayout'
      | 'animation'
      | 'backgroundColor'
      | 'highlightColor'
      | 'autoDetectLayout'
      | 'useAsFallback'
      | 'useAsShell'
      | 'enableSuspense'
      | 'enabled'
      | 'logPrefix'
    >
  > &
    SkeletonPluginOptions;

  constructor(options: SkeletonPluginOptions = {}) {
    this.options = {
      ...options,
      defaultLayout: options.defaultLayout ?? 'list',
      animation: options.animation ?? 'pulse',
      backgroundColor: options.backgroundColor ?? '#e0e0e0',
      highlightColor: options.highlightColor ?? '#f5f5f5',
      autoDetectLayout: options.autoDetectLayout ?? true,
      useAsFallback: options.useAsFallback ?? true,
      useAsShell: options.useAsShell ?? true,
      enableSuspense: options.enableSuspense ?? true,
      enabled: options.enabled ?? true,
      logPrefix: options.logPrefix ?? '[NamiSkeleton]',
    };
  }

  /**
   * 插件初始化
   *
   * 注册以下生命周期钩子：
   * - wrapApp:        使用 Suspense 包裹应用根组件
   * - onBeforeRender: 为正常 CSR 准备 Shell 骨架
   * - onRenderError:  为 SSR→CSR 和静态应急准备候选内容
   *
   * @param api - 插件 API
   */
  async setup(api: PluginAPI): Promise<void> {
    const logger = api.getLogger();

    if (!this.options.enabled) {
      logger.info(`${this.options.logPrefix} 骨架屏插件已禁用`);
      return;
    }

    logger.info(`${this.options.logPrefix} 骨架屏插件初始化`, {
      defaultLayout: this.options.defaultLayout,
      animation: this.options.animation,
      useAsShell: this.options.useAsShell,
    });

    // ==================== wrapApp: 用 Suspense 包裹应用 ====================
    if (this.options.enableSuspense) {
      api.wrapApp((app: React.ReactElement): React.ReactElement => {
        const FallbackComponent = this.getFallbackComponent();

        return React.createElement(
          React.Suspense,
          { fallback: React.createElement(FallbackComponent) },
          app,
        );
      });

      logger.debug(`${this.options.logPrefix} 已注册 Suspense 包裹`);
    }

    // ==================== 渲染前：注入骨架屏标记 ====================
    api.onBeforeRender(async (context: RenderContext) => {
      try {
        // 确定该路由的骨架屏布局
        const layout = this.resolveLayout(context.route);

        // 保留原有上下文字段，供业务插件和观测逻辑继续使用。
        context.extra['__skeleton_layout'] = layout;
        context.extra['__skeleton_enabled'] = true;

        // 正常 CSR Shell 是可恢复的 loading 状态：HTML 中仍会注入客户端 JS，
        // React 首次 commit 后会替换本片段。SSR→CSR 的片段在 onRenderError 补充，
        // 避免为成功的 SSR/SSG/ISR 上下文生成不会消费的较大 HTML 字符串。
        if (this.options.useAsShell && context.route.renderMode === 'csr') {
          context.extra['__csr_shell_skeleton'] = this.generateShellSkeletonHTML(layout);
        }

        logger.debug(`${this.options.logPrefix} 骨架屏已就绪`, {
          url: context.url,
          layout,
        });
      } catch (error) {
        logger.warn(`${this.options.logPrefix} 骨架屏准备失败`, {
          url: context.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // ==================== 渲染错误：准备 CSR Shell 与静态应急候选 ====================
    // 两个能力独立开关：关闭 Level 3 静态应急时，仍可为 SSR→CSR 准备 loading；
    // 关闭 Shell loading 时，也仍可只提供静态应急页。
    if (this.options.useAsShell || this.options.useAsFallback) {
      api.onRenderError(async (context: RenderContext, error: Error) => {
        try {
          const layout = this.resolveLayout(context.route);

          // Renderer 可能在 beforeRender 之前就创建失败。此时仍准备一份可恢复的
          // CSR Shell 骨架，让 Level 2 能加载客户端 JS，而不是直接停在静态兜底页。
          if (
            this.options.useAsShell &&
            typeof context.extra['__csr_shell_skeleton'] !== 'string'
          ) {
            context.extra['__csr_shell_skeleton'] = this.generateShellSkeletonHTML(layout);
          }

          if (this.options.useAsFallback) {
            // 本字段只供 Level 3 静态应急兜底使用；Level 2 读取上面的 CSR Shell 字段。
            context.extra['__skeleton_fallback'] = this.generateEmergencyFallbackHTML(layout);
          }

          logger.warn(`${this.options.logPrefix} SSR 渲染失败，已准备降级候选`, {
            url: context.url,
            layout,
            csrShell: this.options.useAsShell,
            staticEmergency: this.options.useAsFallback,
            error: error.message,
          });
        } catch (genError) {
          logger.error(`${this.options.logPrefix} 错误兜底内容生成失败`, {
            error: genError instanceof Error ? genError.message : String(genError),
          });
        }
      });

      logger.debug(`${this.options.logPrefix} 已注册错误降级钩子`);
    }

    // ==================== 插件销毁 ====================
    api.onDispose(async () => {
      logger.info(`${this.options.logPrefix} 骨架屏插件已销毁`);
    });
  }

  /**
   * 确定路由的骨架屏布局类型
   *
   * 优先级：
   * 1. routeSkeletons 映射
   * 2. 路由 meta 中的 skeletonLayout 字段
   * 3. 自动检测（如果启用）
   * 4. 默认布局
   *
   * @param route - 路由配置
   * @returns 布局类型
   */
  private resolveLayout(route: NamiRoute): SkeletonPageLayout {
    // 1. 检查 routeSkeletons 映射
    if (this.options.routeSkeletons) {
      const mapped = this.options.routeSkeletons[route.path];
      if (mapped) return mapped;
    }

    // 2. 检查路由 meta 中的骨架屏配置
    if (route.meta?.['skeletonLayout']) {
      return route.meta['skeletonLayout'] as SkeletonPageLayout;
    }

    // 3. 自动检测
    if (this.options.autoDetectLayout) {
      return detectLayoutFromRoute(route.path);
    }

    // 4. 使用默认布局
    return this.options.defaultLayout;
  }

  /**
   * 获取骨架屏 fallback 组件
   *
   * 优先使用自定义组件，否则使用内置的 SkeletonPage。
   */
  private getFallbackComponent(): React.ComponentType {
    if (this.options.customSkeletonComponent) {
      return this.options.customSkeletonComponent as React.ComponentType;
    }

    // 使用内置的 SkeletonPage 组件
    const defaultLayout = this.options.defaultLayout;
    const animation = this.options.animation;
    const backgroundColor = this.options.backgroundColor;
    const highlightColor = this.options.highlightColor;

    const FallbackSkeleton: React.FC = () =>
      React.createElement(SkeletonPage, {
        layout: defaultLayout,
        animation,
        backgroundColor,
        highlightColor,
      });
    FallbackSkeleton.displayName = 'NamiSkeletonFallback';
    return FallbackSkeleton;
  }

  /** 生成放入可恢复 CSR Shell 的加载片段。 */
  private generateShellSkeletonHTML(layout: SkeletonPageLayout): string {
    if (this.options.shellHTML) {
      return this.options.shellHTML;
    }

    return this.generateSkeletonFragment(layout, 'loading-shell');
  }

  /**
   * 生成骨架屏的内联 HTML 字符串
   *
   * 用于 SSR 错误时的降级返回。不依赖外部资源，完全自包含。
   *
   * @param layout - 布局类型
   * @returns HTML 字符串
   */
  private generateEmergencyFallbackHTML(layout: SkeletonPageLayout): string {
    // 如果配置了静态 HTML，直接返回
    if (this.options.fallbackHTML) {
      return this.options.fallbackHTML;
    }

    return this.generateSkeletonFragment(layout, 'static-emergency');
  }

  /**
   * 生成不依赖客户端运行时的骨架片段。
   * loading-shell 会被 React 接管；static-emergency 是不可恢复链路中的明确兜底。
   */
  private generateSkeletonFragment(
    layout: SkeletonPageLayout,
    purpose: 'loading-shell' | 'static-emergency',
  ): string {
    const { backgroundColor } = this.options;

    // 生成 CSS 动画
    const animationCSS = `
      @keyframes nami-skeleton-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      .nami-sk {
        display: block;
        background-color: ${backgroundColor};
        border-radius: 4px;
        animation: nami-skeleton-pulse 1.5s ease-in-out infinite;
      }
    `;

    // 根据布局生成内容 HTML
    const contentHTML = this.buildLayoutHTML(layout);

    const isLoadingShell = purpose === 'loading-shell';
    const statusContent = isLoadingShell
      ? ''
      : `
  <div style="margin-bottom:20px;padding:14px 16px;border:1px solid #e5e7eb;border-radius:8px;color:#4b5563;background:#fff">
    <strong>页面暂时不可用</strong>
    <p style="margin:6px 0 0">服务端和客户端降级均未能完成，请稍后重新加载。</p>
    <a href="" style="display:inline-block;margin-top:10px;color:#2563eb">重新加载</a>
  </div>`;

    return `
<div data-nami-skeleton="${purpose}" style="padding:24px;max-width:1200px;margin:0 auto" role="${isLoadingShell ? 'status' : 'alert'}" aria-live="polite" aria-busy="${isLoadingShell ? 'true' : 'false'}" aria-label="${isLoadingShell ? '页面加载中' : '页面暂时不可用'}">
  <style>${animationCSS}</style>
  ${statusContent}
  ${contentHTML}
</div>`.trim();
  }

  /**
   * 根据布局类型构建 HTML
   */
  private buildLayoutHTML(layout: SkeletonPageLayout): string {
    switch (layout) {
      case 'list':
        return this.buildListHTML();
      case 'detail':
        return this.buildDetailHTML();
      case 'dashboard':
        return this.buildDashboardHTML();
      default:
        return this.buildListHTML();
    }
  }

  /** 生成列表布局 HTML */
  private buildListHTML(): string {
    const listItem = `
<div style="display:flex;align-items:flex-start;padding:16px;border-bottom:1px solid #f0f0f0">
  <div class="nami-sk" style="width:40px;height:40px;border-radius:50%;flex-shrink:0"></div>
  <div style="flex:1;margin-left:12px">
    <div class="nami-sk" style="width:40%;height:16px"></div>
    <div class="nami-sk" style="width:100%;height:14px;margin-top:8px"></div>
    <div class="nami-sk" style="width:75%;height:14px;margin-top:6px"></div>
  </div>
</div>`;

    return `
<div class="nami-sk" style="width:100%;height:40px;border-radius:20px;margin-bottom:16px"></div>
<div style="display:flex;gap:8px;margin-bottom:16px">
  <div class="nami-sk" style="width:80px;height:28px;border-radius:14px"></div>
  <div class="nami-sk" style="width:64px;height:28px;border-radius:14px"></div>
  <div class="nami-sk" style="width:72px;height:28px;border-radius:14px"></div>
</div>
<div style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden">
  ${listItem}${listItem}${listItem}${listItem}${listItem}
</div>`;
  }

  /** 生成详情布局 HTML */
  private buildDetailHTML(): string {
    const paragraph = `
<div style="margin-bottom:24px">
  <div class="nami-sk" style="width:30%;height:20px"></div>
  <div class="nami-sk" style="width:100%;height:14px;margin-top:12px"></div>
  <div class="nami-sk" style="width:100%;height:14px;margin-top:8px"></div>
  <div class="nami-sk" style="width:90%;height:14px;margin-top:8px"></div>
  <div class="nami-sk" style="width:60%;height:14px;margin-top:8px"></div>
</div>`;

    return `
<div class="nami-sk" style="width:60%;height:32px;margin-bottom:16px"></div>
<div class="nami-sk" style="width:100%;height:300px;border-radius:8px;margin-bottom:24px"></div>
${paragraph}${paragraph}${paragraph}`;
  }

  /** 生成仪表盘布局 HTML */
  private buildDashboardHTML(): string {
    const statCard = `
<div style="flex:1;min-width:200px;padding:20px;border:1px solid #f0f0f0;border-radius:8px">
  <div class="nami-sk" style="width:50%;height:14px"></div>
  <div class="nami-sk" style="width:70%;height:32px;margin-top:12px"></div>
  <div class="nami-sk" style="width:30%;height:12px;margin-top:8px"></div>
</div>`;

    return `
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
  <div class="nami-sk" style="width:200px;height:28px"></div>
  <div style="display:flex;gap:8px">
    <div class="nami-sk" style="width:88px;height:36px"></div>
    <div class="nami-sk" style="width:88px;height:36px"></div>
  </div>
</div>
<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px">
  ${statCard}${statCard}${statCard}${statCard}
</div>
<div style="display:flex;gap:16px">
  <div style="flex:2;border:1px solid #f0f0f0;border-radius:8px;padding:20px">
    <div class="nami-sk" style="width:30%;height:18px"></div>
    <div class="nami-sk" style="width:100%;height:240px;margin-top:16px"></div>
  </div>
  <div style="flex:1;border:1px solid #f0f0f0;border-radius:8px;padding:20px">
    <div class="nami-sk" style="width:40%;height:18px"></div>
    <div class="nami-sk" style="width:100%;height:240px;margin-top:16px"></div>
  </div>
</div>`;
  }

  /**
   * 获取 SkeletonPage React 组件的 props
   *
   * 供外部使用，生成与当前配置匹配的 SkeletonPage 属性。
   *
   * @param layout - 布局类型（可选，默认使用插件默认布局）
   * @returns SkeletonPage 组件的 props
   */
  getSkeletonPageProps(layout?: SkeletonPageLayout): React.ComponentProps<typeof SkeletonPage> {
    return {
      layout: layout ?? this.options.defaultLayout,
      animation: this.options.animation,
      backgroundColor: this.options.backgroundColor,
      highlightColor: this.options.highlightColor,
    };
  }
}
