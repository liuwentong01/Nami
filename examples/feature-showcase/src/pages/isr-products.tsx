import { useNamiData } from '@nami/client';
import type { GetStaticPropsContext, GetStaticPropsResult } from '@nami/shared';

const PAGE_KIND = 'isr-products' as const;
const PRODUCT_REVALIDATE_SECONDS = 8;

interface ProductSeed {
  id: string;
  name: string;
  category: string;
  description: string;
  price: number;
  baseStock: number;
}

export interface ProductSnapshot extends Omit<ProductSeed, 'baseStock'> {
  stock: number;
}

export interface ISRProductsData {
  pageKind: typeof PAGE_KIND;
  generatedAt: string;
  generationId: string;
  revalidateSeconds: number;
  cacheTags: string[];
  products: ProductSnapshot[];
}

export type ISRProductsPageProps = Partial<ISRProductsData> & {
  serverData?: Record<string, unknown>;
};

const PRODUCT_CATALOG: ProductSeed[] = [
  {
    id: 'edge-cache',
    name: 'Edge Cache Console',
    category: 'Caching',
    description: '观察 MISS、HIT、STALE 与后台重建状态的教学控制台。',
    price: 129,
    baseStock: 16,
  },
  {
    id: 'stream-kit',
    name: 'Streaming SSR Kit',
    category: 'Rendering',
    description: '用于拆解 Shell 优先输出、Suspense 边界和流式尾部注水。',
    price: 199,
    baseStock: 10,
  },
  {
    id: 'manifest-inspector',
    name: 'Manifest Inspector',
    category: 'Build',
    description: '检查页面模块、客户端资源和构建产物之间的映射。',
    price: 89,
    baseStock: 22,
  },
  {
    id: 'hydration-probe',
    name: 'Hydration Probe',
    category: 'Client Runtime',
    description: '定位服务端标记与浏览器首帧不一致的可控探针。',
    price: 149,
    baseStock: 13,
  },
];

function createProductSnapshot(seed: ProductSeed, revision: number): ProductSnapshot {
  return {
    id: seed.id,
    name: seed.name,
    category: seed.category,
    description: seed.description,
    price: seed.price,
    stock: Math.max(0, seed.baseStock - (revision % 5)),
  };
}

function isISRProductsData(value: unknown): value is ISRProductsData {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<ISRProductsData>;
  return (
    candidate.pageKind === PAGE_KIND &&
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.generationId === 'string' &&
    typeof candidate.revalidateSeconds === 'number' &&
    Array.isArray(candidate.cacheTags) &&
    Array.isArray(candidate.products)
  );
}

function useCompatibleData(props: ISRProductsPageProps): ISRProductsData | null {
  const hydratedData = useNamiData<unknown>();
  const directServerData = isISRProductsData(props) ? props : props.serverData;

  if (typeof window === 'undefined') {
    return isISRProductsData(directServerData) ? directServerData : null;
  }

  if (isISRProductsData(hydratedData)) return hydratedData;
  return isISRProductsData(directServerData) ? directServerData : null;
}

function formatSnapshot(isoTime: string): string {
  return isoTime.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * 首次构建与每次后台重建都会调用此函数。库存根据时间片轻微变化，便于肉眼
 * 确认 stale 响应之后是否已经换成新快照。
 */
export async function getStaticProps(
  _context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<ISRProductsData>> {
  const now = Date.now();
  const revision = Math.floor(now / 1000);

  return {
    props: {
      pageKind: PAGE_KIND,
      generatedAt: new Date(now).toISOString(),
      generationId: `catalog-${now.toString(36)}`,
      revalidateSeconds: PRODUCT_REVALIDATE_SECONDS,
      cacheTags: ['catalog'],
      products: PRODUCT_CATALOG.map((product) => createProductSnapshot(product, revision)),
    },
    revalidate: PRODUCT_REVALIDATE_SECONDS,
  };
}

export default function ISRProductsPage(props: ISRProductsPageProps = {}) {
  const data = useCompatibleData(props);

  if (!data) {
    return (
      <main className="page-shell" data-render-mode="isr">
        <section className="callout">
          <h1>ISR 快照尚未生成</h1>
          <p>请刷新页面发起完整请求；缓存 MISS 会阻塞等待首个 HTML 快照。</p>
          <a href="/products">重新请求 /products</a>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell" data-render-mode="isr">
      <header className="page-header">
        <p>Render mode · ISR</p>
        <h1>增量商品目录</h1>
        <p>
          页面最多每 {data.revalidateSeconds} 秒进入一次 stale 窗口。过期请求先获得旧 HTML， Nami
          再在后台合并重建任务，后续请求读取新快照。
        </p>
      </header>

      <section className="data-grid" aria-label="ISR 快照信息">
        <article className="feature-card">
          <h2>Generation ID</h2>
          <p>
            <code>{data.generationId}</code>
          </p>
        </article>
        <article className="feature-card">
          <h2>生成时间</h2>
          <p>{formatSnapshot(data.generatedAt)}</p>
        </article>
        <article className="feature-card">
          <h2>Revalidate</h2>
          <p>
            <code>{data.revalidateSeconds}s</code>
          </p>
        </article>
        <article className="feature-card">
          <h2>Cache tags</h2>
          <p>
            <code>{data.cacheTags.join(', ')}</code>
          </p>
        </article>
      </section>

      <section>
        <h2>当前缓存快照</h2>
        <div className="feature-grid">
          {data.products.map((product) => (
            <article className="feature-card" key={product.id}>
              <p>{product.category}</p>
              <h3>{product.name}</h3>
              <p>{product.description}</p>
              <dl className="data-grid">
                <div>
                  <dt>价格</dt>
                  <dd>¥{product.price.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>快照库存</dt>
                  <dd>{product.stock}</dd>
                </div>
              </dl>
              <a href={`/products/${product.id}`}>请求商品详情</a>
            </article>
          ))}
        </div>
      </section>

      <section className="callout">
        <h2>观察 HIT → STALE → HIT</h2>
        <p>
          查看响应头 <code>X-Nami-Cache</code>、<code>X-Nami-Cache-Age</code> 与
          <code> Cache-Control</code>；<code>X-Nami-Cache-Tags</code> 当前只在 MISS
          响应可见。浏览器刷新或 curl 都会发起真实文档请求。
        </p>
        <pre className="code-block">
          <code>{`curl -sD - -o /dev/null http://localhost:3100/products | grep -i "x-nami-cache\\|cache-control"
sleep 9
curl -sD - -o /dev/null http://localhost:3100/products | grep -i "x-nami-cache\\|cache-control"
sleep 1
curl -sD - -o /dev/null http://localhost:3100/products | grep -i "x-nami-cache\\|cache-control"`}</code>
        </pre>
      </section>
    </main>
  );
}
