import { NamiLink } from '@nami/client';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

/**
 * 直接请求此路由时，SSRRenderer 会把 notFound 数据结果转换为 HTTP 404。
 * 组件仅用于解释客户端导航没有重新执行 GSSP 的边界。
 */
export default function DataNotFoundPage(): JSX.Element {
  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">Client-side fallback</p>
        <h1>数据层 notFound 演示</h1>
        <p>
          浏览器直接请求 <code>/data-not-found</code> 时，页面的
          <code>getServerSideProps</code> 返回 <code>{'{ notFound: true }'}</code>， SSRRenderer
          在组件渲染前生成 HTTP 404 响应。
        </p>
      </header>

      <section className="feature-card">
        <p>
          如果通过 SPA 导航看到此说明页，代表客户端 Router
          只加载了组件，并未重新执行服务端数据函数。
        </p>
        <div className="button-row">
          <NamiLink className="button" to="/">
            返回首页
          </NamiLink>
          <NamiLink className="button button-secondary" to="/this-route-does-not-exist">
            对比 wildcard 页面
          </NamiLink>
        </div>
      </section>

      <p className="callout">
        <code>notFound</code> 是数据预取结果；它与客户端 <code>/*</code> 兜底组件是两条不同路径。
      </p>
    </main>
  );
}

export async function getServerSideProps(
  _context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult> {
  return {
    notFound: true,
    headers: {
      'X-Nami-Showcase-Result': 'not-found',
    },
  };
}
