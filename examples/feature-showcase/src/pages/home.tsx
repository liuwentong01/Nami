import { useNamiData } from '@nami/client';
import type { GetStaticPropsResult } from '@nami/shared';

export interface HomePageProps {
  generatedAt?: string;
  showcaseVersion?: string;
  routeCount?: number;
}

const modeCards = [
  {
    title: 'CSR',
    path: '/rendering/csr',
    summary: '服务端返回页面壳，状态、事件与数据请求都在浏览器中执行。',
  },
  {
    title: 'SSR',
    path: '/rendering/ssr/interviewer?topic=context',
    summary: '每次请求读取 params、query、headers 与 requestId，再生成完整 HTML。',
  },
  {
    title: 'Streaming SSR',
    path: '/rendering/streaming',
    summary: 'Shell 先返回，Suspense 边界就绪后继续向响应流写入内容。',
  },
  {
    title: 'SSG',
    path: '/content',
    summary: '构建阶段执行数据函数并生成静态 HTML，运行阶段直接读取产物。',
  },
  {
    title: 'ISR',
    path: '/products',
    summary: '用 MISS、HIT、STALE 与后台重建在性能和内容时效之间取平衡。',
  },
  {
    title: '插件与稳定性',
    path: '/plugins',
    summary: '通过生命周期钩子接入监控、骨架、请求与错误处理等横切能力。',
  },
];

export default function HomePage(props: HomePageProps = {}) {
  const hydrated = useNamiData<HomePageProps>();
  const generatedAt = props.generatedAt ?? hydrated.generatedAt ?? '等待构建期数据';
  const showcaseVersion = props.showcaseVersion ?? hydrated.showcaseVersion ?? 'development';
  const routeCount = props.routeCount ?? hydrated.routeCount ?? 0;

  return (
    <main className="page-shell">
      <header className="page-header">
        <p>Nami Feature Showcase</p>
        <h1>用一个应用走通 Nami 的完整渲染链路</h1>
        <p>
          这里不是组件展览，而是一张可运行的面试地图：同一份路由配置同时驱动 Webpack 任务划分、Koa
          路由匹配、Renderer 选择和客户端 Hydration。
        </p>
        <div className="button-row">
          <a className="button" href="/rendering/csr">
            从 CSR 开始
          </a>
          <a className="button" href="/rendering/ssr/nami?topic=render-context">
            查看 SSR 上下文
          </a>
        </div>
      </header>

      <section className="data-grid" aria-label="构建信息">
        <article className="feature-card">
          <h2>本页模式</h2>
          <p>SSG：数据在构建阶段确定，HTML 可在请求到达前准备好。</p>
        </article>
        <article className="feature-card">
          <h2>生成时间</h2>
          <p>{generatedAt}</p>
        </article>
        <article className="feature-card">
          <h2>示例版本</h2>
          <p>{showcaseVersion}</p>
        </article>
        <article className="feature-card">
          <h2>路由数量</h2>
          <p>{routeCount || '由构建期注入'}</p>
        </article>
      </section>

      <section>
        <header className="page-header">
          <h2>按链路学习，而不是按文件背诵</h2>
          <p>打开页面后同时观察 View Source、Network、响应头、控制台和服务端日志。</p>
        </header>
        <div className="feature-grid">
          {modeCards.map((card) => (
            <article className="feature-card" key={card.title}>
              <h3>{card.title}</h3>
              <p>{card.summary}</p>
              <a className="button" href={card.path}>
                进入实验
              </a>
            </article>
          ))}
        </div>
      </section>

      <aside className="callout">
        <h2>面试回答主线</h2>
        <p>
          先说明页面为什么选择该模式，再描述数据在哪个阶段获取、HTML 在哪里生成、
          浏览器如何接管，最后补充缓存、失败路径和可观测性。源码细节应服务于这条主线。
        </p>
      </aside>
    </main>
  );
}

export async function getStaticProps(): Promise<GetStaticPropsResult<HomePageProps>> {
  return {
    props: {
      generatedAt: new Date().toISOString(),
      showcaseVersion: process.env.NAMI_PUBLIC_SHOWCASE_VERSION ?? '2026.08',
      routeCount: 16,
    },
  };
}
