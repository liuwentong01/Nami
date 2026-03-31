/**
 * 文章详情页 — SSR 动态路由示例
 *
 * 本页面演示 SSR 模式下的动态路由（/posts/:id）：
 * - 路由参数 id 通过 context.params 在服务端获取
 * - getServerSideProps 根据 id 查询对应文章数据
 * - 支持 404 处理（文章不存在时返回 notFound）
 * - 支持自定义响应头和缓存策略
 */
import React from 'react';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface PostDetail {
  id: number;
  title: string;
  content: string;
  author: string;
  publishedAt: string;
  updatedAt: string;
  tags: string[];
  readingTime: number;
}

interface PostDetailPageProps {
  post: PostDetail;
  /** 服务端渲染时间 */
  renderedAt: string;
}

/* ==================== 页面组件 ==================== */

export default function PostDetailPage({ post, renderedAt }: PostDetailPageProps) {
  return (
    <div className="page-post-detail">
      <article className="article">
        <header className="article-header">
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
          {/* 实际项目中此处应渲染 Markdown / 富文本内容 */}
          <p>{post.content}</p>
        </div>

        <footer className="article-footer">
          <p className="render-info">
            此页面由服务端在 {renderedAt} 渲染生成
          </p>
          <a href="/posts" className="back-link">
            &larr; 返回文章列表
          </a>
        </footer>
      </article>
    </div>
  );
}

/* ==================== 服务端数据预取 ==================== */

/** 模拟文章数据库 */
const MOCK_POSTS: Record<string, PostDetail> = {
  '1': {
    id: 1,
    title: '深入理解 React 18 并发特性',
    content: 'React 18 引入了并发渲染的概念，使得 React 可以同时准备多个版本的 UI。并发特性不是一个具体的功能，而是一种底层机制，让 React 能够根据优先级暂停和恢复渲染任务。Suspense、startTransition、useDeferredValue 等 API 都建立在这一机制之上。在实际应用中，并发特性可以帮助我们处理大量数据渲染、频繁交互等场景，让用户界面保持流畅响应。',
    author: '张三',
    publishedAt: '2024-03-15',
    updatedAt: '2024-03-16',
    tags: ['React', '前端'],
    readingTime: 12,
  },
  '2': {
    id: 2,
    title: 'SSR 与 SSG 的选择之道',
    content: '在现代前端架构中，SSR 和 SSG 是两种主流的页面渲染策略。SSR 每次请求都由服务端生成 HTML，适合内容频繁变动的场景，如新闻网站、电商商品页；SSG 则在构建时预生成静态 HTML，适合内容相对稳定的场景，如博客、文档站。两者并非互斥，ISR（增量静态再生）就是二者的折中方案。选择合适的渲染策略需要综合考虑内容更新频率、SEO 需求、服务端成本等因素。',
    author: '李四',
    publishedAt: '2024-03-10',
    updatedAt: '2024-03-12',
    tags: ['SSR', 'SSG', '架构'],
    readingTime: 8,
  },
  '3': {
    id: 3,
    title: 'TypeScript 5.x 新特性速览',
    content: 'TypeScript 5.x 带来了多项实用的新特性。装饰器（Decorators）终于进入了 Stage 3 并获得 TypeScript 原生支持。const 类型参数允许推断更精确的字面量类型。模块解析策略新增了 bundler 模式，更好地适配现代打包工具。此外，性能方面也有显著提升，编译速度和内存占用都有改善。',
    author: '王五',
    publishedAt: '2024-03-05',
    updatedAt: '2024-03-05',
    tags: ['TypeScript'],
    readingTime: 6,
  },
};

/**
 * 根据文章 ID 获取详情数据
 *
 * 动态路由参数通过 context.params 获取，如 /posts/1 中 params.id = '1'。
 * 当文章不存在时返回 notFound: true，框架会自动渲染 404 页面。
 */
export async function getServerSideProps(
  context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<PostDetailPageProps>> {
  const { id } = context.params;

  /** 模拟数据库查询延迟 */
  await new Promise((resolve) => setTimeout(resolve, 80));

  const post = MOCK_POSTS[id];

  /** 文章不存在时返回 404 */
  if (!post) {
    return { notFound: true };
  }

  return {
    props: {
      post,
      renderedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
    /** 设置缓存策略：5 秒内缓存有效，过期后 60 秒内可使用旧缓存 */
    cache: {
      maxAge: 5,
      staleWhileRevalidate: 60,
    },
  };
}
