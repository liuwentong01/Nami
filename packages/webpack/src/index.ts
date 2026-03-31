/**
 * @nami/webpack - 包总入口
 *
 * Nami 框架 Webpack 构建配置包。
 * 提供 Client/Server/SSG/Dev 四套构建配置，
 * 以及自定义 Webpack 插件、Loader 和构建编排器。
 */

// 构建配置
export * from './configs';

// 自定义插件
export * from './plugins';

// 模块规则
export * from './rules';

// 优化配置
export * from './optimization';

// Loader 类型（Loader 通过文件路径引用）
export * from './loaders';

// 构建编排器
export { NamiBuilder } from './builder';
export type { BuildResult } from './builder';
