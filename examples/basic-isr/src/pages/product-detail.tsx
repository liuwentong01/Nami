/**
 * 商品详情页 — ISR 动态路由示例
 *
 * 本页面演示 ISR 模式下的动态路由处理：
 *
 * 1. getStaticPaths + fallback: 'blocking'
 *    - 构建时预渲染 paths 中列出的商品页面
 *    - 未列出的商品（如新上架商品）在首次被访问时：
 *      a. 服务端阻塞式渲染该页面
 *      b. 渲染完成后返回给用户，同时缓存结果
 *      c. 后续访问直接命中缓存
 *
 * 2. getStaticProps + revalidate: 30
 *    - 每个商品页面每 30 秒重验证一次
 *    - 商品信息（价格、库存等）变动后最多 30 秒生效
 *
 * 这种组合适合：
 * - 商品数量大（不可能全部预渲染）
 * - 热门商品需要极速响应
 * - 商品信息需要准实时更新
 */
import React from 'react';
import type {
  GetStaticPropsContext,
  GetStaticPropsResult,
  GetStaticPathsResult,
} from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface ProductDetail {
  id: number;
  name: string;
  description: string;
  longDescription: string;
  price: number;
  originalPrice?: number;
  category: string;
  inStock: boolean;
  stockCount: number;
  specifications: Array<{
    label: string;
    value: string;
  }>;
  imageUrl: string;
}

interface ProductDetailPageProps {
  product: ProductDetail;
  /** 页面生成时间 */
  generatedAt: string;
  /** 重验证间隔 */
  revalidateInterval: number;
}

/* ==================== 页面组件 ==================== */

export default function ProductDetailPage({
  product,
  generatedAt,
  revalidateInterval,
}: ProductDetailPageProps) {
  return (
    <div className="page-product-detail">
      <div className="product-detail">
        <div className="product-detail-image">
          <div
            className="image-placeholder"
            style={{ backgroundImage: `url(${product.imageUrl})` }}
          />
        </div>

        <div className="product-detail-info">
          <span className="product-category">{product.category}</span>
          <h1>{product.name}</h1>
          <p className="product-description">{product.description}</p>

          <div className="product-pricing-detail">
            <span className="current-price">&yen;{product.price.toFixed(2)}</span>
            {product.originalPrice && (
              <span className="original-price">&yen;{product.originalPrice.toFixed(2)}</span>
            )}
          </div>

          <div className="stock-info">
            {product.inStock ? (
              <span className="in-stock">有货（剩余 {product.stockCount} 件）</span>
            ) : (
              <span className="no-stock">暂时缺货</span>
            )}
          </div>

          <div className="specifications">
            <h3>商品规格</h3>
            <table>
              <tbody>
                {product.specifications.map((spec) => (
                  <tr key={spec.label}>
                    <td className="spec-label">{spec.label}</td>
                    <td className="spec-value">{spec.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <section className="product-long-desc">
        <h2>商品详情</h2>
        {product.longDescription.split('\n\n').map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </section>

      <div className="isr-debug">
        <h3>ISR 调试信息</h3>
        <p>页面生成时间：{generatedAt}</p>
        <p>重验证间隔：{revalidateInterval} 秒</p>
        <p>提示：刷新页面观察生成时间的变化，可以验证 ISR 的 stale-while-revalidate 行为。</p>
      </div>

      <a href="/products" className="back-link">
        &larr; 返回商品列表
      </a>
    </div>
  );
}

/* ==================== 模拟数据源 ==================== */

/** 模拟商品数据库 */
const MOCK_PRODUCTS: Record<string, ProductDetail> = {
  '1001': {
    id: 1001,
    name: 'TypeScript 实战进阶',
    description: '从类型体操到架构设计，深入掌握 TypeScript 在大型项目中的应用技巧。',
    longDescription: `本书面向有一定 TypeScript 基础的开发者，系统讲解 TypeScript 在实际工程中的高级应用。

内容涵盖：高级类型编程（条件类型、映射类型、模板字面量类型）、类型安全的设计模式、大型项目的类型架构策略、与 React/Node.js 深度集成的最佳实践。

通过 30+ 个真实案例，帮助你从"会用 TypeScript"进阶到"精通 TypeScript"。`,
    price: 79.00,
    originalPrice: 99.00,
    category: '技术书籍',
    inStock: true,
    stockCount: 152,
    specifications: [
      { label: '作者', value: '张大前端' },
      { label: '出版社', value: '电子工业出版社' },
      { label: '页数', value: '420 页' },
      { label: 'ISBN', value: '978-7-121-00001-0' },
    ],
    imageUrl: '/images/book-ts.png',
  },
  '1002': {
    id: 1002,
    name: 'React 性能优化权威指南',
    description: '全面覆盖 React 应用的性能优化策略。',
    longDescription: `React 应用的性能优化是一个系统工程，本书从理论到实践进行了全面讲解。

涵盖内容：React 渲染机制深入分析、组件重渲染优化（React.memo、useMemo、useCallback）、虚拟列表与大数据渲染、代码分割与懒加载、状态管理性能陷阱、Server Components 原理与实践。

每个优化策略都配有性能测量数据和可运行的示例代码，让你的优化有据可依。`,
    price: 89.00,
    category: '技术书籍',
    inStock: true,
    stockCount: 89,
    specifications: [
      { label: '作者', value: '李性能' },
      { label: '出版社', value: '人民邮电出版社' },
      { label: '页数', value: '380 页' },
      { label: 'ISBN', value: '978-7-121-00002-0' },
    ],
    imageUrl: '/images/book-react.png',
  },
  '1003': {
    id: 1003,
    name: '机械键盘 — 银轴版',
    description: '87 键紧凑布局，Cherry MX 银轴，RGB 背光。',
    longDescription: `专为程序员设计的高性能机械键盘。

采用 Cherry MX 银轴，触发行程仅 1.2mm，响应极速，适合高频代码输入场景。87 键紧凑布局节省桌面空间，同时保留了方向键和功能键区。

全键无冲突设计，支持自定义 RGB 背光方案，Type-C 可拆卸数据线。PBT 双色注塑键帽，耐磨不打油。`,
    price: 599.00,
    originalPrice: 699.00,
    category: '外设装备',
    inStock: true,
    stockCount: 45,
    specifications: [
      { label: '轴体', value: 'Cherry MX 银轴' },
      { label: '键数', value: '87 键' },
      { label: '连接方式', value: 'USB Type-C' },
      { label: '背光', value: 'RGB 可自定义' },
    ],
    imageUrl: '/images/keyboard.png',
  },
};

/** 热门商品 ID 列表（构建时预渲染） */
const HOT_PRODUCT_IDS = ['1001', '1002', '1003'];

/* ==================== 构建时路径生成 ==================== */

/**
 * 生成需要预渲染的商品路径
 *
 * 仅预渲染热门商品页面，其他商品页面在首次访问时按需生成。
 * fallback: 'blocking' 确保用户首次访问未预渲染的商品时，
 * 会等待服务端渲染完成后返回完整页面（而非显示加载状态）。
 */
export async function getStaticPaths(): Promise<GetStaticPathsResult> {
  return {
    paths: HOT_PRODUCT_IDS.map((id) => ({
      params: { id },
    })),
    /**
     * 'blocking' 模式：
     * 未预渲染的路径在首次请求时阻塞等待渲染完成。
     * 用户不会看到加载中的空页面，但首次访问会稍慢。
     * 渲染完成后结果会被缓存，后续请求直接命中缓存。
     */
    fallback: 'blocking',
  };
}

/* ==================== 构建时 / 重验证时数据获取 ==================== */

/**
 * 获取商品详情数据
 *
 * 执行时机：
 * 1. 构建时：为 getStaticPaths 返回的每个商品获取数据
 * 2. 首次访问未预渲染商品时：阻塞式获取数据
 * 3. 缓存过期后：后台异步重新获取数据
 */
export async function getStaticProps(
  context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<ProductDetailPageProps>> {
  const { id } = context.params;

  /** 模拟 API 请求 */
  await new Promise((resolve) => setTimeout(resolve, 120));

  const product = MOCK_PRODUCTS[id];

  if (!product) {
    return { notFound: true };
  }

  return {
    props: {
      product,
      generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      revalidateInterval: 30,
    },
    /** 30 秒后重验证 — 商品价格、库存等信息需要较高时效性 */
    revalidate: 30,
  };
}
