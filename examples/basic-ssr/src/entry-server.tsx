/**
 * 服务端入口文件 — SSR 模式
 *
 * 业务入口只负责把 RenderContext 映射为 React 元素树。
 * renderToString、HTML 文档壳、资源清单、数据注水与 Streaming 选择均由 Nami 负责，
 * 因而 SSR/Streaming SSR/SSG/ISR 可以共享同一套入口协议。
 */
import React, { type ComponentType } from 'react';
import type { RenderContext } from '@nami/core';
import HomePage from './pages/home';
import PostsPage from './pages/posts';
import PostDetailPage from './pages/post-detail';

type PageComponent = ComponentType<any>;

const pageRegistry: Record<string, PageComponent> = {
  './pages/home': HomePage,
  './pages/posts': PostsPage,
  './pages/post-detail': PostDetailPage,
};

export function createAppElement(context: RenderContext): React.ReactElement {
  const Page = pageRegistry[context.route.component];
  if (!Page) {
    throw new Error(`未注册服务端页面组件: ${context.route.component}`);
  }

  return (
    <React.Suspense fallback={null}>
      <Page {...(context.initialData ?? {})} />
    </React.Suspense>
  );
}
