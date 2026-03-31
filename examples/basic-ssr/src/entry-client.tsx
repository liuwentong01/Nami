/**
 * 客户端入口文件
 *
 * SSR 模式下，客户端入口的作用是执行 Hydration：
 * - 服务端已经返回了完整的 HTML 标记
 * - initNamiClient 调用 hydrateRoot 为已有 DOM 附加事件监听器
 * - Hydration 完成后，页面变为可交互状态
 *
 * Hydration 过程中 React 会校验服务端与客户端的渲染结果是否一致，
 * 不一致时会在控制台输出警告并尝试修复。
 */
import { initNamiClient } from '@nami/client';

initNamiClient({
  containerId: 'nami-root',
});
