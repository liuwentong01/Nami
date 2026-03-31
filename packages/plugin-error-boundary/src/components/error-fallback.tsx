/**
 * @nami/plugin-error-boundary - 默认错误回退组件
 *
 * ErrorFallback 是错误边界捕获到未处理错误时展示的默认 UI。
 *
 * 功能：
 * - 展示用户友好的错误提示信息
 * - 开发环境下显示详细的错误堆栈信息（便于调试）
 * - 提供「重试」按钮，允许用户尝试恢复
 * - 支持自定义错误页面样式和操作
 *
 * 安全考虑：
 * - 生产环境不展示错误堆栈（防止泄漏源码结构）
 * - 错误消息做了安全处理（防止 XSS）
 */

import React, { useCallback } from 'react';

/**
 * ErrorFallback 组件属性
 */
export interface ErrorFallbackProps {
  /** 错误对象 */
  error: Error;

  /**
   * 重置错误边界的函数
   * 调用后会清除错误状态，重新渲染子组件
   */
  resetError: () => void;

  /**
   * 是否显示详细错误信息（如堆栈跟踪）
   * 默认在开发环境显示，生产环境隐藏
   */
  showDetails?: boolean;

  /**
   * 自定义错误标题
   * @default '页面出现了一些问题'
   */
  title?: string;

  /**
   * 自定义错误描述
   * @default '很抱歉，页面遇到了意外错误。您可以尝试刷新页面或稍后再试。'
   */
  description?: string;

  /**
   * 重试按钮文字
   * @default '重新加载'
   */
  retryButtonText?: string;

  /**
   * 返回首页按钮文字
   * 设为 null 隐藏此按钮
   * @default '返回首页'
   */
  homeButtonText?: string | null;

  /**
   * 首页 URL
   * @default '/'
   */
  homeURL?: string;

  /**
   * 自定义 CSS 类名
   */
  className?: string;

  /**
   * 自定义内联样式
   */
  style?: React.CSSProperties;
}

/**
 * 检测当前是否为开发环境
 */
function isDevelopment(): boolean {
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== undefined) {
    return process.env.NODE_ENV !== 'production';
  }
  return false;
}

/**
 * 默认容器样式
 */
const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '60vh',
  padding: '40px 20px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  color: '#333',
  textAlign: 'center',
};

/**
 * 错误图标样式
 */
const iconStyle: React.CSSProperties = {
  fontSize: '64px',
  marginBottom: '24px',
  lineHeight: 1,
};

/**
 * 标题样式
 */
const titleStyle: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 600,
  marginBottom: '12px',
  color: '#1a1a1a',
};

/**
 * 描述样式
 */
const descriptionStyle: React.CSSProperties = {
  fontSize: '16px',
  color: '#666',
  marginBottom: '32px',
  maxWidth: '480px',
  lineHeight: 1.6,
};

/**
 * 按钮通用样式
 */
const buttonBaseStyle: React.CSSProperties = {
  padding: '10px 24px',
  fontSize: '14px',
  fontWeight: 500,
  borderRadius: '6px',
  cursor: 'pointer',
  transition: 'all 0.2s ease',
  border: 'none',
  outline: 'none',
};

/**
 * 主按钮样式
 */
const primaryButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  backgroundColor: '#1677ff',
  color: '#fff',
};

/**
 * 次要按钮样式
 */
const secondaryButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  backgroundColor: '#fff',
  color: '#333',
  border: '1px solid #d9d9d9',
};

/**
 * 错误详情样式（开发环境）
 */
const detailsStyle: React.CSSProperties = {
  marginTop: '32px',
  padding: '16px',
  backgroundColor: '#fff2f0',
  borderRadius: '8px',
  border: '1px solid #ffccc7',
  maxWidth: '640px',
  width: '100%',
  textAlign: 'left',
};

/**
 * 错误堆栈样式
 */
const stackStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: '#cf1322',
  maxHeight: '300px',
  overflow: 'auto',
  padding: '8px',
  backgroundColor: '#fff',
  borderRadius: '4px',
  marginTop: '8px',
};

/**
 * 默认错误回退组件
 *
 * @example
 * ```tsx
 * <ErrorFallback
 *   error={error}
 *   resetError={() => setError(null)}
 *   title="加载失败"
 *   retryButtonText="点击重试"
 * />
 * ```
 */
export const ErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetError,
  showDetails,
  title = '页面出现了一些问题',
  description = '很抱歉，页面遇到了意外错误。您可以尝试刷新页面或稍后再试。',
  retryButtonText = '重新加载',
  homeButtonText = '返回首页',
  homeURL = '/',
  className,
  style,
}) => {
  // 是否显示详细错误信息
  const shouldShowDetails = showDetails ?? isDevelopment();

  // 重试处理
  const handleRetry = useCallback(() => {
    resetError();
  }, [resetError]);

  // 返回首页处理
  const handleGoHome = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.href = homeURL;
    }
  }, [homeURL]);

  return (
    <div
      className={className}
      style={{ ...containerStyle, ...style }}
      role="alert"
      aria-live="assertive"
    >
      {/* 错误图标（使用 Unicode 字符，无需引入图标库） */}
      <div style={iconStyle} aria-hidden="true">
        &#9888;
      </div>

      {/* 错误标题 */}
      <h1 style={titleStyle}>{title}</h1>

      {/* 错误描述 */}
      <p style={descriptionStyle}>{description}</p>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={handleRetry}
          aria-label={retryButtonText}
        >
          {retryButtonText}
        </button>

        {homeButtonText !== null && (
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={handleGoHome}
            aria-label={homeButtonText}
          >
            {homeButtonText}
          </button>
        )}
      </div>

      {/* 开发环境：显示错误详情 */}
      {shouldShowDetails && (
        <div style={detailsStyle}>
          <div style={{ fontWeight: 600, color: '#cf1322', marginBottom: '4px' }}>
            {error.name}: {error.message}
          </div>
          {error.stack && (
            <pre style={stackStyle}>
              {error.stack}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

ErrorFallback.displayName = 'ErrorFallback';
