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
  resolveNamiConfig,
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
  return resolveNamiConfig({ appName: DEFAULT_APP_NAME });
}
