/**
 * @nami/core - 插件系统导出入口
 *
 * 统一导出插件系统的所有类和类型定义。
 * 外部模块只需从此文件导入即可使用完整的插件系统。
 *
 * 插件系统架构：
 *
 *   PluginLoader（加载器）
 *     ↓ 解析字符串/对象 → NamiPlugin
 *   PluginManager（管理器）
 *     ├── 注册插件 → 调用 plugin.setup(api)
 *     ├── 执行钩子 → waterfall / parallel / bail
 *     └── 收集中间件 → Koa middlewares
 *   HookRegistry（钩子注册表）
 *     └── 存储和排序钩子处理器
 *   PluginAPIImpl（API 实现）
 *     └── 提供给插件的注册接口
 */

// 钩子注册表
export { HookRegistry } from './hook-registry';
export type { HookHandler } from './hook-registry';

// 插件 API 实现
export { PluginAPIImpl } from './plugin-api-impl';
export type { MiddlewareEntry } from './plugin-api-impl';

// 插件管理器
export { PluginManager } from './plugin-manager';

// 插件加载器
export { PluginLoader } from './plugin-loader';
