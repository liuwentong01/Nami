/**
 * @nami/client - DataHydrator 数据注水器
 *
 * DataHydrator 负责管理服务端注入到 HTML 中的预取数据的生命周期：
 *
 * 1. 读取数据：从 window.__NAMI_DATA__ 中安全地读取服务端序列化的数据
 * 2. 清理数据：在 Hydration 完成后清理 <script> 标签和全局变量，
 *    释放内存并避免数据被意外二次使用
 *
 * 数据注入流程（完整链路）：
 *
 * 服务端：
 *   getServerSideProps() → 返回 { props: { ... } }
 *   → safeStringify(props) → 转义 XSS 危险字符
 *   → <script>window.__NAMI_DATA__ = {...}</script> → 注入 HTML
 *
 * 客户端：
 *   DataHydrator.readServerData() → 读取 window.__NAMI_DATA__
 *   → 作为组件初始 props 传递给 NamiApp
 *   → DataHydrator.cleanupServerData() → 清除全局变量和 script 标签
 *
 * @module
 */

import {
  NAMI_DATA_VARIABLE,
  createLogger,
  hydrateData,
} from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * 服务端注入数据的完整结构
 *
 * window.__NAMI_DATA__ 的类型定义。
 * 包含页面数据和可选的渲染元信息。
 */
export interface ServerInjectedData {
  /** 页面组件的 props 数据 */
  props?: Record<string, unknown>;

  /** 渲染模式标识 — 客户端用于判断 hydrate 还是 render */
  renderMode?: string;

  /** 路由路径 — 用于客户端路由初始化 */
  routePath?: string;

  /** 其他由插件注入的自定义数据 */
  [key: string]: unknown;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:data-hydrator');

/** 标记数据是否已被读取 — 防止重复读取 */
let dataRead = false;

/** 缓存首次读取的数据 — 即使全局变量被清理后仍可访问 */
let cachedData: ServerInjectedData | null = null;

// ==================== 公共 API ====================

/**
 * 读取服务端注入数据
 *
 * 从 window.__NAMI_DATA__ 中读取服务端在 SSR 阶段序列化的预取数据。
 * 首次读取后数据会被缓存，后续调用直接返回缓存。
 *
 * @returns 服务端注入的数据对象，如果不存在返回空对象
 *
 * @example
 * ```typescript
 * const serverData = readServerData();
 * console.log(serverData.props);       // 页面 props
 * console.log(serverData.renderMode);  // 'ssr' | 'csr' | 'ssg' | 'isr'
 * ```
 */
export function readServerData(): ServerInjectedData {
  // 服务端环境安全保护
  if (typeof window === 'undefined') {
    logger.debug('服务端环境，返回空数据');
    return {};
  }

  // 使用缓存
  if (dataRead && cachedData !== null) {
    logger.debug('返回缓存的服务端数据');
    return cachedData;
  }

  // 使用 @nami/shared 的 hydrateData 工具函数读取
  const rawData = hydrateData<ServerInjectedData>(NAMI_DATA_VARIABLE);

  if (rawData === null || rawData === undefined) {
    logger.debug('未检测到服务端注入数据（window.__NAMI_DATA__ 不存在）');
    cachedData = {};
    dataRead = true;
    return cachedData;
  }

  logger.info('成功读取服务端注入数据', {
    keys: Object.keys(rawData),
    renderMode: rawData.renderMode,
    routePath: rawData.routePath,
  });

  // 缓存数据
  cachedData = rawData;
  dataRead = true;

  return cachedData;
}

/**
 * 清理服务端注入数据
 *
 * 在 Hydration 完成后调用，执行以下清理操作：
 *
 * 1. 删除 window.__NAMI_DATA__ 全局变量
 *    释放内存，避免大数据量长期占用
 *
 * 2. 移除注入数据的 <script> 标签
 *    保持 DOM 整洁，避免浏览器 DevTools 中显示冗余信息
 *
 * 注意：
 * - 清理不会影响已经通过 readServerData 缓存的数据
 * - 清理后 useNamiData Hook 仍可通过内部缓存返回数据
 * - 建议在 onHydrated 钩子中调用此函数
 *
 * @example
 * ```typescript
 * // 在 Hydration 完成后清理
 * api.onHydrated(() => {
 *   cleanupServerData();
 * });
 * ```
 */
export function cleanupServerData(): void {
  // 服务端环境安全保护
  if (typeof window === 'undefined') {
    return;
  }

  // 1. 删除全局变量
  try {
    delete (window as Record<string, unknown>)[NAMI_DATA_VARIABLE];
    logger.debug('已删除 window.__NAMI_DATA__ 全局变量');
  } catch (error) {
    // 某些严格模式下 delete 可能失败
    try {
      (window as Record<string, unknown>)[NAMI_DATA_VARIABLE] = undefined;
    } catch {
      // 忽略 — 清理失败不影响应用运行
    }
    logger.debug('通过赋值 undefined 清理全局变量');
  }

  // 2. 移除注入数据的 <script> 标签
  try {
    /**
     * 查找包含 __NAMI_DATA__ 赋值的 script 标签
     *
     * 服务端生成的 script 标签格式：
     * <script>window.__NAMI_DATA__={...}</script>
     *
     * 通过遍历所有 <script> 标签并检查内容来定位。
     */
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      if (
        script.textContent &&
        script.textContent.includes(NAMI_DATA_VARIABLE)
      ) {
        script.parentNode?.removeChild(script);
        logger.debug('已移除数据注入的 <script> 标签');
        break;
      }
    }
  } catch (error) {
    // DOM 操作失败不影响应用运行
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('移除 <script> 标签失败', { error: message });
  }

  logger.info('服务端注入数据已清理完成');
}

/**
 * 重置 DataHydrator 内部状态
 *
 * 仅用于测试环境。生产环境中不应调用此方法。
 * 重置后 readServerData 会重新从 window 读取数据。
 */
export function resetDataHydrator(): void {
  dataRead = false;
  cachedData = null;
  logger.debug('DataHydrator 内部状态已重置');
}
