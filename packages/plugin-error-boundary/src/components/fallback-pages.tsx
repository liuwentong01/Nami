/**
 * @nami/plugin-error-boundary - 内置降级页面组件
 *
 * 提供一组预设的错误降级页面，覆盖常见的错误场景：
 * - NotFoundPage:     404 页面未找到
 * - ServerErrorPage:  500 服务端错误
 * - NetworkErrorPage: 网络连接错误
 * - GenericErrorPage: 通用错误页面
 *
 * 所有页面组件支持自定义标题、描述和操作按钮，
 * 内置简洁美观的默认样式，无需额外 CSS。
 */

import React from 'react';

// ==================== 通用属性 ====================

/**
 * 降级页面通用属性
 */
export interface FallbackPageProps {
  /** 自定义标题 */
  title?: string;
  /** 自定义描述文本 */
  description?: string;
  /** 是否显示返回首页按钮 */
  showHomeButton?: boolean;
  /** 是否显示重试按钮 */
  showRetryButton?: boolean;
  /** 返回首页的路径 */
  homePath?: string;
  /** 重试回调 */
  onRetry?: () => void;
  /** 返回首页回调 */
  onGoHome?: () => void;
  /** 自定义操作区域 */
  actions?: React.ReactNode;
  /** 自定义类名 */
  className?: string;
  /** 自定义样式 */
  style?: React.CSSProperties;
}

// ==================== 通用容器样式 ====================

/** 页面容器样式 */
const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  padding: '40px 24px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  backgroundColor: '#fafafa',
  color: '#333',
  textAlign: 'center',
};

/** 状态码样式 */
const statusCodeStyle: React.CSSProperties = {
  fontSize: '96px',
  fontWeight: 700,
  lineHeight: 1,
  color: '#e0e0e0',
  marginBottom: '16px',
  letterSpacing: '-2px',
};

/** 标题样式 */
const titleStyle: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 600,
  color: '#1a1a1a',
  marginBottom: '12px',
  lineHeight: 1.4,
};

/** 描述样式 */
const descriptionStyle: React.CSSProperties = {
  fontSize: '15px',
  color: '#666',
  maxWidth: '480px',
  lineHeight: 1.6,
  marginBottom: '32px',
};

/** 按钮容器样式 */
const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: '12px',
  flexWrap: 'wrap',
  justifyContent: 'center',
};

/** 主按钮样式 */
const primaryButtonStyle: React.CSSProperties = {
  padding: '10px 28px',
  fontSize: '14px',
  fontWeight: 500,
  color: '#fff',
  backgroundColor: '#1677ff',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  transition: 'opacity 0.2s',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
};

/** 次级按钮样式 */
const secondaryButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  color: '#333',
  backgroundColor: '#fff',
  border: '1px solid #d9d9d9',
};

// ==================== NotFoundPage (404) ====================

/**
 * 404 页面未找到
 *
 * 当用户访问不存在的路由时展示此页面。
 *
 * @example
 * ```tsx
 * <NotFoundPage
 *   title="页面不存在"
 *   description="您访问的页面可能已被移除或链接地址有误。"
 *   onGoHome={() => navigate('/')}
 * />
 * ```
 */
export const NotFoundPage: React.FC<FallbackPageProps> = ({
  title = '页面未找到',
  description = '抱歉，您访问的页面不存在。请检查链接地址是否正确，或返回首页。',
  showHomeButton = true,
  showRetryButton = false,
  onGoHome,
  onRetry,
  homePath = '/',
  actions,
  className,
  style,
}) => {
  return (
    <div className={className} style={{ ...containerStyle, ...style }} role="alert">
      <div style={statusCodeStyle}>404</div>
      <h1 style={titleStyle}>{title}</h1>
      <p style={descriptionStyle}>{description}</p>
      <div style={actionsStyle}>
        {actions ?? (
          <>
            {showHomeButton && (
              <a
                href={homePath}
                onClick={(e) => {
                  if (onGoHome) {
                    e.preventDefault();
                    onGoHome();
                  }
                }}
                style={primaryButtonStyle}
              >
                返回首页
              </a>
            )}
            {showRetryButton && (
              <button onClick={onRetry} style={secondaryButtonStyle}>
                重新加载
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

NotFoundPage.displayName = 'NotFoundPage';

// ==================== ServerErrorPage (500) ====================

/**
 * 500 服务端错误页面属性
 */
export interface ServerErrorPageProps extends FallbackPageProps {
  /** 错误标识码（可用于客服沟通） */
  errorId?: string;
  /** 是否显示错误 ID */
  showErrorId?: boolean;
}

/**
 * 500 服务端错误
 *
 * 当服务端渲染失败或 API 返回 5xx 错误时展示。
 *
 * @example
 * ```tsx
 * <ServerErrorPage
 *   errorId="ERR-2024-001"
 *   onRetry={() => window.location.reload()}
 * />
 * ```
 */
export const ServerErrorPage: React.FC<ServerErrorPageProps> = ({
  title = '服务器开小差了',
  description = '抱歉，服务器遇到了问题。我们的工程师正在紧急处理中，请稍后再试。',
  showHomeButton = true,
  showRetryButton = true,
  onGoHome,
  onRetry,
  homePath = '/',
  errorId,
  showErrorId = true,
  actions,
  className,
  style,
}) => {
  return (
    <div className={className} style={{ ...containerStyle, ...style }} role="alert">
      <div style={statusCodeStyle}>500</div>
      <h1 style={titleStyle}>{title}</h1>
      <p style={descriptionStyle}>{description}</p>
      {errorId && showErrorId && (
        <p style={{ fontSize: '12px', color: '#999', marginBottom: '24px', fontFamily: 'monospace' }}>
          错误标识: {errorId}
        </p>
      )}
      <div style={actionsStyle}>
        {actions ?? (
          <>
            {showRetryButton && (
              <button
                onClick={onRetry ?? (() => {
                  if (typeof window !== 'undefined') {
                    window.location.reload();
                  }
                })}
                style={primaryButtonStyle}
              >
                重新加载
              </button>
            )}
            {showHomeButton && (
              <a
                href={homePath}
                onClick={(e) => {
                  if (onGoHome) {
                    e.preventDefault();
                    onGoHome();
                  }
                }}
                style={secondaryButtonStyle}
              >
                返回首页
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
};

ServerErrorPage.displayName = 'ServerErrorPage';

// ==================== NetworkErrorPage ====================

/**
 * 网络错误页面
 *
 * 当检测到网络连接问题时展示（离线、DNS 解析失败等）。
 *
 * @example
 * ```tsx
 * <NetworkErrorPage onRetry={() => fetchData()} />
 * ```
 */
export const NetworkErrorPage: React.FC<FallbackPageProps> = ({
  title = '网络连接异常',
  description = '无法连接到服务器，请检查您的网络设置后重试。',
  showHomeButton = false,
  showRetryButton = true,
  onGoHome,
  onRetry,
  homePath = '/',
  actions,
  className,
  style,
}) => {
  return (
    <div className={className} style={{ ...containerStyle, ...style }} role="alert">
      <div style={{ ...statusCodeStyle, fontSize: '64px', color: '#faad14' }}>
        {'~'}
      </div>
      <h1 style={titleStyle}>{title}</h1>
      <p style={descriptionStyle}>{description}</p>
      <div style={actionsStyle}>
        {actions ?? (
          <>
            {showRetryButton && (
              <button onClick={onRetry} style={primaryButtonStyle}>
                重新连接
              </button>
            )}
            {showHomeButton && (
              <a
                href={homePath}
                onClick={(e) => {
                  if (onGoHome) {
                    e.preventDefault();
                    onGoHome();
                  }
                }}
                style={secondaryButtonStyle}
              >
                返回首页
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
};

NetworkErrorPage.displayName = 'NetworkErrorPage';

// ==================== GenericErrorPage ====================

/**
 * 通用错误页面属性
 */
export interface GenericErrorPageProps extends FallbackPageProps {
  /** 错误对象 */
  error?: Error;
  /** HTTP 状态码 */
  statusCode?: number;
  /** 是否在开发环境显示详细错误信息 */
  showDetails?: boolean;
}

/**
 * 通用错误页面
 *
 * 适用于任意类型的错误展示，自动根据状态码调整显示内容。
 *
 * @example
 * ```tsx
 * <GenericErrorPage
 *   error={caughtError}
 *   statusCode={503}
 *   onRetry={() => retry()}
 *   showDetails={process.env.NODE_ENV !== 'production'}
 * />
 * ```
 */
export const GenericErrorPage: React.FC<GenericErrorPageProps> = ({
  title,
  description,
  error,
  statusCode,
  showDetails = false,
  showHomeButton = true,
  showRetryButton = true,
  onGoHome,
  onRetry,
  homePath = '/',
  actions,
  className,
  style,
}) => {
  // 根据状态码自动生成默认标题和描述
  const defaultTitle = statusCode
    ? getDefaultTitle(statusCode)
    : '出错了';
  const defaultDescription = statusCode
    ? getDefaultDescription(statusCode)
    : '页面遇到了一些问题，请稍后重试。';

  return (
    <div className={className} style={{ ...containerStyle, ...style }} role="alert">
      {statusCode && (
        <div style={statusCodeStyle}>{statusCode}</div>
      )}
      <h1 style={titleStyle}>{title ?? defaultTitle}</h1>
      <p style={descriptionStyle}>{description ?? defaultDescription}</p>

      {/* 开发环境显示详细错误信息 */}
      {showDetails && error && (
        <div
          style={{
            maxWidth: '600px',
            width: '100%',
            marginBottom: '24px',
            padding: '16px',
            backgroundColor: '#fff2f0',
            border: '1px solid #ffccc7',
            borderRadius: '8px',
            textAlign: 'left',
            fontSize: '13px',
            fontFamily: 'monospace',
            lineHeight: 1.6,
            overflow: 'auto',
            maxHeight: '300px',
          }}
        >
          <div style={{ fontWeight: 600, color: '#cf1322', marginBottom: '8px' }}>
            {error.name}: {error.message}
          </div>
          {error.stack && (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#666' }}>
              {error.stack}
            </pre>
          )}
        </div>
      )}

      <div style={actionsStyle}>
        {actions ?? (
          <>
            {showRetryButton && (
              <button onClick={onRetry} style={primaryButtonStyle}>
                重新加载
              </button>
            )}
            {showHomeButton && (
              <a
                href={homePath}
                onClick={(e) => {
                  if (onGoHome) {
                    e.preventDefault();
                    onGoHome();
                  }
                }}
                style={secondaryButtonStyle}
              >
                返回首页
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
};

GenericErrorPage.displayName = 'GenericErrorPage';

// ==================== 辅助函数 ====================

/** 根据状态码返回默认标题 */
function getDefaultTitle(statusCode: number): string {
  const titles: Record<number, string> = {
    400: '请求有误',
    401: '未登录',
    403: '没有权限',
    404: '页面未找到',
    408: '请求超时',
    429: '请求过于频繁',
    500: '服务器错误',
    502: '网关错误',
    503: '服务暂不可用',
    504: '网关超时',
  };
  return titles[statusCode] ?? '出错了';
}

/** 根据状态码返回默认描述 */
function getDefaultDescription(statusCode: number): string {
  const descriptions: Record<number, string> = {
    400: '您的请求格式有误，请检查后重试。',
    401: '请先登录后再访问此页面。',
    403: '抱歉，您没有权限访问此页面。',
    404: '您访问的页面不存在，请检查链接是否正确。',
    408: '请求超时，请检查网络后重试。',
    429: '您的请求过于频繁，请稍后再试。',
    500: '服务器遇到了问题，我们正在紧急修复中。',
    502: '网关服务异常，请稍后再试。',
    503: '服务暂时不可用，请稍后再试。',
    504: '网关响应超时，请稍后再试。',
  };
  return descriptions[statusCode] ?? '页面遇到了一些问题，请稍后重试。';
}
