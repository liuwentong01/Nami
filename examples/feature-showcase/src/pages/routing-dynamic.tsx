import { useNamiData } from '@nami/client';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

export interface DynamicRoutePageProps {
  id?: string;
  matchedPattern?: string;
  requestedPath?: string;
  requestId?: string;
  query?: Record<string, string | string[]>;
}

export default function RoutingDynamicPage(props: DynamicRoutePageProps = {}) {
  const hydrated = useNamiData<DynamicRoutePageProps>();
  const id = props.id ?? hydrated.id ?? 'unknown';
  const matchedPattern = props.matchedPattern ?? hydrated.matchedPattern ?? '/routing/:id';
  const requestedPath = props.requestedPath ?? hydrated.requestedPath ?? `/routing/${id}`;
  const requestId = props.requestId ?? hydrated.requestId ?? '注水数据未就绪';
  const query = props.query ?? hydrated.query ?? {};

  return (
    <main className="page-shell">
      <header className="page-header">
        <p>Dynamic Route</p>
        <h1>动态参数 id = {id}</h1>
        <p>
          Nami 把 `/routing/:id` 编译成匹配器，命中后将参数写入 RenderContext.params，
          getServerSideProps 和页面渲染共享同一份匹配结果。
        </p>
      </header>

      <section className="data-grid">
        <article className="feature-card">
          <h2>匹配模板</h2>
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

      <section className="feature-card">
        <h2>Query 与 params 是两套数据</h2>
        <pre className="code-block">{JSON.stringify({ params: { id }, query }, null, 2)}</pre>
      </section>

      <aside className="callout">
        <h2>优先级实验</h2>
        <p>
          路由表故意先声明 `/routing/:id`，后声明 `/routing/new`。访问静态地址时仍应命中
          `/routing/new`，因为排序阶段会让静态段优先于动态参数段。
        </p>
        <div className="button-row">
          <a className="button" href="/routing/new">
            访问静态路由 /routing/new
          </a>
          <a className="button" href="/routing/42?source=dynamic-demo">
            访问另一个动态参数
          </a>
        </div>
      </aside>
    </main>
  );
}

export async function getServerSideProps(
  context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<DynamicRoutePageProps>> {
  return {
    props: {
      id: context.params.id ?? 'unknown',
      matchedPattern: '/routing/:id',
      requestedPath: context.path,
      requestId: context.requestId,
      query: context.query,
    },
    headers: {
      'X-Nami-Route-Match': 'dynamic',
      'X-Nami-Request-Id': context.requestId,
    },
  };
}
