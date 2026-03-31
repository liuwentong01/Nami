/**
 * 应用根组件
 *
 * SSR 模式下，此组件会分别在服务端和客户端各执行一次：
 * 1. 服务端：renderToString 将组件树渲染为 HTML 字符串
 * 2. 客户端：hydrateRoot 将事件监听器附加到已有 DOM 上
 *
 * 注意：根组件中不应使用仅客户端可用的 API（如 window、document），
 * 否则会导致 Hydration 不匹配。
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
        <h2 className="app-logo">Nami SSR</h2>
        <nav className="app-nav">
          <a href="/">首页</a>
          <a href="/posts">文章列表</a>
        </nav>
      </header>
      <main className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <p>Nami Framework — SSR 服务端渲染示例</p>
      </footer>
    </div>
  );
}
