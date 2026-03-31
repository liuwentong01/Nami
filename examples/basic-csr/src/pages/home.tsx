/**
 * 首页 — CSR 客户端渲染示例
 *
 * 本页面演示 CSR 模式下的客户端交互能力：
 * - useState 管理本地状态（计数器）
 * - useEffect 执行客户端副作用（页面标题更新）
 * - 事件处理器响应用户操作
 *
 * 在 CSR 模式下，所有逻辑均在浏览器端执行，
 * 服务端不参与页面内容的渲染。
 */
import React, { useState, useEffect } from 'react';

export default function HomePage() {
  /* ==================== 状态管理 ==================== */

  /** 计数器状态 — 演示 CSR 模式下的客户端状态管理 */
  const [count, setCount] = useState(0);

  /** 主题切换状态 */
  const [isDark, setIsDark] = useState(false);

  /* ==================== 副作用 ==================== */

  /** 更新页面标题 — 仅在客户端执行 */
  useEffect(() => {
    document.title = `计数器: ${count} — Nami CSR 示例`;
  }, [count]);

  /* ==================== 事件处理 ==================== */

  const handleIncrement = () => setCount((prev) => prev + 1);
  const handleDecrement = () => setCount((prev) => prev - 1);
  const handleReset = () => setCount(0);
  const handleToggleTheme = () => setIsDark((prev) => !prev);

  /* ==================== 渲染 ==================== */

  return (
    <div className={`page-home ${isDark ? 'theme-dark' : 'theme-light'}`}>
      <section className="hero">
        <h1>Nami CSR 客户端渲染示例</h1>
        <p className="hero-desc">
          本页面完全在浏览器端渲染，所有交互逻辑由 React 在客户端执行。
          查看页面源代码可以看到初始 HTML 中不包含页面内容。
        </p>
      </section>

      <section className="counter-section">
        <h2>交互式计数器</h2>
        <p className="counter-desc">
          CSR 模式的优势在于丰富的客户端交互能力，状态变更即时反映到视图。
        </p>
        <div className="counter">
          <span className="counter-value">{count}</span>
          <div className="counter-actions">
            <button onClick={handleDecrement}>-1</button>
            <button onClick={handleReset}>重置</button>
            <button onClick={handleIncrement}>+1</button>
          </div>
        </div>
      </section>

      <section className="theme-section">
        <h2>主题切换</h2>
        <p>当前主题：{isDark ? '深色' : '浅色'}</p>
        <button onClick={handleToggleTheme}>
          切换到{isDark ? '浅色' : '深色'}主题
        </button>
      </section>

      <section className="features">
        <h2>CSR 模式特点</h2>
        <ul>
          <li>服务端返回空壳 HTML，JS 加载后在浏览器渲染</li>
          <li>支持丰富的客户端交互，状态管理更灵活</li>
          <li>首屏渲染依赖 JS 下载和执行，白屏时间较长</li>
          <li>不利于搜索引擎抓取，适合后台管理等场景</li>
          <li>部署简单，可直接使用静态文件托管服务</li>
        </ul>
      </section>
    </div>
  );
}
