/**
 * @nami/client - ErrorOverlay 开发模式错误浮层
 *
 * ErrorOverlay 是一个仅在开发环境中展示的全屏错误浮层组件。
 * 当应用发生未捕获的错误时，显示完整的错误信息和调用栈，
 * 帮助开发者快速定位问题。
 *
 * 设计参考了 Create React App 和 Next.js 的开发错误浮层，
 * 提供以下信息：
 * - 错误类型和消息
 * - 完整的 JavaScript 调用栈
 * - React 组件调用栈（componentStack）
 * - 关闭按钮（关闭后可继续使用应用的其他部分）
 *
 * 安全保证：
 * - 仅在 process.env.NODE_ENV !== 'production' 时渲染
 * - 生产构建时此组件的代码会被 tree-shaking 移除
 *
 * @module
 */

import React, { useState, useCallback, useEffect } from 'react';
import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * ErrorOverlay 组件 Props
 */
export interface ErrorOverlayProps {
  /** 错误对象 */
  error: Error;

  /**
   * React 组件调用栈
   *
   * 由 Error Boundary 的 componentDidCatch 提供的 errorInfo.componentStack。
   * 显示错误从哪个组件树路径中冒泡上来。
   */
  componentStack?: string;

  /**
   * 关闭回调
   *
   * 点击关闭按钮或按 Escape 键时触发。
   */
  onDismiss?: () => void;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:error-overlay');

// ==================== 样式定义 ====================

/**
 * 浮层样式
 *
 * 使用内联样式而非 CSS 文件，确保在样式加载失败时仍能正常显示。
 * 这对于捕获样式加载阶段的错误尤为重要。
 */
const styles = {
  /** 全屏遮罩层 */
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    zIndex: 99999,
    overflow: 'auto',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '40px 20px',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },

  /** 内容容器 */
  container: {
    backgroundColor: '#1e1e1e',
    borderRadius: '8px',
    maxWidth: '960px',
    width: '100%',
    color: '#e0e0e0',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
  },

  /** 头部区域 */
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 24px',
    borderBottom: '1px solid #333',
  },

  /** 错误标题 */
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600 as const,
    color: '#ff6b6b',
  },

  /** 关闭按钮 */
  closeButton: {
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '4px 8px',
    lineHeight: 1,
    borderRadius: '4px',
  },

  /** 错误消息区域 */
  messageSection: {
    padding: '24px',
    borderBottom: '1px solid #333',
  },

  /** 错误消息文本 */
  message: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 500 as const,
    color: '#fff',
    lineHeight: 1.6,
    wordBreak: 'break-word' as const,
  },

  /** 调用栈区域 */
  stackSection: {
    padding: '16px 24px',
    borderBottom: '1px solid #333',
  },

  /** 区域标题 */
  sectionTitle: {
    fontSize: '12px',
    fontWeight: 600 as const,
    textTransform: 'uppercase' as const,
    color: '#888',
    marginBottom: '12px',
    letterSpacing: '1px',
  },

  /** 调用栈文本 */
  stackTrace: {
    margin: 0,
    padding: '16px',
    backgroundColor: '#141414',
    borderRadius: '4px',
    fontSize: '13px',
    lineHeight: 1.8,
    color: '#ccc',
    overflow: 'auto',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    maxHeight: '400px',
  },

  /** 底部操作区 */
  footer: {
    padding: '16px 24px',
    display: 'flex',
    gap: '12px',
  },

  /** 操作按钮 */
  actionButton: {
    padding: '8px 16px',
    border: '1px solid #555',
    borderRadius: '4px',
    background: '#2a2a2a',
    color: '#e0e0e0',
    cursor: 'pointer',
    fontSize: '13px',
  },
} as const;

// ==================== 组件实现 ====================

/**
 * 开发模式错误浮层组件
 *
 * 全屏展示错误信息和调用栈，帮助开发者快速定位问题。
 * **仅在开发环境中渲染**，生产环境返回 null。
 *
 * @example
 * ```tsx
 * // 在 Error Boundary 中使用
 * class DevErrorBoundary extends React.Component {
 *   state = { error: null, errorInfo: null };
 *
 *   componentDidCatch(error, errorInfo) {
 *     this.setState({ error, errorInfo });
 *   }
 *
 *   render() {
 *     if (this.state.error) {
 *       return (
 *         <ErrorOverlay
 *           error={this.state.error}
 *           componentStack={this.state.errorInfo?.componentStack}
 *           onDismiss={() => this.setState({ error: null })}
 *         />
 *       );
 *     }
 *     return this.props.children;
 *   }
 * }
 * ```
 */
export const ErrorOverlay: React.FC<ErrorOverlayProps> = ({
  error,
  componentStack,
  onDismiss,
}) => {
  /**
   * 生产环境安全保护
   * 即使开发者不小心在生产代码中引用了此组件，也不会渲染
   */
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  /** 是否显示浮层 */
  const [visible, setVisible] = useState(true);

  /**
   * 关闭浮层
   */
  const handleDismiss = useCallback(() => {
    setVisible(false);
    onDismiss?.();
    logger.debug('错误浮层已关闭');
  }, [onDismiss]);

  /**
   * 复制错误信息到剪贴板
   */
  const handleCopyError = useCallback(() => {
    const text = [
      `Error: ${error.message}`,
      '',
      'Stack Trace:',
      error.stack || '(无调用栈)',
      '',
      componentStack ? `Component Stack:${componentStack}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    navigator.clipboard?.writeText(text).then(() => {
      logger.debug('错误信息已复制到剪贴板');
    }).catch(() => {
      // 复制失败不影响功能
    });
  }, [error, componentStack]);

  /**
   * 键盘事件 — Escape 关闭浮层
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleDismiss();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleDismiss]);

  // 已关闭时不渲染
  if (!visible) return null;

  return (
    <div style={styles.overlay} role="dialog" aria-label="错误信息">
      <div style={styles.container}>
        {/* -------- 头部 -------- */}
        <div style={styles.header}>
          <h3 style={styles.title}>
            {error.name || 'Error'}
          </h3>
          <button
            style={styles.closeButton}
            onClick={handleDismiss}
            aria-label="关闭错误浮层"
            title="关闭 (Esc)"
          >
            &#x2715;
          </button>
        </div>

        {/* -------- 错误消息 -------- */}
        <div style={styles.messageSection}>
          <p style={styles.message}>{error.message}</p>
        </div>

        {/* -------- JavaScript 调用栈 -------- */}
        {error.stack && (
          <div style={styles.stackSection}>
            <div style={styles.sectionTitle}>CALL STACK</div>
            <pre style={styles.stackTrace}>{error.stack}</pre>
          </div>
        )}

        {/* -------- React 组件调用栈 -------- */}
        {componentStack && (
          <div style={styles.stackSection}>
            <div style={styles.sectionTitle}>COMPONENT STACK</div>
            <pre style={styles.stackTrace}>{componentStack}</pre>
          </div>
        )}

        {/* -------- 底部操作 -------- */}
        <div style={styles.footer}>
          <button style={styles.actionButton} onClick={handleCopyError}>
            复制错误信息
          </button>
          <button
            style={styles.actionButton}
            onClick={() => window.location.reload()}
          >
            刷新页面
          </button>
        </div>
      </div>
    </div>
  );
};

ErrorOverlay.displayName = 'ErrorOverlay';
