import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { useNamiData } from '@nami/client';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

export interface StreamingPageProps {
  requestId?: string;
  requestedAt?: string;
  shellMessage?: string;
}

interface DelayedPanelProps {
  requestId: string;
}

interface StreamingPanelSet {
  MetricsPanel: LazyExoticComponent<ComponentType<DelayedPanelProps>>;
  RecommendationPanel: LazyExoticComponent<ComponentType<DelayedPanelProps>>;
}

const MAX_REQUEST_PANEL_SETS = 64;
const panelSetsByRequest = new Map<string, StreamingPanelSet>();

function MetricsPanelContent({ requestId }: DelayedPanelProps) {
  return (
    <article className="feature-card">
      <h2>边界 A：关键指标已就绪</h2>
      <p>此模块延迟约 700ms 后 resolve，React 随后把它写入已有响应流。</p>
      <pre className="code-block">requestId: {requestId}</pre>
    </article>
  );
}

function RecommendationPanelContent({ requestId }: DelayedPanelProps) {
  return (
    <article className="feature-card">
      <h2>边界 B：次要内容已就绪</h2>
      <p>较慢内容不会阻塞 Shell 和边界 A，适合推荐流、评论或复杂报表。</p>
      <pre className="code-block">stream: {requestId}</pre>
    </article>
  );
}

function createDelayedPanel(
  delay: number,
  component: ComponentType<DelayedPanelProps>,
): LazyExoticComponent<ComponentType<DelayedPanelProps>> {
  return lazy(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { default: component };
  });
}

/**
 * React.lazy 会缓存已 resolve 的模块。若把 Lazy 组件定义成模块级单例，只有
 * 进程中的第一次请求能看到分块。这里按 requestId 复用一次请求内的 Promise，
 * 同时限制缓存大小，让每个新文档请求都能稳定复现 700ms/1400ms 两个边界。
 */
function getStreamingPanels(requestId: string): StreamingPanelSet {
  const cached = panelSetsByRequest.get(requestId);
  if (cached) return cached;

  if (panelSetsByRequest.size >= MAX_REQUEST_PANEL_SETS) {
    const oldestRequestId = panelSetsByRequest.keys().next().value;
    if (oldestRequestId) panelSetsByRequest.delete(oldestRequestId);
  }

  const panels: StreamingPanelSet = {
    MetricsPanel: createDelayedPanel(700, MetricsPanelContent),
    RecommendationPanel: createDelayedPanel(1400, RecommendationPanelContent),
  };
  panelSetsByRequest.set(requestId, panels);
  return panels;
}

function BoundaryFallback({ label }: { label: string }) {
  return (
    <article className="callout" aria-live="polite">
      <h2>{label}</h2>
      <p>Suspense fallback 已随 Shell 到达，等待服务端继续推送真实内容……</p>
    </article>
  );
}

export default function StreamingPage(props: StreamingPageProps = {}) {
  const hydrated = useNamiData<StreamingPageProps>();
  const requestId = props.requestId ?? hydrated.requestId ?? 'stream-demo';
  const requestedAt = props.requestedAt ?? hydrated.requestedAt ?? '注水数据未就绪';
  const shellMessage =
    props.shellMessage ?? hydrated.shellMessage ?? 'Shell 可以先于异步边界返回。';
  const { MetricsPanel, RecommendationPanel } = getStreamingPanels(requestId);

  return (
    <main className="page-shell">
      <header className="page-header">
        <p>SSR + route.meta.streaming</p>
        <h1>Streaming SSR 与 Suspense 分块</h1>
        <p>{shellMessage}</p>
      </header>

      <section className="data-grid">
        <article className="feature-card">
          <h2>Shell</h2>
          <p>标题、说明和 fallback 无需等待所有数据完成。</p>
        </article>
        <article className="feature-card">
          <h2>requestId</h2>
          <p>{requestId}</p>
        </article>
        <article className="feature-card">
          <h2>请求开始</h2>
          <p>{requestedAt}</p>
        </article>
      </section>

      <section className="feature-grid">
        <Suspense fallback={<BoundaryFallback label="边界 A 正在等待" />}>
          <MetricsPanel requestId={requestId} />
        </Suspense>

        <Suspense fallback={<BoundaryFallback label="边界 B 正在等待" />}>
          <RecommendationPanel requestId={requestId} />
        </Suspense>
      </section>

      <aside className="callout">
        <h2>用命令行观察真正的流</h2>
        <pre className="code-block">curl -N -D - http://localhost:3100/rendering/streaming</pre>
        <p>
          `renderToPipeableStream` 的价值是提前发送可展示的 Shell，而不是让总计算量消失。
          面试中还应说明 Shell 错误、边界错误、超时 abort 与客户端选择性 Hydration。
        </p>
      </aside>
    </main>
  );
}

export async function getServerSideProps(
  context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<StreamingPageProps>> {
  return {
    props: {
      requestId: context.requestId,
      requestedAt: new Date().toISOString(),
      shellMessage: '服务端会先输出 Shell，再分别完成两个延时 Suspense 边界。',
    },
    headers: {
      'X-Nami-Showcase': 'streaming-ssr',
      'X-Nami-Request-Id': context.requestId,
    },
  };
}
