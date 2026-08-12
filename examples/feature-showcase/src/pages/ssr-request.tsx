import { useNamiData } from '@nami/client';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

export interface SSRRequestPageProps {
  name?: string;
  path?: string;
  requestId?: string;
  receivedAt?: string;
  query?: Record<string, string | string[]>;
  cookieNames?: string[];
  userAgent?: string;
}

function formatQuery(query: Record<string, string | string[]>): string {
  return Object.keys(query).length > 0 ? JSON.stringify(query, null, 2) : '{}';
}

export default function SSRRequestPage(props: SSRRequestPageProps = {}) {
  const hydrated = useNamiData<SSRRequestPageProps>();
  const data: Required<SSRRequestPageProps> = {
    name: props.name ?? hydrated.name ?? 'anonymous',
    path: props.path ?? hydrated.path ?? '/rendering/ssr/:name',
    requestId: props.requestId ?? hydrated.requestId ?? '注水数据未就绪',
    receivedAt: props.receivedAt ?? hydrated.receivedAt ?? '注水数据未就绪',
    query: props.query ?? hydrated.query ?? {},
    cookieNames: props.cookieNames ?? hydrated.cookieNames ?? [],
    userAgent: props.userAgent ?? hydrated.userAgent ?? 'unknown',
  };

  return (
    <main className="page-shell">
      <header className="page-header">
        <p>RenderMode.SSR</p>
        <h1>你好，{data.name}</h1>
        <p>
          刷新页面时，Koa 为本次请求创建 RenderContext，SSRRenderer 执行
          getServerSideProps，再把返回值用于服务端 React 渲染和客户端注水。
        </p>
      </header>

      <section className="data-grid">
        <article className="feature-card">
          <h2>requestId</h2>
          <p>{data.requestId}</p>
        </article>
        <article className="feature-card">
          <h2>请求路径</h2>
          <p>{data.path}</p>
        </article>
        <article className="feature-card">
          <h2>服务端时间</h2>
          <p>{data.receivedAt}</p>
        </article>
        <article className="feature-card">
          <h2>Cookie 名称</h2>
          <p>{data.cookieNames.length > 0 ? data.cookieNames.join(', ') : '无'}</p>
        </article>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <h2>Query</h2>
          <pre className="code-block">{formatQuery(data.query)}</pre>
        </article>
        <article className="feature-card">
          <h2>User-Agent</h2>
          <pre className="code-block">{data.userAgent}</pre>
        </article>
      </section>

      <aside className="callout">
        <h2>为什么只展示 Cookie 名称？</h2>
        <p>
          服务端可以读取 Cookie，但把令牌或会话值注入 HTML 会扩大泄露面。页面只演示上下文能力，
          不把敏感值发送给浏览器。
        </p>
      </aside>

      <section className="feature-card">
        <h2>可复现请求</h2>
        <pre className="code-block">
          curl -i &apos;http://localhost:3100/rendering/ssr/interviewer?topic=context&apos;
        </pre>
        <p>观察 HTML、X-Nami-Showcase、X-Nami-Request-Id 与 Cache-Control。</p>
        <p>
          <code>staticServe</code> 只会为实际命中的静态文件补缓存头，不会覆盖 SSR
          的响应策略；本页应保留 GSSP 渲染结果的 <code>private, no-cache</code>。
        </p>
      </section>
    </main>
  );
}

export async function getServerSideProps(
  context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<SSRRequestPageProps>> {
  const userAgentHeader = context.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader)
    ? userAgentHeader.join(', ')
    : (userAgentHeader ?? 'unknown');

  return {
    props: {
      name: context.params.name ?? 'anonymous',
      path: context.path,
      requestId: context.requestId,
      receivedAt: new Date().toISOString(),
      query: context.query,
      cookieNames: Object.keys(context.cookies).sort(),
      userAgent,
    },
    headers: {
      'X-Nami-Showcase': 'ssr-request',
      'X-Nami-Request-Id': context.requestId,
    },
  };
}
