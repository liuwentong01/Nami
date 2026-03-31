/**
 * @nami/core - 错误层导出入口
 *
 * 错误层提供框架的完整错误处理能力：
 *
 * 核心模块：
 * - ErrorHandler: 统一错误处理器（分类、日志、可恢复性判断）
 * - ErrorBoundary: React 错误边界组件（UI 层错误隔离）
 * - DegradationManager: 5 级降级管理器（渲染降级策略）
 * - ErrorReporter: 错误上报器（监控平台对接）
 */

// 错误处理器
export { ErrorHandler } from './error-handler';
export type { ErrorContext, ErrorHandleResult } from './error-handler';

// React 错误边界
export { ErrorBoundary } from './error-boundary';
export type { ErrorBoundaryProps } from './error-boundary';

// 降级管理器
export { DegradationManager } from './degradation';
export type { DegradationResult } from './degradation';

// 错误上报器
export { ErrorReporter } from './error-reporter';
export type { ReportContext } from './error-reporter';
