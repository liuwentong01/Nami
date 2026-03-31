/**
 * 博客文章详情页 — SSG 动态路由示例
 *
 * 本页面演示 SSG 模式下的动态路由处理：
 *
 * 1. getStaticPaths — 构建时确定需要预渲染的路径列表
 *    框架会遍历返回的 paths 数组，为每个路径生成一个静态 HTML 文件。
 *    例如返回 [{ params: { slug: 'post-1' } }]，则生成 /blog/post-1.html
 *
 * 2. getStaticProps — 构建时为每个路径获取对应数据
 *    对 getStaticPaths 返回的每个路径，框架会调用 getStaticProps 获取数据。
 *
 * 3. fallback 策略控制未预渲染路径的行为：
 *    - false: 返回 404
 *    - true: 先返回加载页面，后台生成后客户端更新
 *    - 'blocking': 等待服务端渲染完成后返回
 */
import React from 'react';
import type {
  GetStaticPropsContext,
  GetStaticPropsResult,
  GetStaticPathsResult,
} from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface BlogPostDetail {
  slug: string;
  title: string;
  content: string;
  author: string;
  publishedAt: string;
  updatedAt: string;
  category: string;
  tags: string[];
  readingTime: number;
}

interface BlogPostPageProps {
  post: BlogPostDetail;
  /** 页面构建时间 */
  generatedAt: string;
}

/* ==================== 页面组件 ==================== */

export default function BlogPostPage({ post, generatedAt }: BlogPostPageProps) {
  return (
    <div className="page-blog-post">
      <article className="article">
        <header className="article-header">
          <div className="article-breadcrumb">
            <a href="/blog">博客</a>
            <span className="separator">/</span>
            <span>{post.category}</span>
          </div>
          <h1>{post.title}</h1>
          <div className="article-meta">
            <span>作者：{post.author}</span>
            <span>发布于：{post.publishedAt}</span>
            <span>更新于：{post.updatedAt}</span>
            <span>阅读时间：约 {post.readingTime} 分钟</span>
          </div>
          <div className="article-tags">
            {post.tags.map((tag) => (
              <span key={tag} className="tag">{tag}</span>
            ))}
          </div>
        </header>

        <div className="article-content">
          {/* 实际项目中此处应渲染解析后的 Markdown 内容 */}
          {post.content.split('\n\n').map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>

        <footer className="article-footer">
          <p className="build-info">
            此页面在构建时生成（{generatedAt}），内容更新需要重新构建。
          </p>
          <a href="/blog" className="back-link">
            &larr; 返回博客列表
          </a>
        </footer>
      </article>
    </div>
  );
}

/* ==================== 模拟数据源 ==================== */

/** 模拟博客文章数据（实际项目中应从 Markdown 文件或 CMS 读取） */
const BLOG_POSTS: Record<string, BlogPostDetail> = {
  'getting-started-with-nami': {
    slug: 'getting-started-with-nami',
    title: 'Nami 框架快速上手指南',
    content: `Nami 是一个集团级前端框架，支持 CSR、SSR、SSG、ISR 四种渲染模式。本文将带你从零开始搭建一个 Nami 项目。

首先，使用 create-nami-app 脚手架创建项目。脚手架会引导你选择渲染模式、需要的插件等配置，并自动生成项目结构。

项目创建后，你会看到 nami.config.ts 配置文件，这是整个项目的核心配置。其中 routes 数组定义了页面路由，每个路由可以独立配置渲染模式。

开发过程中使用 nami dev 启动开发服务器，支持热更新。构建时使用 nami build 生成生产产物。SSG 模式下还可以使用 nami generate 生成静态文件。`,
    author: '张三',
    publishedAt: '2024-03-20',
    updatedAt: '2024-03-22',
    category: '教程',
    tags: ['Nami', '入门'],
    readingTime: 8,
  },
  'understanding-render-modes': {
    slug: 'understanding-render-modes',
    title: '理解四种渲染模式的差异',
    content: `现代前端框架通常支持多种渲染策略，每种策略都有其适用场景。理解它们的差异对于做出正确的技术决策至关重要。

CSR（客户端渲染）是最传统的 SPA 渲染方式。服务端返回一个几乎为空的 HTML 壳，所有页面内容由浏览器端的 JavaScript 生成。优点是部署简单、交互流畅；缺点是首屏白屏时间长、SEO 不友好。

SSR（服务端渲染）每次请求都在服务端执行 React 渲染，返回完整的 HTML。首屏速度快、SEO 友好，但服务端压力较大，TTFB 受渲染耗时影响。

SSG（静态站点生成）在构建时预渲染所有页面。部署后响应极快，但内容更新需要重新构建。适合博客、文档等内容稳定的站点。

ISR（增量静态再生）结合了 SSG 和 SSR 的优点。首次构建生成静态文件，过期后在后台异步重新生成，无需完整重建。`,
    author: '李四',
    publishedAt: '2024-03-15',
    updatedAt: '2024-03-18',
    category: '深度',
    tags: ['渲染模式', '架构'],
    readingTime: 12,
  },
  'ssg-best-practices': {
    slug: 'ssg-best-practices',
    title: 'SSG 静态站点生成最佳实践',
    content: `SSG 是构建内容站点的理想选择，但要充分发挥其优势，需要注意一些最佳实践。

数据源管理是 SSG 的关键。推荐使用 Headless CMS（如 Strapi、Contentful）管理内容，通过 API 在构建时拉取数据。对于小型项目，直接使用 Markdown 文件作为数据源也是不错的选择。

增量构建可以显著缩短构建时间。当只有部分页面的数据发生变化时，只重新生成受影响的页面，而非全量重建。Nami 框架的构建系统支持基于文件 hash 的增量构建策略。

部署方面，SSG 产物是纯静态文件，建议上传到 CDN 进行边缘分发。配合适当的缓存策略，可以实现极致的访问速度。同时注意配置 HTML 文件的缓存时间不宜过长，以便内容更新后及时生效。`,
    author: '王五',
    publishedAt: '2024-03-10',
    updatedAt: '2024-03-10',
    category: '实践',
    tags: ['SSG', '最佳实践'],
    readingTime: 10,
  },
};

/* ==================== 构建时路径生成 ==================== */

/**
 * 生成需要预渲染的路径列表
 *
 * 框架在构建时调用此函数，获取所有需要生成静态 HTML 的路径。
 * 返回的每个 params 对象对应一个动态路由参数组合。
 *
 * fallback: false 表示未列出的路径直接返回 404，
 * 这是 SSG 模式下最常用的配置。
 */
export async function getStaticPaths(): Promise<GetStaticPathsResult> {
  /** 获取所有文章的 slug 列表 */
  const slugs = Object.keys(BLOG_POSTS);

  return {
    paths: slugs.map((slug) => ({
      params: { slug },
    })),
    /** 未预渲染的路径返回 404 */
    fallback: false,
  };
}

/* ==================== 构建时数据获取 ==================== */

/**
 * 获取单篇文章数据
 *
 * 对 getStaticPaths 返回的每个路径，构建时会调用此函数获取数据。
 * 路由参数通过 context.params 获取。
 */
export async function getStaticProps(
  context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<BlogPostPageProps>> {
  const { slug } = context.params;

  const post = BLOG_POSTS[slug];

  /** 文章不存在时返回 404 */
  if (!post) {
    return { notFound: true };
  }

  return {
    props: {
      post,
      generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
  };
}
