import { NamiLink, useRouter } from '@nami/client';

/** 客户端 wildcard 路由的兜底页面。 */
export default function NotFoundPage(): JSX.Element {
  const router = useRouter();

  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">Client route fallback</p>
        <h1>没有匹配到这个页面</h1>
        <p>
          当前地址 <code>{router.fullPath}</code> 命中了配置中的 <code>/*</code> 路由。
        </p>
      </header>

      <section className="feature-card">
        <h2>继续探索 Showcase</h2>
        <div className="button-row">
          <NamiLink className="button" to="/">
            返回功能地图
          </NamiLink>
          <NamiLink className="button button-secondary" to="/client/runtime">
            客户端运行时
          </NamiLink>
          <NamiLink className="button button-secondary" to="/stability">
            稳定性实验
          </NamiLink>
        </div>
      </section>

      <p className="callout">
        这是客户端路由兜底 UI。是否返回 HTTP 404 状态由服务端请求管线决定，不能只凭 wildcard
        组件推断。
      </p>
    </main>
  );
}
