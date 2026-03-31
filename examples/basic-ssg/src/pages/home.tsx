/**
 * 首页 — SSG 静态站点生成示例
 *
 * 本页面演示 SSG 模式的基本用法：
 * - getStaticProps 在构建时执行（非请求时）
 * - 返回的数据被嵌入到生成的静态 HTML 中
 * - 数据在构建后不会自动更新，需重新构建才能刷新
 *
 * 适合内容不频繁变动的页面，如站点首页、关于页等。
 */
import React from 'react';
import type { GetStaticPropsContext, GetStaticPropsResult } from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface HomePageProps {
  /** 站点标题 */
  siteTitle: string;
  /** 站点描述 */
  siteDescription: string;
  /** 构建时间 */
  buildTime: string;
  /** 精选文章 */
  featuredPosts: Array<{
    slug: string;
    title: string;
    excerpt: string;
  }>;
}

/* ==================== 页面组件 ==================== */

export default function HomePage({
  siteTitle,
  siteDescription,
  buildTime,
  featuredPosts,
}: HomePageProps) {
  return (
    <div className="page-home">
      <section className="hero">
        <h1>{siteTitle}</h1>
        <p className="hero-desc">{siteDescription}</p>
        <p className="build-time">
          页面生成时间：{buildTime}（构建时确定，不会随请求变化）
        </p>
      </section>

      <section className="featured">
        <h2>精选文章</h2>
        <p className="section-desc">以下内容在构建时从数据源获取并渲染为静态 HTML。</p>
        <div className="featured-list">
          {featuredPosts.map((post) => (
            <div key={post.slug} className="featured-card">
              <h3>
                <a href={`/blog/${post.slug}`}>{post.title}</a>
              </h3>
              <p>{post.excerpt}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="features">
        <h2>SSG 模式特点</h2>
        <ul>
          <li>构建时预渲染所有页面为静态 HTML 文件</li>
          <li>部署后无需 Node.js 服务端，可使用任意静态托管服务</li>
          <li>响应速度极快，首字节时间（TTFB）接近 0</li>
          <li>天然支持 CDN 缓存和边缘分发</li>
          <li>对 SEO 友好，搜索引擎可直接抓取完整 HTML</li>
          <li>内容更新需要重新构建和部署</li>
        </ul>
      </section>
    </div>
  );
}

/* ==================== 构建时数据获取 ==================== */

/**
 * SSG 数据获取函数
 *
 * 该函数仅在构建时执行（nami build / nami generate），
 * 不会在每次用户请求时执行。返回的数据会被序列化后嵌入静态 HTML。
 *
 * 常见数据源：
 * - 本地 Markdown 文件
 * - CMS API（如 Strapi、Contentful）
 * - 数据库查询
 *
 * @param _context - 静态生成上下文
 * @returns 包含 props 的预取结果
 */
export async function getStaticProps(
  _context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<HomePageProps>> {
  /** 模拟从 CMS 或文件系统获取数据 */
  const featuredPosts = [
    {
      slug: 'getting-started-with-nami',
      title: 'Nami 框架快速上手指南',
      excerpt: '从零开始搭建你的第一个 Nami 项目，了解框架的核心概念和开发流程。',
    },
    {
      slug: 'understanding-render-modes',
      title: '理解四种渲染模式的差异',
      excerpt: '深入对比 CSR、SSR、SSG、ISR 四种渲染策略的原理、优劣和适用场景。',
    },
    {
      slug: 'ssg-best-practices',
      title: 'SSG 静态站点生成最佳实践',
      excerpt: '分享使用 SSG 构建内容站点的经验技巧，包括数据源管理、增量构建、部署优化等。',
    },
  ];

  return {
    props: {
      siteTitle: 'Nami SSG 静态博客',
      siteDescription: '这是一个使用 Nami 框架 SSG 模式构建的静态博客示例，所有页面在构建时预渲染。',
      buildTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      featuredPosts,
    },
  };
}
