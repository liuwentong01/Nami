/**
 * Feature Showcase 的唯一服务端渲染入口。
 *
 * 入口只负责根据已匹配路由和 initialData 创建 React 元素树；普通 SSR、
 * Streaming SSR、SSG 与 ISR 的具体渲染方式、Document、manifest 和注水均由框架处理。
 */
import React, { type ComponentType } from 'react';
import type { NamiRoute, RenderContext } from '@nami/shared';
import ClientRuntimePage from './pages/client-runtime';
import ContentArticlePage from './pages/content-article';
import ContentIndexPage from './pages/content-index';
import CSRPlaygroundPage from './pages/csr-playground';
import DataNotFoundPage from './pages/data-not-found';
import HomePage from './pages/home';
import ISRProductPage from './pages/isr-product';
import ISRProductsPage from './pages/isr-products';
import NotFoundPage from './pages/not-found';
import PluginsPage from './pages/plugins';
import RedirectPage from './pages/redirect';
import RoutingDynamicPage from './pages/routing-dynamic';
import RoutingStaticPage from './pages/routing-static';
import SSRRequestPage from './pages/ssr-request';
import StabilityPage from './pages/stability';
import StreamingPage from './pages/streaming';

type PageComponent = ComponentType<any>;

const pageRegistry: Record<string, PageComponent> = {
  './pages/home': HomePage,
  './pages/csr-playground': CSRPlaygroundPage,
  './pages/ssr-request': SSRRequestPage,
  './pages/streaming': StreamingPage,
  './pages/content-index': ContentIndexPage,
  './pages/content-article': ContentArticlePage,
  './pages/isr-products': ISRProductsPage,
  './pages/isr-product': ISRProductPage,
  './pages/routing-dynamic': RoutingDynamicPage,
  './pages/routing-static': RoutingStaticPage,
  './pages/client-runtime': ClientRuntimePage,
  './pages/plugins': PluginsPage,
  './pages/stability': StabilityPage,
  './pages/redirect': RedirectPage,
  './pages/data-not-found': DataNotFoundPage,
  './pages/not-found': NotFoundPage,
};

function createPageTree(
  route: NamiRoute,
  initialData: Record<string, unknown>,
): React.ReactElement {
  const Page = pageRegistry[route.component];
  if (!Page) {
    throw new Error(`未注册服务端页面组件: ${route.component}`);
  }

  return (
    <React.Suspense fallback={null}>
      <Page {...initialData} />
    </React.Suspense>
  );
}

export function createAppElement(context: RenderContext): React.ReactElement {
  return createPageTree(context.route, context.initialData ?? {});
}
