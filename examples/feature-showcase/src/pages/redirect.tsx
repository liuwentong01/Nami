import { NamiLink } from '@nami/client';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

interface RedirectPageProps {
  destination?: string;
}

const REDIRECT_DESTINATION = '/client/runtime?from=server-redirect';

/**
 * 直接请求 /redirect 时，SSRRenderer 会在渲染组件前处理 redirect 结果。
 * 该组件仅作为客户端导航到此路由时的可解释兜底。
 */
export default function RedirectPage({
  destination = REDIRECT_DESTINATION,
}: RedirectPageProps = {}): JSX.Element {
  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">Client-side fallback</p>
        <h1>服务端重定向演示</h1>
        <p>
          浏览器直接请求 <code>/redirect</code> 时，<code>getServerSideProps</code> 返回 307，
          服务端写入 <code>Location</code> 后不会渲染此组件。
        </p>
      </header>
      <section className="feature-card">
        <p>
          你现在看到该组件，通常意味着通过 SPA 客户端路由进入；客户端 Router 本身不会重新执行 服务端
          GSSP 重定向响应。
        </p>
        <NamiLink className="button" to={destination}>
          前往重定向目标
        </NamiLink>
      </section>
    </main>
  );
}

export async function getServerSideProps(
  _context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<RedirectPageProps>> {
  return {
    redirect: {
      destination: REDIRECT_DESTINATION,
      permanent: false,
      statusCode: 307,
    },
    headers: {
      'X-Nami-Showcase-Result': 'redirect',
    },
  };
}
