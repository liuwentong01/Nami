/**
 * 服务端入口文件 — SSG 模式
 *
 * Builder 在构建期传入 RenderContext；入口返回页面 React 树，
 * SSGRenderer 统一负责 renderToString、完整文档组装、资源与注水脚本注入。
 */
import React, { type ComponentType } from 'react';
import type { RenderContext } from '@nami/core';
import HomePage from './pages/home';
import BlogPage from './pages/blog';
import BlogPostPage from './pages/blog-post';

type PageComponent = ComponentType<any>;

const pageRegistry: Record<string, PageComponent> = {
  './pages/home': HomePage,
  './pages/blog': BlogPage,
  './pages/blog-post': BlogPostPage,
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
