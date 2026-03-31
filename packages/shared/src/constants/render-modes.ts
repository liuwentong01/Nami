/**
 * @nami/shared - 渲染模式常量
 *
 * 提供渲染模式相关的常量和描述信息。
 */

import { RenderMode } from '../types/render-mode';

/**
 * 渲染模式的人类可读描述
 */
export const RENDER_MODE_LABELS: Record<RenderMode, string> = {
  [RenderMode.CSR]: '客户端渲染 (Client-Side Rendering)',
  [RenderMode.SSR]: '服务端渲染 (Server-Side Rendering)',
  [RenderMode.SSG]: '静态站点生成 (Static Site Generation)',
  [RenderMode.ISR]: '增量静态再生 (Incremental Static Regeneration)',
};

/**
 * 需要服务端参与的渲染模式
 */
export const SERVER_RENDER_MODES: RenderMode[] = [RenderMode.SSR, RenderMode.ISR];

/**
 * 需要构建时生成静态文件的渲染模式
 */
export const STATIC_RENDER_MODES: RenderMode[] = [RenderMode.SSG, RenderMode.ISR];

/**
 * 所有需要服务端 Bundle 的渲染模式
 */
export const NEEDS_SERVER_BUNDLE: RenderMode[] = [RenderMode.SSR, RenderMode.SSG, RenderMode.ISR];

/**
 * 判断渲染模式是否需要服务端运行时
 */
export function needsServerRuntime(mode: RenderMode): boolean {
  return SERVER_RENDER_MODES.includes(mode);
}

/**
 * 判断渲染模式是否需要构建时静态生成
 */
export function needsStaticGeneration(mode: RenderMode): boolean {
  return STATIC_RENDER_MODES.includes(mode);
}
