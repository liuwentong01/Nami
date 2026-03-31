/**
 * 应用根组件
 *
 * CSR 模式下，整个组件树完全在浏览器端渲染。
 * 根组件负责提供全局布局（导航栏、页脚等），
 * 子页面通过 children 插入到 main 区域。
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
        <h2 className="app-logo">Nami CSR</h2>
        <nav className="app-nav">
          <a href="/">首页</a>
          <a href="/about">关于</a>
        </nav>
      </header>
      <main className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <p>Nami Framework — CSR 客户端渲染示例</p>
      </footer>
    </div>
  );
}
