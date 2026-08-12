/**
 * 服务端入口文件 — ISR 模式
 *
 * 首次构建和运行期重验证都复用这个 React 元素工厂。
 * 缓存状态机、字符串渲染、文档组装与数据注水由 Nami 统一管理。
 */
import React, { type ComponentType } from 'react';
import type { RenderContext } from '@nami/core';
import HomePage from './pages/home';
import ProductsPage from './pages/products';
import ProductDetailPage from './pages/product-detail';

type PageComponent = ComponentType<any>;

const pageRegistry: Record<string, PageComponent> = {
  './pages/home': HomePage,
  './pages/products': ProductsPage,
  './pages/product-detail': ProductDetailPage,
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
