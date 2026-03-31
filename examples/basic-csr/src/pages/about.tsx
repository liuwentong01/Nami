/**
 * 关于页面 — CSR 客户端渲染
 *
 * 一个简单的静态展示页面，演示 CSR 模式下的多页面路由。
 * CSR 模式下页面切换由客户端路由处理，无需向服务端发起新请求。
 */
import React from 'react';

export default function AboutPage() {
  return (
    <div className="page-about">
      <h1>关于本项目</h1>
      <p className="about-intro">
        这是一个使用 Nami 框架搭建的 CSR（客户端渲染）示例项目，
        旨在展示纯客户端渲染模式下的项目结构和开发体验。
      </p>

      <section className="tech-stack">
        <h2>技术栈</h2>
        <ul>
          <li><strong>Nami 框架</strong> — 集团级前端框架，支持多渲染模式</li>
          <li><strong>React 18</strong> — 用户界面库，支持并发特性</li>
          <li><strong>TypeScript</strong> — 类型安全的 JavaScript 超集</li>
          <li><strong>Webpack 5</strong> — 模块打包工具</li>
        </ul>
      </section>

      <section className="render-modes">
        <h2>Nami 支持的渲染模式</h2>
        <div className="mode-list">
          <div className="mode-item mode-active">
            <h3>CSR — 客户端渲染</h3>
            <p>当前示例所使用的模式。服务端返回空壳 HTML，浏览器下载 JS 后执行渲染。</p>
          </div>
          <div className="mode-item">
            <h3>SSR — 服务端渲染</h3>
            <p>每次请求由服务端执行 React 渲染，返回完整 HTML，适合 SEO 要求高的场景。</p>
          </div>
          <div className="mode-item">
            <h3>SSG — 静态站点生成</h3>
            <p>构建时预渲染 HTML 文件，部署后直接返回静态文件，适合内容站点。</p>
          </div>
          <div className="mode-item">
            <h3>ISR — 增量静态再生</h3>
            <p>基于 SSG 增加按需重验证能力，兼顾性能与内容时效性。</p>
          </div>
        </div>
      </section>
    </div>
  );
}
