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
 *   → 组装 { version, props, degraded, renderMode, routePath } envelope
 *   → safeStringify(envelope) → 转义 XSS 危险字符并注入 HTML
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
  NAMI_DATA_PROTOCOL_VERSION,
  RenderMode,
  createLogger,
  hydrateData,
} from '@nami/shared';
import type { HydrationPayload } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * 服务端注入数据的完整结构
 *
 * window.__NAMI_DATA__ 的类型定义。
 * 包含页面数据和可选的渲染元信息。
 */
export type ServerInjectedData = Partial<HydrationPayload> & Record<string, unknown>;

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:data-hydrator');

/** 标记数据是否已被读取 — 防止重复读取 */
let dataRead = false;

/** 缓存首次读取的数据 — 即使全局变量被清理后仍可访问 */
let cachedData: ServerInjectedData | null = null;

/** 一旦离开首屏 URL，初始快照永久失效，返回该 URL 时也不复用旧数据。 */
let dataScopeInvalidated = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRenderMode(value: unknown): RenderMode | undefined {
  switch (value) {
    case RenderMode.CSR:
    case RenderMode.SSR:
    case RenderMode.SSG:
    case RenderMode.ISR:
      return value;
    // Streaming SSR 是 SSR 的传输方式，不是独立的路由 RenderMode。
    case 'streaming-ssr':
      return RenderMode.SSR;
    default:
      return undefined;
  }
}

function resolveDocumentRenderMode(): RenderMode | undefined {
  if (typeof document === 'undefined') return undefined;
  const renderer = document.querySelector('meta[name="renderer"]')?.getAttribute('content');
  return resolveRenderMode(renderer);
}

function resolveCurrentRoutePath(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return `${window.location.pathname}${window.location.search}`;
}

function isCurrentDataRoute(data: ServerInjectedData): boolean {
  if (typeof data.routePath !== 'string' || typeof window === 'undefined') {
    return true;
  }

  if (data.renderMode === RenderMode.SSG) {
    return window.location.pathname === data.routePath;
  }

  return resolveCurrentRoutePath() === data.routePath;
}

function isServerDataActive(data: ServerInjectedData): boolean {
  if (dataScopeInvalidated) return false;

  if (!isCurrentDataRoute(data)) {
    dataScopeInvalidated = true;
    return false;
  }

  return true;
}

/**
 * 将历史裸 props 和无版本 envelope 归一化为当前注水协议。
 *
 * 该兼容层用于滚动发布：新客户端可能读取 CDN、ISR 或浏览器缓存中的旧 HTML，
 * 因此不能假设 window.__NAMI_DATA__ 一定由同一版本服务端生成。
 */
function normalizeServerData(rawData: Record<string, unknown>): ServerInjectedData {
  const hasEnvelopeMetadata = 'renderMode' in rawData || 'routePath' in rawData;
  const declaresEnvelope = hasEnvelopeMetadata && 'props' in rawData;
  const hasEnvelopeProps = isRecord(rawData.props);

  if (
    declaresEnvelope &&
    'version' in rawData &&
    rawData.version !== undefined &&
    rawData.version !== NAMI_DATA_PROTOCOL_VERSION
  ) {
    logger.warn('检测到不兼容的服务端注水协议，忽略该数据并使用 CSR 重建', {
      receivedVersion: rawData.version,
      supportedVersion: NAMI_DATA_PROTOCOL_VERSION,
    });
    return {};
  }

  if (declaresEnvelope && !hasEnvelopeProps) {
    logger.warn('检测到损坏的服务端注水协议，props 必须是普通对象，已使用 CSR 重建', {
      receivedType: Array.isArray(rawData.props) ? 'array' : typeof rawData.props,
    });
    return {};
  }

  // `version`、`props` 都可能是合法业务字段；只有同时出现框架元信息时，
  // 才把旧数据识别为 envelope，避免滚动发布期间吞掉同名业务字段。
  const hasEnvelopeShape = declaresEnvelope && hasEnvelopeProps;

  const renderMode = resolveRenderMode(rawData.renderMode) ?? resolveDocumentRenderMode();
  const routePath =
    typeof rawData.routePath === 'string'
      ? rawData.routePath
      : renderMode === RenderMode.SSG && typeof window !== 'undefined'
        ? window.location.pathname
        : resolveCurrentRoutePath();

  if (!hasEnvelopeShape) {
    return {
      version: NAMI_DATA_PROTOCOL_VERSION,
      props: rawData,
      degraded: false,
      renderMode,
      routePath,
    };
  }

  return {
    ...rawData,
    version: NAMI_DATA_PROTOCOL_VERSION,
    props: isRecord(rawData.props) ? rawData.props : {},
    degraded: rawData.degraded === true,
    renderMode,
    routePath,
  };
}

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
    return isServerDataActive(cachedData) ? cachedData : {};
  }

  // 使用 @nami/shared 的 hydrateData 工具函数读取
  const rawData = hydrateData<unknown>(NAMI_DATA_VARIABLE);

  if (rawData === null || rawData === undefined) {
    logger.debug('未检测到服务端注入数据（window.__NAMI_DATA__ 不存在）');
    cachedData = {};
    dataRead = true;
    return cachedData;
  }

  if (!isRecord(rawData)) {
    logger.warn('检测到无效的服务端注水数据，忽略并回退到 CSR', {
      receivedType: Array.isArray(rawData) ? 'array' : typeof rawData,
    });
    cachedData = {};
    dataRead = true;
    return cachedData;
  }

  const normalizedData = normalizeServerData(rawData);

  logger.info('成功读取服务端注入数据', {
    keys: Object.keys(normalizedData),
    renderMode: normalizedData.renderMode,
    routePath: normalizedData.routePath,
  });

  // 缓存数据
  cachedData = normalizedData;
  dataRead = true;

  return isServerDataActive(cachedData) ? cachedData : {};
}

/**
 * 使首屏服务端快照永久失效。
 *
 * 客户端路由离开初始 URL 时调用；只清理可见性，不删除缓存本身，确保正在
 * Hydration 的延迟子树仍可在离开路由之前读取同一份稳定快照。
 */
export function invalidateServerData(): void {
  if (!dataScopeInvalidated) {
    dataScopeInvalidated = true;
    logger.debug('首屏服务端数据已因路由切换失效');
  }
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
 * 在 Hydration 完成后清理
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
    delete (window as unknown as Record<string, unknown>)[NAMI_DATA_VARIABLE];
    logger.debug('已删除 window.__NAMI_DATA__ 全局变量');
  } catch (error) {
    // 某些严格模式下 delete 可能失败
    try {
      (window as unknown as Record<string, unknown>)[NAMI_DATA_VARIABLE] = undefined;
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
      if (script.textContent && script.textContent.includes(NAMI_DATA_VARIABLE)) {
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
  dataScopeInvalidated = false;
  logger.debug('DataHydrator 内部状态已重置');
}
