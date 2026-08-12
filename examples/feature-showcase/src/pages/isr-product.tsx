import { useNamiData } from '@nami/client';
import type {
  GetStaticPathsResult,
  GetStaticPropsContext,
  GetStaticPropsResult,
} from '@nami/shared';

const PAGE_KIND = 'isr-product' as const;
const PRODUCT_REVALIDATE_SECONDS = 8;
const STATIC_PATH_PRODUCT_IDS = new Set(['edge-cache', 'stream-kit']);

interface ProductRecord {
  id: string;
  name: string;
  category: string;
  description: string;
  price: number;
  baseStock: number;
}

interface ProductSnapshot extends Omit<ProductRecord, 'baseStock'> {
  stock: number;
}

/**
 * 详情页保留自己的轻量服务端数据源，避免从另一个 page module 导入数据后
 * 把列表页组件一起带入详情页 chunk。真实项目中应改为独立的 server data 模块。
 */
const PRODUCT_CATALOG: ProductRecord[] = [
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

function createProductSnapshot(seed: ProductRecord, revision: number): ProductSnapshot {
  return {
    id: seed.id,
    name: seed.name,
    category: seed.category,
    description: seed.description,
    price: seed.price,
    stock: Math.max(0, seed.baseStock - (revision % 5)),
  };
}

export interface ISRProductData {
  pageKind: typeof PAGE_KIND;
  generatedAt: string;
  generationId: string;
  routeParams: { id: string };
  revalidateSeconds: number;
  cacheTags: string[];
  declaredInStaticPaths: boolean;
  product: ProductSnapshot;
}

export type ISRProductPageProps = Partial<ISRProductData> & {
  serverData?: Record<string, unknown>;
};

function isISRProductData(value: unknown): value is ISRProductData {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<ISRProductData>;
  return (
    candidate.pageKind === PAGE_KIND &&
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.generationId === 'string' &&
    !!candidate.routeParams &&
    typeof candidate.routeParams.id === 'string' &&
    typeof candidate.revalidateSeconds === 'number' &&
    Array.isArray(candidate.cacheTags) &&
    typeof candidate.declaredInStaticPaths === 'boolean' &&
    !!candidate.product &&
    typeof candidate.product.id === 'string'
  );
}

function useCompatibleData(props: ISRProductPageProps): ISRProductData | null {
  const hydratedData = useNamiData<unknown>();
  const directServerData = isISRProductData(props) ? props : props.serverData;

  if (typeof window === 'undefined') {
    return isISRProductData(directServerData) ? directServerData : null;
  }

  if (isISRProductData(hydratedData)) return hydratedData;
  return isISRProductData(directServerData) ? directServerData : null;
}

function formatSnapshot(isoTime: string): string {
  return isoTime.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * Builder 会为这里列出的两个商品生成静态文件。当前 ISRManager 启动时尚不会
 * 用这些文件预热运行时缓存；fallback='blocking' 则由冷 MISS 的同步渲染链路兑现。
 * 因此新进程里，列出和未列出的合法商品都会先等待一次完整渲染。
 */
export async function getStaticPaths(): Promise<GetStaticPathsResult> {
  return {
    paths: Array.from(STATIC_PATH_PRODUCT_IDS, (id) => ({ params: { id } })),
    fallback: 'blocking',
  };
}

export async function getStaticProps(
  context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<ISRProductData>> {
  const id = context.params.id;
  if (!id) return { notFound: true };

  const productSeed = PRODUCT_CATALOG.find((candidate) => candidate.id === id);

  if (!productSeed) return { notFound: true };

  const now = Date.now();
  const revision = Math.floor(now / 1000);

  return {
    props: {
      pageKind: PAGE_KIND,
      generatedAt: new Date(now).toISOString(),
      generationId: `product-${id}-${now.toString(36)}`,
      routeParams: { id },
      revalidateSeconds: PRODUCT_REVALIDATE_SECONDS,
      cacheTags: ['catalog', 'product'],
      declaredInStaticPaths: STATIC_PATH_PRODUCT_IDS.has(id),
      product: createProductSnapshot(productSeed, revision),
    },
    revalidate: PRODUCT_REVALIDATE_SECONDS,
  };
}

export default function ISRProductPage(props: ISRProductPageProps = {}) {
  const data = useCompatibleData(props);

  if (!data) {
    return (
      <main className="page-shell" data-render-mode="isr">
        <section className="callout">
          <h1>商品数据暂不可用</h1>
          <p>
            正常服务端请求若由 getStaticProps 返回 <code>notFound: true</code>，ISRRenderer
            会直接返回无 Hydration 的静态 404 且不写入缓存；这里仅作为客户端数据缺失时的防御 UI。
          </p>
          <a href="/products">返回商品目录</a>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell" data-render-mode="isr">
      <header className="page-header">
        <p>Render mode · Dynamic ISR</p>
        <h1>{data.product.name}</h1>
        <p>{data.product.description}</p>
      </header>

      <section className="data-grid" aria-label="商品数据">
        <article className="feature-card">
          <h2>价格</h2>
          <p>¥{data.product.price.toFixed(2)}</p>
        </article>
        <article className="feature-card">
          <h2>快照库存</h2>
          <p>{data.product.stock}</p>
        </article>
        <article className="feature-card">
          <h2>动态参数</h2>
          <p>
            <code>id={data.routeParams.id}</code>
          </p>
        </article>
        <article className="feature-card">
          <h2>静态路径声明</h2>
          <p>
            {data.declaredInStaticPaths
              ? '已列入 getStaticPaths（构建产物存在）'
              : '未列入 getStaticPaths（无构建期文件）'}
          </p>
        </article>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <h2>Generation ID</h2>
          <p>
            <code>{data.generationId}</code>
          </p>
          <p>生成于 {formatSnapshot(data.generatedAt)}</p>
        </article>
        <article className="feature-card">
          <h2>缓存策略</h2>
          <p>
            <code>revalidate: {data.revalidateSeconds}</code>
          </p>
          <p>
            <code>tags: {data.cacheTags.join(', ')}</code>
          </p>
        </article>
      </section>

      <section className="callout">
        <h2>构建产物与运行时缓存不是同一层</h2>
        <p>
          <code>edge-cache</code> 与 <code>stream-kit</code> 在构建期生成；
          <code>manifest-inspector</code> 与 <code>hydration-probe</code> 不在 getStaticPaths 中。
          当前运行时不会用构建文件预热 ISR 缓存；<code>fallback='blocking'</code> 明确表示冷 MISS
          由当前请求等待完整 HTML。新进程中两类地址都会先返回 <code>MISS</code>，随后才进入{' '}
          <code>HIT → STALE → HIT</code>。
        </p>
        <pre className="code-block">
          <code>{`curl -sD - -o /dev/null http://localhost:3100/products/edge-cache
curl -sD - -o /dev/null http://localhost:3100/products/manifest-inspector
curl -sD - -o /dev/null http://localhost:3100/products/edge-cache
curl -sD - -o /dev/null http://localhost:3100/products/manifest-inspector
sleep 9
curl -sD - -o /dev/null http://localhost:3100/products/manifest-inspector
sleep 1
curl -sD - -o /dev/null http://localhost:3100/products/manifest-inspector`}</code>
        </pre>
        <p>
          <a href="/products">返回 ISR 商品目录</a>
        </p>
      </section>
    </main>
  );
}
