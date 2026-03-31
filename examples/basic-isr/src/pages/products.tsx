/**
 * 商品列表页 — ISR 增量静态再生示例
 *
 * 本页面演示 ISR 模式下的列表页面：
 * - revalidate: 30 — 每 30 秒重验证一次（商品数据更新较频繁）
 * - 页面展示构建时间，便于观察 ISR 重验证行为
 * - 每次重验证时从数据源获取最新商品列表
 *
 * 与纯 SSG 的区别：
 * - SSG 的列表在构建后就固定了，新增商品需要重新构建
 * - ISR 的列表每 30 秒自动更新，新增商品会在下次重验证时出现
 */
import React from 'react';
import type { GetStaticPropsContext, GetStaticPropsResult } from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  category: string;
  inStock: boolean;
  imageUrl: string;
}

interface ProductsPageProps {
  /** 商品列表 */
  products: Product[];
  /** 商品总数 */
  total: number;
  /** 页面生成时间 */
  generatedAt: string;
  /** 重验证间隔 */
  revalidateInterval: number;
}

/* ==================== 页面组件 ==================== */

export default function ProductsPage({
  products,
  total,
  generatedAt,
  revalidateInterval,
}: ProductsPageProps) {
  return (
    <div className="page-products">
      <header className="page-header">
        <h1>商品列表</h1>
        <div className="page-meta">
          <span>共 {total} 件商品</span>
          <span className="isr-badge">
            ISR 重验证间隔：{revalidateInterval}s
          </span>
        </div>
        <p className="build-time">
          页面生成于：{generatedAt}
        </p>
      </header>

      <div className="product-grid">
        {products.map((product) => (
          <div key={product.id} className="product-card">
            <div className="product-image" style={{ backgroundImage: `url(${product.imageUrl})` }}>
              {!product.inStock && <span className="out-of-stock">暂时缺货</span>}
            </div>
            <div className="product-info">
              <span className="product-category">{product.category}</span>
              <h3>
                <a href={`/products/${product.id}`}>{product.name}</a>
              </h3>
              <p className="product-desc">{product.description}</p>
              <div className="product-pricing">
                <span className="product-price">&yen;{product.price.toFixed(2)}</span>
                {product.originalPrice && (
                  <span className="product-original-price">
                    &yen;{product.originalPrice.toFixed(2)}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ==================== 构建时 / 重验证时数据获取 ==================== */

/**
 * 获取商品列表数据
 *
 * revalidate: 30 表示商品列表每 30 秒更新一次。
 * 适合商品频繁上下架、价格频繁变动的电商场景。
 */
export async function getStaticProps(
  _context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<ProductsPageProps>> {
  /** 模拟 API 请求 */
  await new Promise((resolve) => setTimeout(resolve, 150));

  /** 模拟商品数据（实际项目中从数据库或商品中心获取） */
  const products: Product[] = [
    {
      id: 1001,
      name: 'TypeScript 实战进阶',
      description: '从类型体操到架构设计，深入掌握 TypeScript 在大型项目中的应用技巧。',
      price: 79.00,
      originalPrice: 99.00,
      category: '技术书籍',
      inStock: true,
      imageUrl: '/images/book-ts.png',
    },
    {
      id: 1002,
      name: 'React 性能优化权威指南',
      description: '全面覆盖 React 应用的性能优化策略，包括渲染优化、状态管理、代码分割等。',
      price: 89.00,
      category: '技术书籍',
      inStock: true,
      imageUrl: '/images/book-react.png',
    },
    {
      id: 1003,
      name: '机械键盘 — 银轴版',
      description: '87 键紧凑布局，Cherry MX 银轴，RGB 背光，适合高频代码输入。',
      price: 599.00,
      originalPrice: 699.00,
      category: '外设装备',
      inStock: true,
      imageUrl: '/images/keyboard.png',
    },
    {
      id: 1004,
      name: '4K 超清显示器 27 寸',
      description: 'IPS 面板，Type-C 一线连接，旋转升降支架，护眼低蓝光。',
      price: 2499.00,
      originalPrice: 2999.00,
      category: '外设装备',
      inStock: false,
      imageUrl: '/images/monitor.png',
    },
    {
      id: 1005,
      name: '降噪耳机 Pro',
      description: '主动降噪，40 小时续航，多设备无缝切换，适合办公和通勤。',
      price: 1299.00,
      category: '外设装备',
      inStock: true,
      imageUrl: '/images/headphone.png',
    },
    {
      id: 1006,
      name: 'Node.js 微服务架构',
      description: '从单体到微服务，系统讲解 Node.js 在微服务架构中的设计模式和最佳实践。',
      price: 69.00,
      category: '技术书籍',
      inStock: true,
      imageUrl: '/images/book-node.png',
    },
  ];

  return {
    props: {
      products,
      total: products.length,
      generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      revalidateInterval: 30,
    },
    /** 30 秒后重验证 */
    revalidate: 30,
  };
}
