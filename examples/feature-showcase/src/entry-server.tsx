import fs from 'node:fs';
import path from 'node:path';
import React, { type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { safeStringify, type NamiRoute, type RenderContext } from '@nami/shared';
import { App } from './app';
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
import { routes } from './routes';

type PageComponent = ComponentType<any>;

interface AssetManifest {
  files?: Record<string, string>;
  entrypoints?: string[];
}

interface MatchedRoute {
  route: NamiRoute;
  params: Record<string, string>;
}

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

function scoreRoute(route: NamiRoute): number {
  if (route.path === '/*') return -1;

  return route.path.split('/').reduce((score, segment) => {
    if (!segment) return score;
    return score + (segment.startsWith(':') ? 10 : 100);
  }, 0);
}

function matchRoutePattern(pattern: string, pathname: string): Record<string, string> | null {
  if (pattern === '/*') {
    return { '*': pathname.slice(1) };
  }

  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];
    if (!patternSegment || pathSegment === undefined) {
      return null;
    }

    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }

    if (patternSegment !== pathSegment) {
      return null;
    }
  }

  return params;
}

function resolveRoute(url: string): MatchedRoute {
  const pathname = new URL(url, 'http://nami.local').pathname;
  const rankedRoutes = [...routes].sort((left, right) => scoreRoute(right) - scoreRoute(left));

  for (const route of rankedRoutes) {
    const params = matchRoutePattern(route.path, pathname);
    if (params) {
      return { route, params };
    }
  }

  const fallbackRoute = routes.find((route) => route.path === '/*');
  if (!fallbackRoute) {
    throw new Error(`没有可处理 ${pathname} 的 Nami 路由`);
  }
  return { route: fallbackRoute, params: { '*': pathname.slice(1) } };
}

function createPageTree(
  route: NamiRoute,
  initialData: Record<string, unknown>,
): React.ReactElement {
  const Page = pageRegistry[route.component] ?? NotFoundPage;

  return (
    <App>
      <Page {...initialData} />
    </App>
  );
}

/** StreamingSSRRenderer 需要的 React 元素工厂。 */
export function createAppElement(context: RenderContext): React.ReactElement {
  return createPageTree(context.route, context.initialData ?? {});
}

function readAssetManifest(): AssetManifest | null {
  const candidates = [
    path.resolve(process.cwd(), 'dist/client/asset-manifest.json'),
    path.resolve(__dirname, '../client/asset-manifest.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) as AssetManifest;
      }
    } catch {
      // 清单读取失败时继续尝试下一候选路径，最终使用明确的开发态 fallback。
    }
  }

  return null;
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderAssets(manifest: AssetManifest | null): { styles: string; scripts: string } {
  const entrypoints = manifest?.entrypoints ?? [];
  const cssAssets = entrypoints.filter((asset) => asset.endsWith('.css'));
  const jsAssets = entrypoints.filter((asset) => asset.endsWith('.js'));

  const styles = cssAssets
    .map((asset) => `  <link rel="stylesheet" href="${escapeHTML(asset)}">`)
    .join('\n');
  const effectiveScripts = jsAssets.length > 0 ? jsAssets : ['/static/js/main.js'];
  const scripts = effectiveScripts
    .map((asset) => `  <script defer src="${escapeHTML(asset)}"></script>`)
    .join('\n');

  return { styles, scripts };
}

function renderStaticDocument(url: string, initialData: Record<string, unknown>): string {
  const { route } = resolveRoute(url);
  const pathname = new URL(url, 'http://nami.local').pathname;
  const appHTML = renderToString(createPageTree(route, initialData));
  const title = String(route.meta?.title ?? 'Nami Feature Showcase');
  const description = String(route.meta?.description ?? 'Nami 全功能混合渲染示例');
  const assets = renderAssets(readAssetManifest());
  const injectedData = safeStringify({
    props: initialData,
    renderMode: route.renderMode,
    routePath: pathname,
  });

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHTML(title)}</title>`,
    `  <meta name="description" content="${escapeHTML(description)}">`,
    `  <meta name="renderer" content="${escapeHTML(String(route.renderMode))}">`,
    assets.styles,
    '</head>',
    '<body>',
    `  <div id="nami-root">${appHTML}</div>`,
    `  <script>window.__NAMI_DATA__=${injectedData}</script>`,
    assets.scripts,
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 运行时传入 context 时只返回 React 片段，文档壳、manifest 与注水由 Renderer 统一处理；
 * SSG Builder 只传两个参数并原样落盘，因此这里返回完整、可 Hydration 的静态文档。
 */
export function renderToHTML(
  url: string,
  initialData: Record<string, unknown>,
  context?: RenderContext,
): string {
  if (context) {
    return renderToString(createPageTree(context.route, initialData));
  }

  return renderStaticDocument(url, initialData);
}
