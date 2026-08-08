import React, { type ReactNode } from 'react';

const primaryNavigation = [
  { href: '/', label: '总览' },
  { href: '/rendering/csr', label: 'CSR' },
  { href: '/rendering/ssr/riven?source=nav', label: 'SSR' },
  { href: '/rendering/streaming', label: 'Streaming' },
  { href: '/content', label: 'SSG' },
  { href: '/products', label: 'ISR' },
  { href: '/client/runtime', label: '客户端' },
  { href: '/plugins', label: '插件' },
  { href: '/stability', label: '稳定性' },
] as const;

export interface AppProps {
  children: ReactNode;
}

/**
 * 服务端入口与客户端 wrapApp 插件共用的页面外壳。
 *
 * 顶部导航刻意使用普通 `<a>`：切换 SSR / SSG / ISR 页面时浏览器会重新
 * 请求服务端，因此可以在 DevTools 中直接观察 HTML、响应头和缓存状态。
 * SPA 路由切换单独放在 `/client/runtime` 用 NamiLink 演示。
 */
export function App({ children }: AppProps): React.ReactElement {
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="返回 Nami Showcase 首页">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>Nami</strong>
            <small>Feature Showcase</small>
          </span>
        </a>

        <nav className="site-nav" aria-label="主要功能导航">
          {primaryNavigation.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <a className="header-badge" href="/routing/new" title="验证静态路由优先级">
          mixed rendering
        </a>
      </header>

      <div id="main-content" className="site-main" role="main">
        {children}
      </div>

      <footer className="site-footer">
        <p>Nami Feature Showcase · 一套路由表贯穿构建、服务端运行时与浏览器。</p>
        <p>建议同时打开 Network、Console 与 View Source，按页面提示验证能力。</p>
      </footer>
    </div>
  );
}

export default App;
