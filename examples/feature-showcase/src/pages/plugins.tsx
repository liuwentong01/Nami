import { useEffect, useState } from 'react';
import { useNamiData } from '@nami/client';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

interface PluginsPageProps {
  requestId?: string;
  requestPath?: string;
  serverRenderedAt?: string;
  userAgent?: string;
}

interface ClientEvent {
  name: string;
  at: string;
  detail?: Record<string, unknown>;
}

interface PluginSummary {
  name: string;
  enforce: 'pre' | 'normal' | 'post';
  hooks: string[];
  purpose: string;
  boundary: string;
}

const PLUGIN_SUMMARIES: PluginSummary[] = [
  {
    name: 'showcase:lifecycle',
    enforce: 'pre',
    hooks: [
      'modifyWebpackConfig',
      'addServerMiddleware',
      'onBeforeRender',
      'onAfterRender',
      'onClientInit',
      'onHydrated',
      'onRouteChange',
    ],
    purpose: '把构建、Koa、渲染与浏览器生命周期转换为日志、响应头、API 和事件时间线。',
    boundary: '它只负责制造可观察证据，不改变 Nami 内核的渲染或错误语义。',
  },
  {
    name: 'nami:request',
    enforce: 'normal',
    hooks: ['onServerStart', 'onClientInit', 'onDispose'],
    purpose: '分别安装 Node.js 与浏览器请求适配器，并组合缓存、重试、超时。',
    boundary: 'useRequest 的自动请求发生在客户端 effect，不替代 GSSP/GSP。',
  },
  {
    name: 'nami:skeleton',
    enforce: 'post',
    hooks: ['wrapApp', 'onBeforeRender', 'onRenderError', 'onDispose'],
    purpose: '提供 Suspense fallback、骨架组件和 SSR 出错时可消费的骨架 HTML。',
    boundary: '路由 layout 标记不会在正常渲染中自动替换页面内容。',
  },
  {
    name: 'nami:error-boundary',
    enforce: 'post',
    hooks: ['wrapApp', 'onError', 'onDispose'],
    purpose: '用全局 RouteErrorBoundary 包裹客户端 React 树，并接收客户端错误生命周期。',
    boundary: '示例关闭了 onRenderError 服务端降级，只承诺客户端错误隔离。',
  },
  {
    name: 'nami:monitor',
    enforce: 'post',
    hooks: ['onAfterRender', 'onRenderError', 'onDispose'],
    purpose: '采集服务端渲染指标，并把批次发送到示例监控端点。',
    boundary: 'enableWebVitals=false，因此插件不注册 onHydrated，避免和框架采集重复。',
  },
];

function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '—';
  return JSON.stringify(detail, null, 2);
}

function normalizeHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? 'unknown';
}

/**
 * 插件页同时展示两类证据：GSSP 返回的本次服务端请求信息，以及自定义
 * showcase 插件写入 window 的客户端 hook 事件。页面不会伪造未发生的 hook。
 */
export default function PluginsPage(props: PluginsPageProps = {}): JSX.Element {
  const hydrated = useNamiData<PluginsPageProps>();
  const {
    requestId = '客户端导航未携带 GSSP 数据',
    requestPath = '/plugins',
    serverRenderedAt = '—',
    userAgent = '—',
  } = {
    ...hydrated,
    ...props,
  };
  const [clientEvents, setClientEvents] = useState<ClientEvent[]>([]);

  const readClientEvents = (): void => {
    if (typeof window === 'undefined') return;
    setClientEvents([...(window.__NAMI_SHOWCASE_EVENTS__ ?? [])]);
  };

  useEffect(() => {
    readClientEvents();

    const handleClientEvent = (): void => {
      readClientEvents();
    };

    window.addEventListener('nami-showcase:event', handleClientEvent);
    return () => {
      window.removeEventListener('nami-showcase:event', handleClientEvent);
    };
  }, []);

  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">SSR · Plugin lifecycle</p>
        <h1>插件注册、Hook 与可观察证据</h1>
        <p>
          PluginManager 按 <code>pre → normal → post</code> 排序注册插件；不同类型的 Hook 再按
          parallel、series 或 waterfall 语义调度。
        </p>
      </header>

      <section className="feature-card" aria-labelledby="server-evidence-heading">
        <h2 id="server-evidence-heading">本次 SSR 请求</h2>
        <dl className="data-grid">
          <div>
            <dt className="data-label">requestId</dt>
            <dd className="data-value">{requestId}</dd>
          </div>
          <div>
            <dt className="data-label">path</dt>
            <dd className="data-value">{requestPath}</dd>
          </div>
          <div>
            <dt className="data-label">GSSP 完成时间</dt>
            <dd className="data-value">{serverRenderedAt}</dd>
          </div>
          <div>
            <dt className="data-label">user-agent</dt>
            <dd className="data-value">{userAgent}</dd>
          </div>
        </dl>
        <p className="callout">
          这些值来自页面导出的 <code>getServerSideProps</code>；它们证明数据预取发生在本次请求，
          不代表每个插件 Hook 都已执行。
        </p>
      </section>

      <section className="feature-grid" aria-label="官方插件生命周期">
        {PLUGIN_SUMMARIES.map((plugin) => (
          <article className="feature-card" key={plugin.name}>
            <p className="eyebrow">{plugin.enforce}</p>
            <h2>{plugin.name}</h2>
            <p>{plugin.purpose}</p>
            <pre className="code-block">{plugin.hooks.join(' → ')}</pre>
            <p className="callout">实现边界：{plugin.boundary}</p>
          </article>
        ))}
      </section>

      <section className="feature-card" aria-labelledby="client-events-heading">
        <h2 id="client-events-heading">客户端 Hook 事件</h2>
        <p>
          自定义 showcase 插件把真实触发的客户端事件写入
          <code>window.__NAMI_SHOWCASE_EVENTS__</code>。点击按钮可读取最新快照。
        </p>
        <div className="button-row">
          <button className="button" type="button" onClick={readClientEvents}>
            刷新事件快照
          </button>
        </div>
        {clientEvents.length === 0 ? (
          <p className="callout">当前没有可见事件；请确认客户端入口已注册 showcase 插件。</p>
        ) : (
          <ol className="event-list">
            {clientEvents.map((event, index) => (
              <li className="feature-card" key={`${event.name}-${event.at}-${index}`}>
                <strong>{event.name}</strong>
                <span className="data-value">{event.at}</span>
                <pre className="code-block">{formatDetail(event.detail)}</pre>
              </li>
            ))}
          </ol>
        )}
        <p className="callout">
          浏览器运行时目前没有通用的 SPA 销毁入口，因此本页不会伪造客户端
          <code>onDispose</code>；服务端关闭时的销毁日志请在终端观察。
        </p>
      </section>
    </main>
  );
}

export async function getServerSideProps(
  context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<PluginsPageProps>> {
  return {
    props: {
      requestId: context.requestId,
      requestPath: context.path,
      serverRenderedAt: new Date().toISOString(),
      userAgent: normalizeHeader(context.headers['user-agent']),
    },
    headers: {
      'X-Nami-Showcase-Page': 'plugins',
    },
    cache: {
      maxAge: 0,
      staleWhileRevalidate: 0,
    },
  };
}
