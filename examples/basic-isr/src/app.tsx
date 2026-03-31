/**
 * 应用根组件
 *
 * ISR 模式下，此组件的渲染时机：
 * 1. 首次构建：在 Node.js 中执行 renderToString，生成初始静态 HTML
 * 2. 重验证时：缓存过期后，后台重新执行 renderToString 更新缓存
 * 3. 客户端：JS 加载后执行 Hydration，附加事件监听器
 *
 * 与 SSR 不同，ISR 的服务端渲染不是每次请求都执行，
 * 而是仅在缓存过期后的首个请求触发后台异步渲染。
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
        <h2 className="app-logo">Nami Store</h2>
        <nav className="app-nav">
          <a href="/">首页</a>
          <a href="/products">商品列表</a>
        </nav>
      </header>
      <main className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <p>Nami Framework — ISR 增量静态再生示例</p>
      </footer>
    </div>
  );
}
