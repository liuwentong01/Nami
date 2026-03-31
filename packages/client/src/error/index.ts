/**
 * @nami/client - 错误层导出入口
 *
 * 导出客户端错误处理相关的所有公共 API：
 *
 * - ClientErrorBoundary: React 错误边界组件
 * - ErrorOverlay:        开发模式错误浮层
 */

// 错误边界
export { ClientErrorBoundary } from './client-error-boundary';
export type {
  ClientErrorBoundaryProps,
  FallbackRenderProps,
} from './client-error-boundary';

// 错误浮层
export { ErrorOverlay } from './error-overlay';
export type { ErrorOverlayProps } from './error-overlay';
