import { useNamiData } from '@nami/client';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

export interface StaticRoutePageProps {
  matchedPattern?: string;
  requestedPath?: string;
  requestId?: string;
  routeOrderNote?: string;
}

export default function RoutingStaticPage(props: StaticRoutePageProps = {}) {
  const hydrated = useNamiData<StaticRoutePageProps>();
  const matchedPattern = props.matchedPattern ?? hydrated.matchedPattern ?? '/routing/new';
  const requestedPath = props.requestedPath ?? hydrated.requestedPath ?? '/routing/new';
  const requestId = props.requestId ?? hydrated.requestId ?? '注水数据未就绪';
  const routeOrderNote =
    props.routeOrderNote ?? hydrated.routeOrderNote ?? '静态段的匹配分数高于动态参数段。';

  return (
    <main className="page-shell">
      <header className="page-header">
        <p>Static Route Priority</p>
        <h1>/routing/new 命中了静态路由</h1>
        <p>{routeOrderNote}</p>
      </header>

      <section className="data-grid">
        <article className="feature-card">
          <h2>最终模板</h2>
          <p>{matchedPattern}</p>
        </article>
        <article className="feature-card">
          <h2>实际路径</h2>
          <p>{requestedPath}</p>
        </article>
        <article className="feature-card">
          <h2>requestId</h2>
          <p>{requestId}</p>
        </article>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <h2>声明顺序</h2>
          <pre className="code-block">/routing/:id{`\n`}/routing/new</pre>
          <p>动态路由故意写在前面。</p>
        </article>
        <article className="feature-card">
          <h2>匹配顺序</h2>
          <pre className="code-block">/routing/new{`\n`}/routing/:id</pre>
          <p>rankRoutes 根据路径特异性重新排序。</p>
        </article>
      </section>

      <aside className="callout">
        <h2>如何证明不是动态参数 new？</h2>
        <p>
          除页面标题外，服务端还返回 `X-Nami-Route-Match: static`。使用 curl 查看响应头， 再访问
          `/routing/42` 对比 dynamic 响应头。
        </p>
        <div className="button-row">
          <a className="button" href="/routing/42">
            对比动态路由
          </a>
          <a className="button" href="/">
            返回首页
          </a>
        </div>
      </aside>
    </main>
  );
}

export async function getServerSideProps(
  context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<StaticRoutePageProps>> {
  return {
    props: {
      matchedPattern: '/routing/new',
      requestedPath: context.path,
      requestId: context.requestId,
      routeOrderNote: '即使静态路由声明在动态路由之后，rankRoutes 仍会优先匹配静态段。',
    },
    headers: {
      'X-Nami-Route-Match': 'static',
      'X-Nami-Request-Id': context.requestId,
    },
  };
}
