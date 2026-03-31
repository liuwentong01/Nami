/**
 * @nami/core - HTML 层导出入口
 *
 * HTML 层负责 HTML 文档的生成、head 管理和资源注入。
 *
 * 核心模块：
 * - DocumentTemplate: 完整 HTML 文档生成
 * - HeadManager: <head> 标签管理（去重、排序）
 * - ScriptInjector: JS/CSS 资源和初始数据注入
 */

// 文档模板
export { DocumentTemplate } from './document';
export type { DocumentRenderOptions } from './document';

// Head 管理器
export { HeadManager } from './head-manager';

// 脚本注入器
export { ScriptInjector } from './script-injector';
export type { AssetManifest, ScriptAttributes } from './script-injector';
