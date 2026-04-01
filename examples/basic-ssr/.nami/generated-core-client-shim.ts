/**
 * client bundle 专用的 @nami/core 精简入口。
 *
 * 浏览器端当前只需要 PluginManager，直接引用完整 core 入口会把
 * config-loader / module-loader / plugin-loader 这类 Node 专属模块一并卷入，
 * 从而触发表达式 require 的 webpack 警告。
 */
export { PluginManager } from "../../../packages/core/dist/plugin/plugin-manager";
export { NamiDataProvider } from "../../../packages/core/dist/data/data-context";
export { matchPath } from "../../../packages/core/dist/router/path-matcher";
