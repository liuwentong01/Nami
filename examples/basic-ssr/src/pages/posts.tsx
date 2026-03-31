/**
 * 文章列表页 — SSR 服务端渲染示例
 *
 * 本页面演示 SSR 模式下的数据列表渲染：
 * - getServerSideProps 在服务端获取文章列表数据
 * - 列表在服务端渲染为完整 HTML，利于 SEO
 * - 每个文章链接指向动态路由 /posts/:id
 *
 * 适用场景：内容频繁更新的文章、新闻、商品列表等。
 */
import React from 'react';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface Post {
  id: number;
  title: string;
  summary: string;
  author: string;
  publishedAt: string;
  tags: string[];
}

interface PostsPageProps {
  /** 文章列表 */
  posts: Post[];
  /** 文章总数 */
  total: number;
  /** 数据获取时间 */
  fetchedAt: string;
}

/* ==================== 页面组件 ==================== */

export default function PostsPage({ posts, total, fetchedAt }: PostsPageProps) {
  return (
    <div className="page-posts">
      <h1>文章列表</h1>
      <p className="page-meta">
        共 {total} 篇文章 &middot; 数据获取时间：{fetchedAt}
      </p>

      <div className="post-list">
        {posts.map((post) => (
          <article key={post.id} className="post-card">
            <h2 className="post-title">
              <a href={`/posts/${post.id}`}>{post.title}</a>
            </h2>
            <p className="post-summary">{post.summary}</p>
            <div className="post-meta">
              <span className="post-author">{post.author}</span>
              <span className="post-date">{post.publishedAt}</span>
              <div className="post-tags">
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

/* ==================== 服务端数据预取 ==================== */

/**
 * 获取文章列表数据
 *
 * 每次请求时在服务端执行，可从数据库或外部 API 获取最新数据。
 * 此处使用模拟数据演示，实际项目中应替换为真实数据源。
 */
export async function getServerSideProps(
  _context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<PostsPageProps>> {
  /** 模拟 API 请求延迟 */
  await new Promise((resolve) => setTimeout(resolve, 100));

  /** 模拟文章数据 */
  const posts: Post[] = [
    {
      id: 1,
      title: '深入理解 React 18 并发特性',
      summary: '详解 React 18 中 Concurrent Mode、Suspense、startTransition 等新特性的原理与实践。',
      author: '张三',
      publishedAt: '2024-03-15',
      tags: ['React', '前端'],
    },
    {
      id: 2,
      title: 'SSR 与 SSG 的选择之道',
      summary: '从性能、SEO、开发体验等维度全面对比服务端渲染和静态站点生成的适用场景。',
      author: '李四',
      publishedAt: '2024-03-10',
      tags: ['SSR', 'SSG', '架构'],
    },
    {
      id: 3,
      title: 'TypeScript 5.x 新特性速览',
      summary: '总结 TypeScript 5.x 版本中 Decorators、const 类型参数等重要新特性。',
      author: '王五',
      publishedAt: '2024-03-05',
      tags: ['TypeScript'],
    },
    {
      id: 4,
      title: 'Webpack 5 性能优化实战',
      summary: '分享 Webpack 5 在大型项目中的构建性能优化经验，包括持久化缓存、模块联邦等。',
      author: '赵六',
      publishedAt: '2024-02-28',
      tags: ['Webpack', '性能优化'],
    },
    {
      id: 5,
      title: '微前端架构在集团的落地实践',
      summary: '介绍微前端架构在多团队协作场景下的技术选型、落地方案及踩坑记录。',
      author: '孙七',
      publishedAt: '2024-02-20',
      tags: ['微前端', '架构'],
    },
  ];

  return {
    props: {
      posts,
      total: posts.length,
      fetchedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
  };
}
