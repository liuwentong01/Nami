/**
 * 服务端入口文件 — SSR 模式
 *
 * 本文件在 Node.js 服务端执行，职责：
 * 1. 接收来自 Koa 中间件的渲染请求
 * 2. 使用 React 的 renderToString 将组件树渲染为 HTML 字符串
 * 3. 返回 HTML 给中间件，最终通过 HTTP 响应发送给客户端
 *
 * renderToString 是同步 API，执行期间会阻塞当前请求。
 * 对于复杂页面，可考虑使用 renderToPipeableStream 实现流式 SSR。
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './app';

/**
 * 将页面渲染为 HTML 字符串
 *
 * @param url - 当前请求的 URL 路径
 * @param props - 由 getServerSideProps 返回的数据
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
