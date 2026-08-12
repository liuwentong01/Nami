import { useState } from 'react';
import {
  NamiLink,
  getPrefetchedData,
  prefetchRoute,
  useClientFetch,
  useRouter,
} from '@nami/client';
import { useRequest } from '@nami/plugin-request';
import { SkeletonText } from '@nami/plugin-skeleton';

type JsonRecord = Record<string, unknown>;
type PrefetchState = 'idle' | 'loading' | 'hit' | 'empty';

const PREFETCH_TARGET = '/rendering/ssr/prefetched?source=client-runtime';

function formatJSON(value: unknown): string {
  if (value === undefined) return '等待请求…';
  if (value === null) return 'null';

  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * 客户端运行时实验室。
 *
 * 这个页面刻意使用 CSR：浏览器可以直接观察路由状态、代码预取、
 * 数据预取缓存和两套客户端请求 API，而不会把它们误解为服务端数据预取。
 */
export default function ClientRuntimePage(): JSX.Element {
  const router = useRouter();
  const [prefetchState, setPrefetchState] = useState<PrefetchState>('idle');
  const [prefetchedData, setPrefetchedData] = useState<JsonRecord | null>(null);

  const runtimeRequest = useClientFetch<JsonRecord>('/api/showcase/runtime', {
    cacheTime: 5_000,
    staleWhileRevalidate: true,
  });
  const hasRuntimeData = runtimeRequest.data !== undefined;
  const isRuntimeInitialLoading = runtimeRequest.loading && !hasRuntimeData;
  const isRuntimeRefreshing = runtimeRequest.loading && hasRuntimeData;

  // NamiRequestPlugin 会在 onClientInit 中安装浏览器请求适配器。
  // useRequest 的自动请求发生在 useEffect 中，不承担 SSR 数据加载职责。
  const profileRequest = useRequest<JsonRecord>('/api/showcase/profile');

  const handleExplicitPrefetch = async (): Promise<void> => {
    setPrefetchState('loading');

    await prefetchRoute(PREFETCH_TARGET, {
      prefetchChunk: true,
      prefetchData: true,
      timeout: 5_000,
    });

    // 当前预取缓存不会被路由切换或页面 Hook 自动消费，调用方需显式读取。
    const cached = getPrefetchedData<JsonRecord>(PREFETCH_TARGET);
    setPrefetchedData(cached);
    setPrefetchState(cached ? 'hit' : 'empty');
  };

  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">CSR · Browser runtime</p>
        <h1>Nami 客户端运行时实验室</h1>
        <p>
          在同一页观察客户端 Router、路由代码预取、显式数据缓存读取、
          <code>useClientFetch</code> 与请求插件的 <code>useRequest</code>。
        </p>
      </header>

      <section className="feature-grid" aria-labelledby="router-heading">
        <article className="feature-card">
          <h2 id="router-heading">useRouter 状态</h2>
          <dl className="data-grid">
            <div>
              <dt className="data-label">path</dt>
              <dd className="data-value">{router.path}</dd>
            </div>
            <div>
              <dt className="data-label">fullPath</dt>
              <dd className="data-value">{router.fullPath}</dd>
            </div>
            <div>
              <dt className="data-label">hash</dt>
              <dd className="data-value">{router.hash || '（空）'}</dd>
            </div>
          </dl>
          <pre className="code-block" aria-label="当前 query 参数">
            {formatJSON(router.query)}
          </pre>
          <div className="button-row">
            <button
              className="button"
              type="button"
              onClick={() => router.push('/client/runtime?navigation=push#router-state')}
            >
              push 更新 URL
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => router.replace('/client/runtime?navigation=replace#router-state')}
            >
              replace 当前记录
            </button>
            <button className="button button-secondary" type="button" onClick={router.back}>
              back
            </button>
            <button className="button button-secondary" type="button" onClick={router.forward}>
              forward
            </button>
          </div>
        </article>

        <article className="feature-card">
          <h2>NamiLink 与路由代码预取</h2>
          <p>
            悬停或进入视口时，<code>NamiLink</code> 会预取目标路由的 JS chunk。
            这一步默认不会请求页面数据。
          </p>
          <div className="button-row">
            <NamiLink className="button" to="/content" prefetchOnHover prefetchDelay={80}>
              Hover 预取 SSG 路由
            </NamiLink>
            <NamiLink
              className="button button-secondary"
              to="/products"
              prefetchOnVisible
              prefetchMargin="200px"
            >
              进入视口预取 ISR 路由
            </NamiLink>
          </div>
        </article>
      </section>

      <section className="feature-card" aria-labelledby="prefetch-heading">
        <h2 id="prefetch-heading">编程式预取：chunk + SSR 数据</h2>
        <p>
          目标：<code>{PREFETCH_TARGET}</code>。完成后，本页通过
          <code>getPrefetchedData</code> 显式读取内存缓存。
        </p>
        <div className="button-row">
          <button
            className="button"
            type="button"
            disabled={prefetchState === 'loading'}
            onClick={() => {
              void handleExplicitPrefetch();
            }}
          >
            {prefetchState === 'loading' ? '预取中…' : '开始显式预取'}
          </button>
          <NamiLink className="button button-secondary" to={PREFETCH_TARGET}>
            导航到目标路由
          </NamiLink>
        </div>
        <p className="callout" role="status" aria-live="polite">
          {prefetchState === 'idle' && '尚未执行预取。'}
          {prefetchState === 'loading' && '正在加载路由 chunk 与数据端点。'}
          {prefetchState === 'hit' && '数据已写入预取缓存，并由本页显式读出。'}
          {prefetchState === 'empty' && '没有读到缓存；请检查数据预取端点和服务端日志。'}
        </p>
        <pre className="code-block">{formatJSON(prefetchedData)}</pre>
        <p className="callout">
          边界说明：当前预取数据缓存不会自动注入目标页面，也不会自动成为
          <code>useClientFetch</code> 或 <code>useRequest</code> 的初始值。
        </p>
      </section>

      <section className="feature-grid" aria-label="客户端请求 API">
        <article className="feature-card">
          <p className="eyebrow">@nami/client</p>
          <h2>useClientFetch + SWR</h2>
          <p>
            固定 URL 使用 5 秒缓存；首次没有数据时展示局部骨架，缓存过期时保留旧值并在后台更新。
          </p>
          <p className="data-value" aria-live="polite">
            {isRuntimeInitialLoading && '首次请求中…'}
            {isRuntimeRefreshing && '正在后台刷新，旧数据继续可见…'}
            {!runtimeRequest.loading &&
              runtimeRequest.error &&
              (hasRuntimeData ? '刷新失败，继续展示旧数据' : '请求失败')}
            {!runtimeRequest.loading && !runtimeRequest.error && hasRuntimeData && '请求完成'}
          </p>
          {runtimeRequest.error && !hasRuntimeData && (
            <div className="callout callout--danger" role="alert">
              <strong>数据加载失败</strong>
              <p>{runtimeRequest.error.message}</p>
              <button
                className="button"
                type="button"
                onClick={() => {
                  void runtimeRequest.refetch();
                }}
              >
                重试请求
              </button>
            </div>
          )}
          {isRuntimeInitialLoading ? (
            <div
              className="skeleton-row"
              role="status"
              aria-live="polite"
              aria-label="运行时数据加载中"
            >
              <div className="skeleton-copy">
                <SkeletonText lines={4} width={['100%', '82%', '92%', '58%']} animation="pulse" />
              </div>
            </div>
          ) : hasRuntimeData ? (
            <>
              {runtimeRequest.error && (
                <div className="callout callout--danger" role="alert">
                  <strong>后台刷新失败，继续展示旧数据</strong>
                  <p>{runtimeRequest.error.message}</p>
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      void runtimeRequest.refetch();
                    }}
                  >
                    重试刷新
                  </button>
                </div>
              )}
              <pre className="code-block">{formatJSON(runtimeRequest.data)}</pre>
            </>
          ) : null}
          <div className="button-row">
            <button
              className="button"
              type="button"
              onClick={() => {
                void runtimeRequest.refetch();
              }}
            >
              忽略缓存刷新
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                runtimeRequest.mutate((previous) => ({
                  ...(previous ?? {}),
                  optimisticNote: '这条字段由 mutate 在本地写入',
                }));
              }}
            >
              mutate 本地数据
            </button>
          </div>
        </article>

        <article className="feature-card">
          <p className="eyebrow">@nami/plugin-request</p>
          <h2>useRequest + 插件适配器</h2>
          <p>
            请求插件在 <code>onClientInit</code> 安装适配器，并组合缓存、重试和超时拦截器。
          </p>
          <p className="data-value" aria-live="polite">
            {profileRequest.loading ? '请求中…' : profileRequest.error ? '请求失败' : '请求完成'}
          </p>
          {profileRequest.error && (
            <p className="callout" role="alert">
              {profileRequest.error.message}
            </p>
          )}
          <pre className="code-block">{formatJSON(profileRequest.data)}</pre>
          <div className="button-row">
            <button
              className="button"
              type="button"
              onClick={() => {
                void profileRequest.refresh();
              }}
            >
              refresh
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={profileRequest.cancel}
            >
              cancel
            </button>
          </div>
          <p className="callout">
            <code>useRequest</code> 的自动请求由客户端 effect 触发；SSR 页面数据仍应使用
            <code>getServerSideProps</code>。
          </p>
        </article>
      </section>
    </main>
  );
}
