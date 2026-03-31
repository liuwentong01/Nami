/**
 * @nami/core - 默认配置生成器
 *
 * 提供框架完整默认配置的生成函数。
 * 当业务方在 nami.config.ts 中未指定某项配置时，
 * ConfigLoader 会使用此处生成的默认值进行合并。
 *
 * 默认值来源：
 * - @nami/shared 的常量模块（DEFAULT_SERVER_CONFIG、DEFAULT_ISR_CONFIG 等）
 * - 本模块补充的顶层默认值（appName、srcDir、outDir 等）
 */

import type { NamiConfig } from '@nami/shared';

import {
  DEFAULT_APP_NAME,
  DEFAULT_SRC_DIR,
  DEFAULT_OUT_DIR,
  DEFAULT_RENDER_MODE,
  DEFAULT_SERVER_CONFIG,
  DEFAULT_ISR_CONFIG,
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_FALLBACK_CONFIG,
  DEFAULT_ASSETS_CONFIG,
} from '@nami/shared';

/**
 * 获取框架完整默认配置
 *
 * 返回 NamiConfig 的所有字段的默认值。
 * ConfigLoader 在加载用户配置后，会使用 deepMerge 将用户配置
 * 覆盖到此默认配置上，确保所有字段都有值。
 *
 * @returns 完整的 NamiConfig 默认配置
 *
 * @example
 * ```typescript
 * const defaults = getDefaultConfig();
 * // defaults.appName === 'nami-app'
 * // defaults.server.port === 3000
 * // defaults.defaultRenderMode === RenderMode.CSR
 * ```
 */
export function getDefaultConfig(): NamiConfig {
  return {
    /** 默认应用名称 */
    appName: DEFAULT_APP_NAME,

    /** 默认源码目录 */
    srcDir: DEFAULT_SRC_DIR,

    /** 默认输出目录 */
    outDir: DEFAULT_OUT_DIR,

    /** 默认渲染模式 — CSR（最安全的兜底方案） */
    defaultRenderMode: DEFAULT_RENDER_MODE,

    /** 路由配置 — 默认为空数组，业务方必须自行配置 */
    routes: [],

    /** 服务端配置 — 使用 @nami/shared 定义的默认值 */
    server: { ...DEFAULT_SERVER_CONFIG },

    /** Webpack 配置 — 默认不做任何自定义修改 */
    webpack: {},

    /** ISR 配置 — 默认关闭 */
    isr: { ...DEFAULT_ISR_CONFIG },

    /** 静态资源配置 */
    assets: { ...DEFAULT_ASSETS_CONFIG },

    /** 监控配置 — 默认关闭 */
    monitor: { ...DEFAULT_MONITOR_CONFIG },

    /** 降级配置 — 默认 SSR 失败时自动降级到 CSR */
    fallback: { ...DEFAULT_FALLBACK_CONFIG },

    /** 插件列表 — 默认为空 */
    plugins: [],
  };
}
