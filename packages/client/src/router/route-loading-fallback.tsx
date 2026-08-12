/**
 * @nami/client - 默认路由加载骨架
 *
 * 不依赖骨架屏插件或业务样式，确保路由 chunk 加载期间不会出现空白页。
 */

import React from 'react';

/** 默认路由加载骨架的 Props。 */
export interface RouteLoadingFallbackProps {
  /** 提供给辅助技术的加载提示。 */
  label?: string;

  /** 自定义根元素类名。 */
  className?: string;

  /** 在框架默认样式之上追加的内联样式。 */
  style?: React.CSSProperties;
}

const containerStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: '1200px',
  minHeight: '240px',
  margin: '0 auto',
  padding: '24px',
};

const contentStyle: React.CSSProperties = {
  display: 'grid',
  gap: '16px',
};

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: '16px',
};

const blockBaseStyle: React.CSSProperties = {
  backgroundColor: '#e5e7eb',
  borderRadius: '8px',
};

const visuallyHiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/**
 * 框架内置的路由加载骨架。
 *
 * 组件只使用 React 与内联样式，可以在没有安装任何 UI/骨架插件时工作。
 * 装饰块对辅助技术隐藏，加载状态则通过 `role="status"` 对外表达。
 */
export const RouteLoadingFallback: React.FC<RouteLoadingFallbackProps> = ({
  label = '页面加载中',
  className,
  style,
}) => {
  return (
    <div
      className={className}
      style={{ ...containerStyle, ...style }}
      data-nami-route-loading="true"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <span style={visuallyHiddenStyle}>{label}</span>
      <div style={contentStyle} aria-hidden="true">
        <div style={{ ...blockBaseStyle, width: '42%', height: '28px' }} />
        <div style={{ ...blockBaseStyle, width: '68%', height: '16px' }} />
        <div style={{ ...blockBaseStyle, width: '54%', height: '16px' }} />
        <div style={rowStyle}>
          <div style={{ ...blockBaseStyle, minHeight: '120px' }} />
          <div style={{ ...blockBaseStyle, minHeight: '120px' }} />
          <div style={{ ...blockBaseStyle, minHeight: '120px' }} />
        </div>
      </div>
    </div>
  );
};

RouteLoadingFallback.displayName = 'RouteLoadingFallback';
