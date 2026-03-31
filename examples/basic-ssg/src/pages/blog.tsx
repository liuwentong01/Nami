/**
 * 博客列表页 — SSG 静态站点生成示例
 *
 * 本页面演示 SSG 模式下的列表页面：
 * - getStaticProps 在构建时获取所有文章列表
 * - 整个列表页面被渲染为一个静态 HTML 文件
 * - 新增文章后需要重新构建才能在列表中展示
 *
 * 如果文章更新频率较高，建议使用 ISR 模式替代。
 */
import React from 'react';
import type { GetStaticPropsContext, GetStaticPropsResult } from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  category: string;
  tags: string[];
}

interface BlogPageProps {
  /** 文章列表 */
  posts: BlogPost[];
  /** 分类列表 */
  categories: string[];
  /** 构建时间 */
  buildTime: string;
}

/* ==================== 页面组件 ==================== */

export default function BlogPage({ posts, categories, buildTime }: BlogPageProps) {
  return (
    <div className="page-blog">
      <header className="blog-header">
        <h1>博客文章</h1>
        <p className="build-info">
          共 {posts.length} 篇文章 &middot; 页面生成于 {buildTime}
        </p>
      </header>

      <div className="blog-categories">
        <h3>文章分类</h3>
        <div className="category-list">
          {categories.map((cat) => (
            <span key={cat} className="category-tag">{cat}</span>
          ))}
        </div>
      </div>

      <div className="blog-list">
        {posts.map((post) => (
          <article key={post.slug} className="blog-card">
            <div className="blog-card-header">
              <span className="blog-category">{post.category}</span>
              <span className="blog-date">{post.publishedAt}</span>
            </div>
            <h2>
              <a href={`/blog/${post.slug}`}>{post.title}</a>
            </h2>
            <p className="blog-excerpt">{post.excerpt}</p>
            <div className="blog-footer">
              <span className="blog-author">作者：{post.author}</span>
              <div className="blog-tags">
                {post.tags.map((tag) => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/* ==================== 构建时数据获取 ==================== */

/**
 * 获取博客文章列表
 *
 * 构建时执行，可以从文件系统读取 Markdown 文件，
 * 或从 Headless CMS API 获取文章数据。
 * 此处使用模拟数据演示。
 */
export async function getStaticProps(
  _context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<BlogPageProps>> {
  /** 模拟文章数据（实际项目中应从数据源获取） */
  const posts: BlogPost[] = [
    {
      slug: 'getting-started-with-nami',
      title: 'Nami 框架快速上手指南',
      excerpt: '从零开始搭建你的第一个 Nami 项目，了解框架的核心概念和开发流程。涵盖项目初始化、目录结构、路由配置、页面开发等基础内容。',
      author: '张三',
      publishedAt: '2024-03-20',
      category: '教程',
      tags: ['Nami', '入门'],
    },
    {
      slug: 'understanding-render-modes',
      title: '理解四种渲染模式的差异',
      excerpt: '深入对比 CSR、SSR、SSG、ISR 四种渲染策略的原理、优劣和适用场景。帮助你根据业务需求选择最合适的渲染方案。',
      author: '李四',
      publishedAt: '2024-03-15',
      category: '深度',
      tags: ['渲染模式', '架构'],
    },
    {
      slug: 'ssg-best-practices',
      title: 'SSG 静态站点生成最佳实践',
      excerpt: '分享使用 SSG 构建内容站点的经验技巧，包括数据源管理、增量构建、部署优化、CDN 配置等实用内容。',
      author: '王五',
      publishedAt: '2024-03-10',
      category: '实践',
      tags: ['SSG', '最佳实践'],
    },
    {
      slug: 'react-18-concurrent-features',
      title: 'React 18 并发特性在 Nami 中的应用',
      excerpt: '探索 React 18 并发特性如何与 Nami 框架的渲染策略结合，提升用户体验和性能表现。',
      author: '赵六',
      publishedAt: '2024-03-05',
      category: '深度',
      tags: ['React', '并发'],
    },
    {
      slug: 'deploy-ssg-to-cdn',
      title: '将 SSG 站点部署到 CDN 的完整指南',
      excerpt: '从构建产物到 CDN 配置，手把手教你将静态站点部署到阿里云 OSS、腾讯云 COS 或 AWS S3。',
      author: '孙七',
      publishedAt: '2024-02-28',
      category: '教程',
      tags: ['部署', 'CDN'],
    },
  ];

  /** 提取不重复的分类列表 */
  const categories = [...new Set(posts.map((p) => p.category))];

  return {
    props: {
      posts,
      categories,
      buildTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
  };
}
