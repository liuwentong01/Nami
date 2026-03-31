/**
 * 客户端入口文件
 *
 * CSR 模式下，这是整个应用的唯一入口。
 * initNamiClient 会：
 * 1. 找到 id 为 nami-root 的 DOM 容器
 * 2. 调用 React 18 的 createRoot API 创建渲染根节点
 * 3. 将应用组件树渲染到容器中
 *
 * 注意：CSR 模式使用 createRoot（全量渲染），
 * 而 SSR/SSG/ISR 模式使用 hydrateRoot（Hydration）。
 */
import { initNamiClient } from '@nami/client';

initNamiClient({
  containerId: 'nami-root',
});
