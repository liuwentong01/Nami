/**
 * @nami/client - Head 层导出入口
 *
 * 导出文档头管理相关的所有公共 API：
 *
 * - NamiHead:              声明式 document.head 管理组件
 * - HeadManagerContext:     SSR 阶段的 head 标签收集上下文
 * - createSSRHeadManager:  创建 SSR head 标签收集器
 * - renderHeadToString:    将收集到的 head 标签渲染为 HTML 字符串
 */

export {
  NamiHead,
  HeadManagerContext,
  createSSRHeadManager,
  renderHeadToString,
} from './nami-head';

export type {
  NamiHeadProps,
  MetaTag,
  LinkTag,
  ScriptTag,
  CollectedHeadTags,
  HeadManagerContextValue,
} from './nami-head';
