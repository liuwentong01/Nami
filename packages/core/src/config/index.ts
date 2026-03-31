/**
 * @nami/core - 配置层导出入口
 *
 * 配置层负责框架配置的加载、合并、校验和默认值管理。
 *
 * 核心模块：
 * - getDefaultConfig: 获取完整默认配置
 * - ConfigLoader: 配置文件加载与合并
 * - ConfigValidator: 配置校验
 * - defineConfig: 配置定义辅助函数（提供类型提示）
 */

import type { UserNamiConfig } from '@nami/shared';

// 默认配置
export { getDefaultConfig } from './defaults';

// 配置加载器
export { ConfigLoader } from './config-loader';

// 配置校验器
export { ConfigValidator } from './config-validator';
export type { ConfigValidationResult } from './config-validator';

/**
 * 定义 Nami 配置的辅助函数
 *
 * 此函数本身不做任何处理，仅用于提供 TypeScript 类型推导，
 * 让开发者在编写 nami.config.ts 时获得完整的类型提示和自动补全。
 *
 * @param config - 用户配置对象
 * @returns 原样返回传入的配置
 *
 * @example
 * ```typescript
 * // nami.config.ts
 * import { defineConfig } from '@nami/core';
 *
 * export default defineConfig({
 *   appName: 'my-app',
 *   defaultRenderMode: 'ssr',
 *   routes: [
 *     { path: '/', component: './pages/home', renderMode: 'ssr' },
 *     { path: '/about', component: './pages/about', renderMode: 'ssg' },
 *   ],
 *   server: {
 *     port: 8080,
 *   },
 * });
 * ```
 */
export function defineConfig(config: UserNamiConfig): UserNamiConfig {
  return config;
}
