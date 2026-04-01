/**
 * 服务端入口文件 — SSG 模式
 *
 * 纯 SSG 项目同样提供 entry-server，
 * 这样构建阶段可以走与 SSR/ISR 一致的服务端渲染入口，
 * 产出更接近真实运行时的静态 HTML。
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './app';

export async function renderToHTML(
  url: string,
  props: Record<string, unknown>,
): Promise<string> {
  return renderToString(
    <App>
      <div data-server-rendered="true" data-url={url}>
        <pre>{JSON.stringify(props, null, 2)}</pre>
      </div>
    </App>,
  );
}
