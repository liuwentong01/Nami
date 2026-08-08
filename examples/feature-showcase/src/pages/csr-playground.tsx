import { useEffect, useRef, useState } from 'react';

interface ActivityItem {
  id: number;
  message: string;
}

export default function CSRPlaygroundPage() {
  const [count, setCount] = useState(0);
  const [draft, setDraft] = useState('');
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [mountedAt, setMountedAt] = useState('尚未执行 useEffect');
  const nextActivityId = useRef(1);

  useEffect(() => {
    setMountedAt(new Date().toLocaleTimeString('zh-CN'));
    document.title = `CSR count: ${count} · Nami Showcase`;
  }, [count]);

  const addActivity = () => {
    const message = draft.trim();
    if (!message) return;

    setActivities((current) => [...current, { id: nextActivityId.current++, message }]);
    setDraft('');
  };

  return (
    <main className="page-shell">
      <header className="page-header">
        <p>RenderMode.CSR</p>
        <h1>CSR Playground</h1>
        <p>
          此页不声明服务端数据函数。HTML 壳到达浏览器后，React 通过 createRoot 创建页面，
          状态变化只触发客户端重渲染，不会再次请求 Nami 服务端渲染器。
        </p>
      </header>

      <section className="feature-grid">
        <article className="feature-card">
          <h2>本地状态</h2>
          <p>当前计数：{count}</p>
          <div className="button-row">
            <button className="button" type="button" onClick={() => setCount((value) => value - 1)}>
              -1
            </button>
            <button className="button" type="button" onClick={() => setCount(0)}>
              重置
            </button>
            <button className="button" type="button" onClick={() => setCount((value) => value + 1)}>
              +1
            </button>
          </div>
        </article>

        <article className="feature-card">
          <h2>客户端副作用</h2>
          <p>最近一次 effect 执行时间：{mountedAt}</p>
          <p>每次计数变化都会更新 document.title，用于区分渲染与副作用阶段。</p>
        </article>
      </section>

      <section className="feature-card">
        <h2>交互式列表</h2>
        <p>输入内容只保存在浏览器内存中，刷新页面后会消失。</p>
        <div className="button-row">
          <input
            aria-label="活动内容"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addActivity();
            }}
            placeholder="例如：检查客户端 Network 面板"
          />
          <button className="button" type="button" onClick={addActivity}>
            添加
          </button>
        </div>
        {activities.length > 0 ? (
          <ul>
            {activities.map((item) => (
              <li key={item.id}>{item.message}</li>
            ))}
          </ul>
        ) : (
          <p>还没有客户端活动。</p>
        )}
      </section>

      <section className="data-grid">
        <article className="feature-card">
          <h2>HTML 生成位置</h2>
          <p>浏览器</p>
        </article>
        <article className="feature-card">
          <h2>首屏数据位置</h2>
          <p>客户端请求或本地状态</p>
        </article>
        <article className="feature-card">
          <h2>挂载 API</h2>
          <p>React 18 createRoot</p>
        </article>
      </section>

      <aside className="callout">
        <h2>面试检查点</h2>
        <p>
          CSR 的优势不是“天然更快”，而是服务端计算少、交互模型简单；代价是首屏依赖 JS、 SEO
          能力弱，且数据请求通常要等客户端启动后才发生。
        </p>
      </aside>
    </main>
  );
}
