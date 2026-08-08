import { useState } from 'react';
import { ClientErrorBoundary, useRouter } from '@nami/client';
import {
  SkeletonAvatar,
  SkeletonButton,
  SkeletonCard,
  SkeletonPage,
  SkeletonText,
} from '@nami/plugin-skeleton';

interface CrashProbeProps {
  shouldCrash: boolean;
}

function CrashProbe({ shouldCrash }: CrashProbeProps): JSX.Element {
  if (shouldCrash) {
    throw new Error('Stability Lab：受控组件在 React render 阶段抛错');
  }

  return (
    <div className="callout" role="status">
      子组件渲染正常。点击“触发 render 错误”后，只有这张卡片会进入降级 UI。
    </div>
  );
}

/** 客户端稳定性实验：真实 React 错误边界与可控骨架组件。 */
export default function StabilityPage(): JSX.Element {
  const router = useRouter();
  const [shouldCrash, setShouldCrash] = useState(false);
  const [shouldCrashGlobally, setShouldCrashGlobally] = useState(false);
  const [capturedError, setCapturedError] = useState<string>('尚未捕获错误');
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [apiProbe, setApiProbe] = useState('尚未请求可控故障端点');

  if (shouldCrashGlobally) {
    throw new Error('Stability Lab：错误已逃逸到 NamiErrorBoundaryPlugin 全局边界');
  }

  const runAPIProbe = async (path: string): Promise<void> => {
    setApiProbe(`正在请求 ${path}…`);

    try {
      const response = await fetch(path);
      const payload = (await response.json()) as { message?: string; source?: string };
      setApiProbe(
        `${response.status} ${response.statusText} · ${payload.message ?? payload.source ?? '请求完成'}`,
      );
    } catch (error) {
      setApiProbe(`网络层失败 · ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">CSR · Controlled failure injection</p>
        <h1>客户端稳定性实验室</h1>
        <p>
          用受控方式观察局部/全局 React 错误隔离、恢复流程、骨架屏和 503
          请求错误；所有故障都被限制在实验边界内，不会让服务进程崩溃。
        </p>
      </header>

      <section className="feature-grid">
        <article className="feature-card">
          <h2>ClientErrorBoundary</h2>
          <p>
            点击按钮只修改状态；错误在下一次子组件 render 中抛出，因此能够被 React Error Boundary
            捕获。
          </p>
          <ClientErrorBoundary
            resetKeys={[router.path]}
            onError={(error) => {
              setCapturedError(error.message);
            }}
            onReset={() => {
              setShouldCrash(false);
            }}
            fallback={({ error, resetErrorBoundary }) => (
              <div className="callout" role="alert">
                <h3>局部组件已被隔离</h3>
                <p>{error.message}</p>
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    setShouldCrash(false);
                    resetErrorBoundary();
                  }}
                >
                  清除故障并重试
                </button>
              </div>
            )}
          >
            <CrashProbe shouldCrash={shouldCrash} />
          </ClientErrorBoundary>
          <div className="button-row">
            <button
              className="button"
              type="button"
              disabled={shouldCrash}
              onClick={() => setShouldCrash(true)}
            >
              触发 render 错误
            </button>
          </div>
          <pre className="code-block">{capturedError}</pre>
        </article>

        <article className="feature-card">
          <h2>骨架屏原子组件</h2>
          <p>这些组件可直接组合进业务 loading 状态，不依赖未打通的路由自动替换能力。</p>
          <div className="skeleton-row" aria-label="骨架屏原子组件示例">
            <SkeletonAvatar size="large" animation="pulse" />
            <div className="skeleton-copy">
              <SkeletonText lines={3} width={['100%', '85%', '55%']} animation="pulse" />
            </div>
            <SkeletonButton size="medium" animation="pulse" />
          </div>
          <SkeletonCard
            animation="pulse"
            imageHeight={110}
            showImage
            showAvatar
            showActions
            textLines={2}
          />
        </article>

        <article className="feature-card">
          <h2>插件安装的全局 Error Boundary</h2>
          <p>
            这个错误不放在局部 ClientErrorBoundary 内，会由
            <code> NamiErrorBoundaryPlugin.wrapApp</code> 安装的最外层边界捕获。
            在全局错误页点击重试后，页面组件会重新挂载并恢复初始状态。
          </p>
          <button
            className="button button--danger"
            type="button"
            onClick={() => setShouldCrashGlobally(true)}
          >
            触发全局 render 错误
          </button>
        </article>

        <article className="feature-card">
          <h2>可控 503 与恢复请求</h2>
          <p>
            自定义 Koa 中间件提供一个固定返回 503 的端点。先观察非 2xx，再请求健康端点，
            证明业务可以在不刷新页面的情况下恢复。
          </p>
          <div className="button-row">
            <button
              className="button button--danger"
              type="button"
              onClick={() => void runAPIProbe('/api/showcase/failure')}
            >
              请求可控 503
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void runAPIProbe('/api/showcase/runtime')}
            >
              请求健康端点
            </button>
          </div>
          <pre className="code-block" aria-live="polite">
            {apiProbe}
          </pre>
        </article>
      </section>

      <section className="feature-card" aria-labelledby="skeleton-page-heading">
        <h2 id="skeleton-page-heading">页面级 SkeletonPage</h2>
        <div className="button-row">
          <button
            className="button"
            type="button"
            onClick={() => setShowSkeleton((visible) => !visible)}
          >
            {showSkeleton ? '显示真实内容' : '模拟页面加载'}
          </button>
        </div>
        {showSkeleton ? (
          <div aria-busy="true" aria-label="仪表盘正在加载">
            <SkeletonPage layout="dashboard" animation="pulse" dashboardCardCount={4} showCharts />
          </div>
        ) : (
          <div className="data-grid" aria-busy="false">
            <article className="feature-card">
              <span className="data-label">健康请求</span>
              <strong className="data-value">99.98%</strong>
            </article>
            <article className="feature-card">
              <span className="data-label">P95 SSR</span>
              <strong className="data-value">184ms</strong>
            </article>
            <article className="feature-card">
              <span className="data-label">降级次数</span>
              <strong className="data-value">0</strong>
            </article>
            <article className="feature-card">
              <span className="data-label">缓存命中</span>
              <strong className="data-value">87%</strong>
            </article>
          </div>
        )}
      </section>

      <aside className="callout">
        <strong>能力边界：</strong>React 错误边界只能捕获子树 render、生命周期和构造函数错误；
        事件处理器、异步任务与 SSR 错误需要各自的处理管线。示例使用 <code>pulse</code> 动画，
        不依赖当前缺少关键帧定义的 <code>wave</code> 动画。
      </aside>
    </main>
  );
}
