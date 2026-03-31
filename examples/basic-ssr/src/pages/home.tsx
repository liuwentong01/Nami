/**
 * 首页 — SSR 服务端渲染示例
 *
 * 本页面演示 SSR 模式的核心特性：
 * - getServerSideProps 在每次请求时由服务端调用
 * - 返回的数据通过 props 注入到页面组件
 * - 页面在服务端渲染为完整 HTML，客户端直接展示
 *
 * 查看页面源代码可以看到 HTML 中已包含完整的页面内容，
 * 这与 CSR 模式返回的空壳 HTML 形成鲜明对比。
 */
import React from 'react';
import type { GetServerSidePropsContext, GetServerSidePropsResult } from '@nami/shared';

/* ==================== 类型定义 ==================== */

interface HomePageProps {
  /** 欢迎消息 — 来自服务端 */
  welcomeMessage: string;
  /** 服务端渲染的时间戳 */
  serverTimestamp: string;
  /** 服务端环境信息 */
  serverInfo: {
    nodeVersion: string;
    platform: string;
  };
}

/* ==================== 页面组件 ==================== */

export default function HomePage({ welcomeMessage, serverTimestamp, serverInfo }: HomePageProps) {
  return (
    <div className="page-home">
      <section className="hero">
        <h1>Nami SSR 服务端渲染示例</h1>
        <p className="hero-desc">
          本页面由服务端渲染生成，HTML 中已包含完整的页面内容。
          每次刷新页面都会触发服务端重新渲染，时间戳会更新。
        </p>
      </section>

      <section className="server-data">
        <h2>服务端数据</h2>
        <p>以下数据由 getServerSideProps 在服务端获取并注入：</p>
        <div className="data-card">
          <div className="data-item">
            <span className="data-label">欢迎消息</span>
            <span className="data-value">{welcomeMessage}</span>
          </div>
          <div className="data-item">
            <span className="data-label">渲染时间</span>
            <span className="data-value">{serverTimestamp}</span>
          </div>
          <div className="data-item">
            <span className="data-label">Node.js 版本</span>
            <span className="data-value">{serverInfo.nodeVersion}</span>
          </div>
          <div className="data-item">
            <span className="data-label">服务端平台</span>
            <span className="data-value">{serverInfo.platform}</span>
          </div>
        </div>
      </section>

      <section className="features">
        <h2>SSR 模式特点</h2>
        <ul>
          <li>每次请求由服务端执行 React renderToString 生成 HTML</li>
          <li>首屏内容在 HTML 中就已存在，加载速度快</li>
          <li>对搜索引擎友好，爬虫可直接读取页面内容</li>
          <li>支持 getServerSideProps 在服务端预取数据</li>
          <li>客户端 Hydration 后恢复交互能力</li>
          <li>服务端需要 Node.js 运行时，部署成本高于纯静态方案</li>
        </ul>
      </section>
    </div>
  );
}

/* ==================== 服务端数据预取 ==================== */

/**
 * SSR 数据预取函数
 *
 * 该函数在每次 HTTP 请求到达时，由 Nami 框架在服务端调用。
 * 返回的 props 会被序列化后注入到 HTML 的 __NAMI_DATA__ 变量中，
 * 同时作为 React 组件的 props 传入。
 *
 * @param context - 请求上下文，包含路由参数、查询参数、请求头等
 * @returns 包含 props 的预取结果
 */
export async function getServerSideProps(
  context: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<HomePageProps>> {
  /** 模拟从 API 或数据库获取数据的延迟 */
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    props: {
      welcomeMessage: '欢迎使用 Nami 框架！这条消息来自服务端。',
      serverTimestamp: new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      }),
      serverInfo: {
        nodeVersion: process.version,
        platform: process.platform,
      },
    },
  };
}
