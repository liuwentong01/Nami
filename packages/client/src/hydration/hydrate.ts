/**
 * @nami/client - 主 Hydration 逻辑
 *
 * 本模块提供两种客户端挂载方式：
 *
 * 1. hydrateApp  — 用于 SSR/SSG/ISR 模式
 *    使用 React 18 的 hydrateRoot API 将服务端渲染的 HTML 与客户端 React 树进行对接。
 *    服务端已经返回了完整的 HTML 标记，hydrateRoot 仅为其附加事件监听器和交互能力，
 *    而不会重新创建 DOM 节点（除非检测到不匹配）。
 *
 * 2. renderApp   — 用于纯 CSR 模式
 *    使用 React 18 的 createRoot API 进行全量客户端渲染。
 *    此时容器通常是空 DOM 节点，React 将完整创建所有 DOM 元素。
 *
 * React 18 Hydration 特性：
 * - Concurrent Mode 支持：hydrateRoot 默认启用并发特性
 * - 可恢复错误处理：通过 onRecoverableError 回调捕获 Hydration 不匹配等可恢复错误
 * - Selective Hydration：配合 Suspense 实现按优先级的渐进式 Hydration
 *
 * @module
 */

import { hydrateRoot, createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { createLogger, ErrorCode, NamiError, ErrorSeverity } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * Hydration 配置选项
 *
 * 控制 hydrateRoot 的行为参数。
 */
export interface HydrateOptions {
  /**
   * 可恢复错误回调
   *
   * 当 React 在 Hydration 期间检测到不匹配但可以自动恢复时调用。
   * 常见场景：
   * - 服务端与客户端渲染内容不一致（如时间戳、随机数）
   * - 浏览器自动修正的 HTML 结构（如 <p> 嵌套 <div>）
   *
   * @param error - 可恢复的错误对象
   */
  onRecoverableError?: (error: unknown) => void;

  /**
   * Hydration 完成后的回调
   * 在 React 树成功附加到 DOM 后触发
   */
  onHydrated?: () => void;

  /**
   * 用于标识应用实例的 ID
   * 同一页面多个 Nami 应用实例时使用
   */
  identifierPrefix?: string;
}

// ==================== 内部工具 ====================

/** 模块内部日志实例 */
const logger = createLogger('@nami/client:hydration');

/**
 * 默认的可恢复错误处理函数
 *
 * 在开发环境下会在控制台输出详细的警告信息，
 * 帮助开发者定位和修复 Hydration 不匹配问题。
 * 生产环境下仅记录简略日志，避免性能损耗。
 *
 * @param error - React 提供的可恢复错误
 */
function defaultRecoverableErrorHandler(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  if (process.env.NODE_ENV !== 'production') {
    // 开发环境：输出详细信息以帮助定位问题
    console.warn(
      '[Nami Hydration] 检测到可恢复的 Hydration 错误:\n',
      message,
      '\n\n提示: 这通常意味着服务端与客户端渲染的内容不一致。',
      '\n请检查以下常见原因:',
      '\n  1. 使用了 Date.now()、Math.random() 等时间/随机相关逻辑',
      '\n  2. 仅在客户端可用的 API（如 window.innerWidth）被用于渲染',
      '\n  3. 浏览器扩展修改了 DOM 结构',
    );
  }

  logger.warn('Hydration 可恢复错误', { error: message });
}

// ==================== 公共 API ====================

/**
 * 以 Hydration 模式挂载应用（用于 SSR/SSG/ISR）
 *
 * 调用 React 18 的 hydrateRoot API，将客户端 React 组件树
 * 附加到服务端已渲染的 DOM 上。Hydration 过程中 React 会：
 * 1. 遍历已有的 DOM 节点，为其添加事件监听器
 * 2. 与客户端组件树进行对比，发现不匹配时触发可恢复错误
 * 3. 完成后应用变为可交互状态
 *
 * @param container - 挂载容器 DOM 元素（通常是 #nami-root）
 * @param app       - React 应用根元素（<NamiApp />）
 * @param options   - Hydration 配置选项
 * @returns React Root 实例（可用于后续更新或卸载）
 *
 * @example
 * ```tsx
 * const root = hydrateApp(
 *   document.getElementById('nami-root')!,
 *   <NamiApp routes={routes} config={config} />,
 *   { onHydrated: () => console.log('Hydration 完成') },
 * );
 * ```
 */
export function hydrateApp(
  container: Element,
  app: React.ReactElement,
  options: HydrateOptions = {},
): Root {
  const {
    onRecoverableError = defaultRecoverableErrorHandler,
    onHydrated,
    identifierPrefix,
  } = options;

  logger.info('开始 Hydration 过程', {
    containerId: container.id,
    childrenCount: container.childNodes.length,
  });

  try {
    /**
     * hydrateRoot 是 React 18 引入的 API，替代旧版 ReactDOM.hydrate。
     * 与 createRoot 不同，hydrateRoot 期望容器中已有 HTML 内容，
     * 它会复用已有的 DOM 节点而非重新创建。
     */
    const root = hydrateRoot(container, app, {
      onRecoverableError,
      identifierPrefix,
    });

    // Hydration 完成回调
    // 注意：hydrateRoot 本身是同步调用，但实际的 Hydration 是异步的
    // 使用 requestIdleCallback 延迟执行以确保 Hydration 已完成
    if (onHydrated) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => {
          onHydrated();
          logger.info('Hydration 完成（通过 requestIdleCallback 确认）');
        });
      } else {
        // 降级方案：使用 setTimeout
        setTimeout(() => {
          onHydrated();
          logger.info('Hydration 完成（通过 setTimeout 降级确认）');
        }, 0);
      }
    }

    return root;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error('Hydration 失败', { error: message });

    throw new NamiError(
      `Hydration 失败: ${message}`,
      ErrorCode.RENDER_HYDRATION_MISMATCH,
      ErrorSeverity.Error,
      { containerId: container.id },
    );
  }
}

/**
 * 以 CSR 模式挂载应用（用于纯客户端渲染）
 *
 * 使用 React 18 的 createRoot API 进行完整的客户端渲染。
 * 适用于以下场景：
 * - 纯 CSR 渲染模式
 * - SSR Hydration 失败后的降级渲染
 *
 * @param container - 挂载容器 DOM 元素
 * @param app       - React 应用根元素
 * @returns React Root 实例
 *
 * @example
 * ```tsx
 * const root = renderApp(
 *   document.getElementById('nami-root')!,
 *   <NamiApp routes={routes} config={config} />,
 * );
 * ```
 */
export function renderApp(container: Element, app: React.ReactElement): Root {
  logger.info('开始 CSR 渲染', { containerId: container.id });

  try {
    const root = createRoot(container);
    root.render(app);

    logger.info('CSR 渲染成功');
    return root;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error('CSR 渲染失败', { error: message });

    throw new NamiError(
      `CSR 渲染失败: ${message}`,
      ErrorCode.RENDER_CSR_FAILED,
      ErrorSeverity.Error,
      { containerId: container.id },
    );
  }
}
