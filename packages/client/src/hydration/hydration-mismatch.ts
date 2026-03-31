/**
 * @nami/client - Hydration 不匹配检测与上报工具
 *
 * 当服务端渲染的 HTML 与客户端 React 树不一致时，就会发生 Hydration Mismatch。
 * 这个模块负责：
 *
 * 1. 检测和分类 Hydration 错误
 *    将 React 报告的错误信息解析为结构化的不匹配类型
 *
 * 2. 上报 Hydration 错误
 *    将结构化信息发送到监控系统，帮助开发者定位问题
 *
 * 常见的 Hydration 不匹配原因：
 * - 文本内容不匹配（如动态时间戳、随机数、locale 差异）
 * - 属性不匹配（如 className、style 的计算值差异）
 * - 节点结构不匹配（如条件渲染依赖客户端状态）
 * - 额外/缺失节点（如浏览器扩展注入的 DOM 元素）
 *
 * @module
 */

import { createLogger, ErrorCode, NamiError, ErrorSeverity } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * Hydration 不匹配类型
 *
 * 对 React 报告的 Hydration 错误进行分类，
 * 不同类型对应不同的修复策略。
 */
export enum MismatchType {
  /** 文本内容不一致 — 如 "2024-01-01" vs "2024-01-02" */
  TextContent = 'text-content',
  /** HTML 属性不一致 — 如 class="dark" vs class="light" */
  Attribute = 'attribute',
  /** DOM 节点类型不一致 — 如 <div> vs <span> */
  ElementType = 'element-type',
  /** 额外的 DOM 节点 — 客户端渲染了服务端没有的节点 */
  ExtraNode = 'extra-node',
  /** 缺失的 DOM 节点 — 服务端渲染了客户端没有的节点 */
  MissingNode = 'missing-node',
  /** 未知类型 — 无法分类的 Hydration 错误 */
  Unknown = 'unknown',
}

/**
 * Hydration 不匹配详情
 *
 * 结构化的错误信息，用于日志记录和监控上报。
 */
export interface MismatchDetail {
  /** 不匹配类型 */
  type: MismatchType;
  /** 原始错误消息 */
  message: string;
  /** 发生不匹配的组件/元素标签名（如果能解析） */
  element?: string;
  /** 服务端渲染的值（如果能解析） */
  serverValue?: string;
  /** 客户端渲染的值（如果能解析） */
  clientValue?: string;
  /** 不匹配发生的时间戳 */
  timestamp: number;
  /** 当前页面 URL */
  url: string;
}

/**
 * 不匹配上报选项
 */
export interface MismatchReportOptions {
  /** 监控上报 URL */
  reportUrl?: string;
  /** 应用名称 */
  appName?: string;
  /**
   * 采样率（0-1）
   * @default 1 — 默认全量上报（Hydration 错误通常需要全量关注）
   */
  sampleRate?: number;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:hydration-mismatch');

/**
 * React Hydration 错误消息的匹配模式
 *
 * React 在 Hydration 过程中会产生特定格式的错误消息，
 * 这里列出常见的模式用于分类识别。
 * 注意：React 版本更新可能会改变错误消息格式。
 */
const MISMATCH_PATTERNS: Array<{
  pattern: RegExp;
  type: MismatchType;
}> = [
  // React 18 文本内容不匹配
  {
    pattern: /text content/i,
    type: MismatchType.TextContent,
  },
  // React 18 属性不匹配（如 "Did not expect server HTML to contain"）
  {
    pattern: /did not expect server html/i,
    type: MismatchType.ExtraNode,
  },
  // 服务端 HTML 额外节点
  {
    pattern: /extra attributes/i,
    type: MismatchType.Attribute,
  },
  // Hydration 失败通用消息
  {
    pattern: /hydration failed/i,
    type: MismatchType.Unknown,
  },
  // 客户端渲染与服务端不匹配
  {
    pattern: /there was an error while hydrating/i,
    type: MismatchType.Unknown,
  },
  // 属性差异
  {
    pattern: /prop.*did not match/i,
    type: MismatchType.Attribute,
  },
  // 服务端渲染的内容与客户端不一致
  {
    pattern: /server.*client/i,
    type: MismatchType.TextContent,
  },
  // 标签类型不匹配
  {
    pattern: /expected.*tag/i,
    type: MismatchType.ElementType,
  },
];

// ==================== 公共 API ====================

/**
 * 检测并分类 Hydration 错误
 *
 * 解析 React 产生的 Hydration 错误消息，将其归类为具体的不匹配类型。
 * 这对于在监控面板上统计不同类型的 Hydration 问题非常有用。
 *
 * @param error - React 产生的 Hydration 错误（可以是 Error 对象或任意值）
 * @returns 结构化的不匹配详情
 *
 * @example
 * ```typescript
 * const detail = detectMismatch(new Error('Text content does not match'));
 * console.log(detail.type); // 'text-content'
 * ```
 */
export function detectMismatch(error: unknown): MismatchDetail {
  const message = error instanceof Error ? error.message : String(error);
  const url = typeof window !== 'undefined' ? window.location.href : '';

  // 遍历匹配模式，找到第一个匹配的类型
  let matchedType = MismatchType.Unknown;
  for (const { pattern, type } of MISMATCH_PATTERNS) {
    if (pattern.test(message)) {
      matchedType = type;
      break;
    }
  }

  const detail: MismatchDetail = {
    type: matchedType,
    message,
    timestamp: Date.now(),
    url,
  };

  // 尝试从错误消息中提取更多信息
  // React 的某些错误消息包含服务端与客户端值的对比
  const serverClientMatch = message.match(/server:\s*"([^"]*)"\s*client:\s*"([^"]*)"/i);
  if (serverClientMatch) {
    detail.serverValue = serverClientMatch[1];
    detail.clientValue = serverClientMatch[2];
  }

  logger.debug('检测到 Hydration 不匹配', {
    type: detail.type,
    message: detail.message,
    url: detail.url,
  });

  return detail;
}

/**
 * 上报 Hydration 不匹配错误
 *
 * 将检测到的不匹配信息发送到监控平台。
 * 优先使用 navigator.sendBeacon（页面卸载时也能可靠发送），
 * 降级使用 fetch。
 *
 * @param error   - 原始错误
 * @param context - 附加上下文信息（如组件名、页面路径等）
 * @param options - 上报选项（URL、采样率等）
 *
 * @example
 * ```typescript
 * reportMismatch(error, { component: 'Header', route: '/home' }, {
 *   reportUrl: 'https://monitor.example.com/api/hydration-mismatch',
 *   sampleRate: 1,
 * });
 * ```
 */
export function reportMismatch(
  error: unknown,
  context: Record<string, unknown> = {},
  options: MismatchReportOptions = {},
): void {
  const { reportUrl, appName = 'nami-app', sampleRate = 1 } = options;

  // 采样率检查 — Hydration 错误默认全量上报
  if (Math.random() > sampleRate) {
    logger.debug('Hydration 不匹配上报被采样跳过');
    return;
  }

  // 检测不匹配类型
  const detail = detectMismatch(error);

  // 构造上报载荷
  const payload = {
    appName,
    type: 'hydration-mismatch',
    detail,
    context,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    timestamp: Date.now(),
  };

  logger.warn('上报 Hydration 不匹配', {
    type: detail.type,
    url: detail.url,
    appName,
  });

  // 没有配置上报地址，仅记录日志
  if (!reportUrl) {
    logger.debug('未配置 reportUrl，Hydration 不匹配仅记录日志', payload);
    return;
  }

  // 发送上报数据
  try {
    const body = JSON.stringify(payload);

    // 优先使用 sendBeacon — 可靠且不阻塞页面
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      const sent = navigator.sendBeacon(reportUrl, blob);
      if (sent) {
        logger.debug('Hydration 不匹配已通过 sendBeacon 上报');
        return;
      }
    }

    // 降级使用 fetch
    if (typeof globalThis.fetch === 'function') {
      globalThis.fetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch((fetchError: Error) => {
        logger.warn('Hydration 不匹配上报失败', { error: fetchError.message });
      });
    }
  } catch (sendError) {
    // 上报失败不应影响应用运行
    const message = sendError instanceof Error ? sendError.message : String(sendError);
    logger.warn('Hydration 不匹配上报异常', { error: message });
  }
}

/**
 * 创建 Hydration 不匹配的 NamiError 实例
 *
 * 用于将 Hydration 不匹配统一为框架标准错误体系。
 *
 * @param error - 原始错误
 * @returns NamiError 实例
 */
export function createMismatchError(error: unknown): NamiError {
  const detail = detectMismatch(error);

  return new NamiError(
    `Hydration 不匹配 [${detail.type}]: ${detail.message}`,
    ErrorCode.RENDER_HYDRATION_MISMATCH,
    ErrorSeverity.Warning,
    {
      mismatchType: detail.type,
      url: detail.url,
      serverValue: detail.serverValue,
      clientValue: detail.clientValue,
    },
  );
}
