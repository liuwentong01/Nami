/**
 * 服务端入口文件 — ISR 模式
 *
 * ISR 模式需要服务端入口，因为：
 * 1. 首次构建时，需要在 Node.js 中执行 renderToString 生成初始静态 HTML
 * 2. 缓存过期后，服务端需要重新执行渲染以更新缓存
 * 3. 对于 fallback: 'blocking' 的动态路由，首次访问时需要服务端即时渲染
 *
 * 与纯 SSR 不同，ISR 的服务端渲染是异步后台执行的，
 * 不会阻塞当前用户请求（除非是 fallback: 'blocking' 的情况）。
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './app';

/**
 * 将页面渲染为 HTML 字符串
 *
 * ISR 重验证时由框架在后台调用此函数，
 * 生成新的 HTML 并更新缓存。
 *
 * @param url - 当前请求的 URL 路径
 * @param props - 由 getStaticProps 返回的数据
 * @returns 渲染后的 HTML 字符串
 */
export async function renderToHTML(
  url: string,
  props: Record<string, unknown>,
): Promise<string> {
  const html = renderToString(
    <App>
      {/* 实际渲染时，框架会根据路由匹配结果注入对应的页面组件 */}
      <div data-server-rendered="true" data-url={url} />
    </App>,
  );

  return html;
}
