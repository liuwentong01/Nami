import React from 'react';
import { initNamiClient, type FallbackRenderProps } from '@nami/client';
import { SkeletonPage } from '@nami/plugin-skeleton';
import type { NamiRoute } from '@nami/shared';
import serviceWorkerUrl from './service-worker.js?service-worker';
import { createClientPlugins } from './plugins/showcase-plugins';
import { createRuntimeConfig } from './runtime-config';
import { routes } from './routes';
import './global.css';

function routeMatches(pattern: string, pathname: string): boolean {
  if (pattern === '/*') {
    return true;
  }

  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);

  return (
    patternSegments.length === pathSegments.length &&
    patternSegments.every(
      (segment, index) => segment.startsWith(':') || segment === pathSegments[index],
    )
  );
}

function routeScore(route: NamiRoute): number {
  return route.path.split('/').reduce((score, segment) => {
    if (!segment || segment === '*') return score;
    return score + (segment.startsWith(':') ? 10 : 100);
  }, 0);
}

/**
 * Core Renderer 当前会为部分 SSR/Streaming 响应注入裸 initialData；客户端入口
 * 需要 `{ props, renderMode, routePath }` 包装才能准确选择 hydrateRoot。这个桥接
 * 只属于示例，README 会明确说明对应的框架协议边界。
 */
function normalizeInjectedData(): void {
  const rawData = window.__NAMI_DATA__;
  if (!rawData || Object.prototype.hasOwnProperty.call(rawData, 'props')) {
    return;
  }

  const pathname = window.location.pathname;
  const route = [...routes]
    .sort((left, right) => routeScore(right) - routeScore(left))
    .find((candidate) => routeMatches(candidate.path, pathname));

  window.__NAMI_DATA__ = {
    props: rawData,
    renderMode: route?.renderMode ?? 'csr',
    routePath: pathname,
  };
}

function ClientBootstrapError({
  error,
  resetErrorBoundary,
}: FallbackRenderProps): React.ReactElement {
  return (
    <section className="page-shell">
      <div className="callout callout--danger">
        <strong>客户端页面渲染失败</strong>
        <p>{error.message}</p>
        <button className="button button--primary" type="button" onClick={resetErrorBoundary}>
          重试渲染
        </button>
      </div>
    </section>
  );
}

normalizeInjectedData();

const clientPlugins = createClientPlugins();
const clientConfig = createRuntimeConfig(clientPlugins);

void initNamiClient({
  routes,
  plugins: clientPlugins,
  config: clientConfig,
  containerId: 'nami-root',
  loadingFallback: (
    <SkeletonPage
      className="route-loading-skeleton"
      layout="list"
      animation="pulse"
      listItemCount={3}
    />
  ),
  errorFallback: (props) => <ClientBootstrapError {...props} />,
  serviceWorkerUrl,
  serviceWorkerOptions: { scope: '/' },
}).catch((error: unknown) => {
  // 初始化错误发生在 React 根节点建立之前，必须保留明确的控制台证据。
  console.error('[Nami Showcase] 客户端初始化失败', error);
});
