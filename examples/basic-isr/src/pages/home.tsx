/**
 * 首页 — ISR 增量静态再生示例
 *
 * 本页面演示 ISR 模式的基本用法：
 * - getStaticProps 返回 revalidate: 60，表示页面每 60 秒重验证一次
 * - 60 秒内的请求直接返回缓存的静态 HTML（极速响应）
 * - 60 秒后的首个请求仍返回旧缓存，但触发后台异步重新生成
 * - 重新生成完成后，后续请求获取新版本
 *
 * 通过观察"页面生成时间"可以验证 ISR 的行为：
 * - 连续刷新时，时间不变（命中缓存）
 * - 超过 60 秒后刷新，时间仍不变（返回旧缓存）
 * - 再次刷新，时间更新（获取到重新生成的版本）
 */
import React from 'react';
import type { GetStaticPropsContext, GetStaticPropsResult } from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface HomePageProps {
  /** 网站标题 */
  siteTitle: string;
  /** 站点统计数据 */
  stats: {
    totalProducts: number;
    totalCategories: number;
    todayOrders: number;
  };
  /** 页面生成时间（用于验证 ISR 行为） */
  generatedAt: string;
  /** 下次重验证时间（仅用于演示） */
  nextRevalidateAt: string;
}

/* ==================== 页面组件 ==================== */

export default function HomePage({
  siteTitle,
  stats,
  generatedAt,
  nextRevalidateAt,
}: HomePageProps) {
  return (
    <div className="page-home">
      <section className="hero">
        <h1>{siteTitle}</h1>
        <p className="hero-desc">
          这是一个使用 Nami 框架 ISR 模式构建的电商示例。
          页面在构建时预渲染，过期后自动在后台重新生成。
        </p>
      </section>

      <section className="isr-info">
        <h2>ISR 状态</h2>
        <div className="info-card">
          <div className="info-item">
            <span className="info-label">页面生成时间</span>
            <span className="info-value highlight">{generatedAt}</span>
          </div>
          <div className="info-item">
            <span className="info-label">重验证间隔</span>
            <span className="info-value">60 秒</span>
          </div>
          <div className="info-item">
            <span className="info-label">预计下次更新</span>
            <span className="info-value">{nextRevalidateAt}</span>
          </div>
          <p className="info-tip">
            提示：连续刷新页面，观察"页面生成时间"的变化，即可验证 ISR 的 stale-while-revalidate 行为。
          </p>
        </div>
      </section>

      <section className="stats-section">
        <h2>站点概览</h2>
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-number">{stats.totalProducts}</span>
            <span className="stat-label">商品总数</span>
          </div>
          <div className="stat-card">
            <span className="stat-number">{stats.totalCategories}</span>
            <span className="stat-label">商品分类</span>
          </div>
          <div className="stat-card">
            <span className="stat-number">{stats.todayOrders}</span>
            <span className="stat-label">今日订单</span>
          </div>
        </div>
      </section>

      <section className="features">
        <h2>ISR 模式特点</h2>
        <ul>
          <li>构建时预渲染页面（同 SSG），响应速度极快</li>
          <li>通过 revalidate 配置自动在后台更新过期页面</li>
          <li>采用 stale-while-revalidate 策略，用户始终不等待</li>
          <li>无需全量重建即可更新单个页面内容</li>
          <li>支持 fallback: 'blocking' 处理新增的动态路由页面</li>
          <li>需要 Node.js 服务端支持重验证逻辑</li>
        </ul>
      </section>
    </div>
  );
}

/* ==================== 构建时 / 重验证时数据获取 ==================== */

/**
 * ISR 数据获取函数
 *
 * 执行时机：
 * 1. 首次构建时（nami build）
 * 2. 缓存过期后的重验证时（后台异步执行）
 *
 * 返回的 revalidate: 60 告诉框架：
 * "这个页面的缓存在 60 秒后过期，届时需要重新生成"
 */
export async function getStaticProps(
  _context: GetStaticPropsContext,
): Promise<GetStaticPropsResult<HomePageProps>> {
  /** 模拟从数据库或 API 获取统计数据 */
  await new Promise((resolve) => setTimeout(resolve, 100));

  const now = new Date();
  const revalidateSeconds = 60;
  const nextRevalidate = new Date(now.getTime() + revalidateSeconds * 1000);

  return {
    props: {
      siteTitle: 'Nami ISR 电商示例',
      stats: {
        totalProducts: 256,
        totalCategories: 12,
        /** 模拟每次重验证时获取最新订单数 */
        todayOrders: Math.floor(Math.random() * 100) + 50,
      },
      generatedAt: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      nextRevalidateAt: nextRevalidate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
    /** 60 秒后重验证 */
    revalidate: 60,
  };
}
