/**
 * 应用根组件
 *
 * SSG 模式下，此组件在构建时被 renderToString 渲染为 HTML。
 * 构建产物是纯静态文件，部署后无需 Node.js 运行时。
 *
 * 与 SSR 不同，SSG 的渲染只发生在构建阶段，而非每次请求。
 * 客户端加载 JS 后通过 Hydration 恢复交互能力。
 */
import React from 'react';
import './global.css';

interface AppProps {
  children: React.ReactNode;
}

export default function App({ children }: AppProps) {
  return (
    <div className="nami-app">
      <header className="app-header">
        <h2 className="app-logo">Nami Blog</h2>
        <nav className="app-nav">
          <a href="/">首页</a>
          <a href="/blog">博客</a>
        </nav>
      </header>
      <main className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <p>Nami Framework — SSG 静态站点生成示例</p>
      </footer>
    </div>
  );
}
