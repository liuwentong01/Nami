/**
 * 客户端入口文件
 *
 * SSG 模式下，HTML 在构建时已经生成为静态文件。
 * 客户端入口的作用是执行 Hydration，为静态 HTML 附加交互能力。
 *
 * Hydration 流程：
 * 1. 浏览器加载已预渲染的 HTML（用户可立即看到页面内容）
 * 2. JS 文件异步加载并执行
 * 3. hydrateRoot 将 React 组件树与已有 DOM 对接
 * 4. 页面变为可交互状态（按钮可点击、表单可输入等）
 */
import { initNamiClient } from '@nami/client';

initNamiClient({
  containerId: 'nami-root',
});
