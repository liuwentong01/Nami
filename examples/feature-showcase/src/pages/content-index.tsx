import { useNamiData } from '@nami/client';
import type { GetStaticPropsContext, GetStaticPropsResult } from '@nami/shared';

const PAGE_KIND = 'content-index' as const;

export interface ContentSummary {
  slug: string;
  title: string;
  summary: string;
  readingMinutes: number;
  tags: string[];
}

export interface ContentIndexData {
  pageKind: typeof PAGE_KIND;
  generatedAt: string;
  buildSnapshot: string;
  articles: ContentSummary[];
}

export type ContentIndexPageProps = Partial<ContentIndexData> & {
  /** 兼容 entry-server 选择“单一 serverData prop”的传递方式。 */
  serverData?: Record<string, unknown>;
};

const ARTICLES: ContentSummary[] = [
  {
    slug: 'rendering-pipeline',
    title: '从路由配置到静态 HTML',
    summary: '跟踪 Nami 如何在构建期匹配 SSG 路由、执行 getStaticProps，并把页面写入静态产物。',
    readingMinutes: 6,
    tags: ['SSG', 'Builder', 'RenderResult'],
  },
  {
    slug: 'data-hydration',
    title: '静态数据如何完成 Hydration',
    summary: '理解构建期 props、HTML 数据脚本与浏览器 useNamiData 之间的完整传递链。',
    readingMinutes: 5,
    tags: ['Data', 'Serialization', 'Hydration'],
  },
  {
    slug: 'route-manifest',
    title: '动态 SSG 与构建清单',
    summary: '通过 getStaticPaths 预生成多个 slug，并观察路由模块清单和资源 manifest 的职责边界。',
    readingMinutes: 7,
    tags: ['getStaticPaths', 'Manifest', 'ModuleLoader'],
  },
];

function isContentIndexData(value: unknown): value is ContentIndexData {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<ContentIndexData>;
  return (
    candidate.pageKind === PAGE_KIND &&
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.buildSnapshot === 'string' &&
    Array.isArray(candidate.articles)
  );
}

function useCompatibleData(props: ContentIndexPageProps): ContentIndexData | null {
  const hydratedData = useNamiData<unknown>();
  const directServerData = isContentIndexData(props) ? props : props.serverData;

  if (typeof window === 'undefined') {
    return isContentIndexData(directServerData) ? directServerData : null;
  }

  if (isContentIndexData(hydratedData)) return hydratedData;
  return isContentIndexData(directServerData) ? directServerData : null;
}

function formatSnapshot(isoTime: string): string {
  return isoTime.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * 构建期执行一次。返回值会同时进入静态 HTML 和注水脚本，因此组件不能在
 * render 阶段重新生成时间戳，否则浏览器 Hydration 会出现文本不一致。
 */
export async function getStaticProps(
  _context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<ContentIndexData>> {
  const generatedAt = new Date().toISOString();

  return {
    props: {
      pageKind: PAGE_KIND,
      generatedAt,
      buildSnapshot: `content-${Date.now().toString(36)}`,
      articles: ARTICLES,
    },
  };
}

export default function ContentIndexPage(props: ContentIndexPageProps = {}) {
  const data = useCompatibleData(props);

  if (!data) {
    return (
      <main className="page-shell" data-render-mode="ssg">
        <section className="callout">
          <h1>静态内容数据尚未注入</h1>
          <p>请直接刷新当前地址，让 Nami 返回构建期生成的 HTML 与数据快照。</p>
          <a href="/content">重新请求 /content</a>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell" data-render-mode="ssg">
      <header className="page-header">
        <p>Render mode · SSG</p>
        <h1>构建期内容中心</h1>
        <p>
          当前列表由 <code>getStaticProps</code> 在构建阶段生成。查看页面源代码时，
          标题、摘要和构建快照已经存在，不依赖浏览器二次请求。
        </p>
      </header>

      <section className="data-grid" aria-label="SSG 构建信息">
        <article className="feature-card">
          <h2>生成时间</h2>
          <p>{formatSnapshot(data.generatedAt)}</p>
        </article>
        <article className="feature-card">
          <h2>构建快照</h2>
          <p>
            <code>{data.buildSnapshot}</code>
          </p>
        </article>
        <article className="feature-card">
          <h2>Fallback</h2>
          <p>
            <code>false</code>：仅 getStaticPaths 声明的文章会生成；未知路径当前进入错误隔离。
          </p>
        </article>
      </section>

      <section>
        <h2>预生成文章</h2>
        <div className="feature-grid">
          {data.articles.map((article) => (
            <article className="feature-card" key={article.slug}>
              <p>{article.tags.join(' · ')}</p>
              <h3>{article.title}</h3>
              <p>{article.summary}</p>
              <p>预计阅读 {article.readingMinutes} 分钟</p>
              {/*
               * 数据路由故意发起完整文档请求，方便在 Network 面板同时观察
               * 静态 HTML、数据脚本与资源加载；NamiLink 在 client/runtime 演示。
               */}
              <a href={`/content/${article.slug}`}>打开静态文章</a>
            </article>
          ))}
        </div>
      </section>

      <section className="callout">
        <h2>验证 SSG</h2>
        <p>连续刷新时构建快照保持不变；只有重新执行 nami build/generate 才会更新。</p>
        <pre className="code-block">
          <code>{`curl -s http://localhost:3100/content | grep "构建快照"
curl -s http://localhost:3100/content/rendering-pipeline | grep "pageKind"`}</code>
        </pre>
      </section>
    </main>
  );
}
