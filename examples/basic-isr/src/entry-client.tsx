/**
 * 客户端入口文件
 *
 * ISR 模式下，客户端入口与 SSG/SSR 相同，执行 Hydration。
 * 用户首次访问页面时看到的是预渲染的静态 HTML，
 * Hydration 完成后页面变为可交互状态。
 *
 * ISR 的重验证过程对客户端完全透明：
 * - 用户不会感知到后台正在重新生成页面
 * - 下次访问时自动获取最新生成的版本
 */
import { initNamiClient } from '@nami/client';

initNamiClient({
  containerId: 'nami-root',
});
