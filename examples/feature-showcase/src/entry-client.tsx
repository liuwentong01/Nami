import React from 'react';
import { initNamiClient, type FallbackRenderProps } from '@nami/client';
import { SkeletonPage } from '@nami/plugin-skeleton';
import serviceWorkerUrl from './service-worker.js?service-worker';
import { createClientPlugins } from './plugins/showcase-plugins';
import { createRuntimeConfig } from './runtime-config';
import { routes } from './routes';
import './global.css';

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
