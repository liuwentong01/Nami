import { useNamiData } from '@nami/client';
import type {
  GetStaticPathsResult,
  GetStaticPropsContext,
  GetStaticPropsResult,
} from '@nami/shared';

const PAGE_KIND = 'content-article' as const;

interface ArticleSection {
  heading: string;
  paragraphs: string[];
}

interface ArticleRecord {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  sections: ArticleSection[];
}

export interface ContentArticleData {
  pageKind: typeof PAGE_KIND;
  generatedAt: string;
  routeParams: { slug: string };
  article: ArticleRecord;
}

export type ContentArticlePageProps = Partial<ContentArticleData> & {
  serverData?: Record<string, unknown>;
};

const ARTICLES: Record<string, ArticleRecord> = {
  'rendering-pipeline': {
    slug: 'rendering-pipeline',
    title: '从路由配置到静态 HTML',
    description: '一次 SSG 构建任务如何穿过路由表、ModuleLoader、数据函数与 HTML 输出。',
    tags: ['SSG', 'Builder', 'RenderResult'],
    sections: [
      {
        heading: '1. 路由决定构建任务',
        paragraphs: [
          '路由的 renderMode=SSG 会让 Builder 把它加入静态生成队列；动态路由还会先执行 getStaticPaths 展开实际 URL。',
          'component 与 getStaticProps 保存的是模块路径和导出名，构建器通过 ModuleLoader 在服务端产物中找到真实函数。',
        ],
      },
      {
        heading: '2. 数据只在构建阶段求值',
        paragraphs: [
          'getStaticProps 的返回值成为页面快照。请求到达时服务端直接读取生成文件，不需要再次执行业务数据函数。',
          '因此 SSG 适合内容稳定、允许随发布更新的页面；频繁变化的数据更适合 ISR 或 SSR。',
        ],
      },
    ],
  },
  'data-hydration': {
    slug: 'data-hydration',
    title: '静态数据如何完成 Hydration',
    description: '同一份 props 如何同时驱动服务端标记与浏览器第一次 React render。',
    tags: ['Data', 'Serialization', 'Hydration'],
    sections: [
      {
        heading: '1. HTML 与数据必须来自同一快照',
        paragraphs: [
          '构建器先用 getStaticProps 的结果渲染页面，再把相同对象安全序列化到 window.__NAMI_DATA__。',
          '页面不能在 render 中重新生成随机数或当前时间，否则服务端文本和浏览器首帧不同，会触发 Hydration 警告。',
        ],
      },
      {
        heading: '2. 浏览器恢复交互',
        paragraphs: [
          'initNamiClient 读取注水数据，useNamiData 返回稳定快照，hydrateRoot 在已有 DOM 上绑定事件。',
          '完成 Hydration 后全局脚本可以被清理，但客户端数据读取器仍保留首次快照。',
        ],
      },
    ],
  },
  'route-manifest': {
    slug: 'route-manifest',
    title: '动态 SSG 与构建清单',
    description: 'getStaticPaths、页面模块与资源 manifest 如何共同生成可部署页面。',
    tags: ['getStaticPaths', 'Manifest', 'ModuleLoader'],
    sections: [
      {
        heading: '1. getStaticPaths 枚举有限空间',
        paragraphs: [
          '动态路由 /content/:slug 无法仅凭模式知道要输出哪些文件，getStaticPaths 因此返回一组 params。',
          '本例 fallback=false，未声明的 slug 不会在请求时临时生成；当前运行时会把缺失静态文件交给错误隔离，而不是转换为路由级 404。',
        ],
      },
      {
        heading: '2. 两类清单各司其职',
        paragraphs: [
          '模块清单帮助服务端按 component 路径找到页面和数据函数；资源 manifest 则把逻辑入口映射到带 hash 的 JS/CSS 文件。',
          'HTML 组装阶段消费资源清单，避免在开启长期缓存后仍硬编码 main.js。',
        ],
      },
    ],
  },
};

function isContentArticleData(value: unknown): value is ContentArticleData {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<ContentArticleData>;
  return (
    candidate.pageKind === PAGE_KIND &&
    typeof candidate.generatedAt === 'string' &&
    !!candidate.routeParams &&
    typeof candidate.routeParams.slug === 'string' &&
    !!candidate.article &&
    typeof candidate.article.slug === 'string' &&
    Array.isArray(candidate.article.sections)
  );
}

function useCompatibleData(props: ContentArticlePageProps): ContentArticleData | null {
  const hydratedData = useNamiData<unknown>();
  const directServerData = isContentArticleData(props) ? props : props.serverData;

  if (typeof window === 'undefined') {
    return isContentArticleData(directServerData) ? directServerData : null;
  }

  if (isContentArticleData(hydratedData)) return hydratedData;
  return isContentArticleData(directServerData) ? directServerData : null;
}

function formatSnapshot(isoTime: string): string {
  return isoTime.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** 构建阶段枚举全部合法 slug；fallback=false 表示不做请求时生成。 */
export async function getStaticPaths(): Promise<GetStaticPathsResult> {
  return {
    paths: Object.keys(ARTICLES).map((slug) => ({ params: { slug } })),
    fallback: false,
  };
}

export async function getStaticProps(
  context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<ContentArticleData>> {
  const slug = context.params.slug;
  if (!slug) return { notFound: true };

  const article = ARTICLES[slug];

  if (!article) return { notFound: true };

  return {
    props: {
      pageKind: PAGE_KIND,
      generatedAt: new Date().toISOString(),
      routeParams: { slug },
      article,
    },
  };
}

export default function ContentArticlePage(props: ContentArticlePageProps = {}) {
  const data = useCompatibleData(props);

  if (!data) {
    return (
      <main className="page-shell" data-render-mode="ssg">
        <section className="callout">
          <h1>文章快照不可用</h1>
          <p>该动态 SSG 页面需要构建期 props。请返回内容索引并重新打开已预生成文章。</p>
          <a href="/content">返回 /content</a>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell" data-render-mode="ssg">
      <header className="page-header">
        <p>Render mode · Dynamic SSG</p>
        <h1>{data.article.title}</h1>
        <p>{data.article.description}</p>
        <p>{data.article.tags.join(' · ')}</p>
      </header>

      <section className="data-grid" aria-label="动态 SSG 信息">
        <article className="feature-card">
          <h2>匹配参数</h2>
          <p>
            <code>slug={data.routeParams.slug}</code>
          </p>
        </article>
        <article className="feature-card">
          <h2>生成时间</h2>
          <p>{formatSnapshot(data.generatedAt)}</p>
        </article>
        <article className="feature-card">
          <h2>Fallback</h2>
          <p>
            <code>false</code>，未知 slug 不做运行时生成。
          </p>
        </article>
      </section>

      <article>
        {data.article.sections.map((section) => (
          <section className="feature-card" key={section.heading}>
            <h2>{section.heading}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </article>

      <section className="callout">
        <h2>与 ISR 对照</h2>
        <p>
          本页只在构建时生成；访问未列入 getStaticPaths 的地址不会触发后台重建。 ISR 商品虽然也由
          getStaticPaths 生成部分构建文件，但当前运行缓存不会读取这些文件，
          所有合法商品在新进程中都会从首次 MISS 开始。
        </p>
        <p>
          <a href="/products/manifest-inspector">打开未列入 getStaticPaths 的 ISR 商品</a>
        </p>
        <p>
          <a href="/content">返回静态内容索引</a>
        </p>
      </section>
    </main>
  );
}
