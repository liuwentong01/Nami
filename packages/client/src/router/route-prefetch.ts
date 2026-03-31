/**
 * @nami/client - 路由预取工具
 *
 * 路由预取（Route Prefetching）是一种网络层性能优化策略，
 * 在用户实际导航之前提前加载目标路由的资源（JS chunk 和数据）。
 *
 * 预取方式：
 *
 * 1. JS Chunk 预取
 *    通过动态创建 <link rel="prefetch"> 标签，让浏览器在空闲时间
 *    以低优先级下载目标路由的代码文件。
 *    浏览器会自动管理缓存，后续实际加载时直接使用缓存。
 *
 * 2. 数据预取
 *    通过调用数据 API 提前获取目标路由所需的服务端数据，
 *    将结果缓存在内存中，路由切换时直接使用缓存数据。
 *
 * 与 NamiLink 的配合：
 * - NamiLink 的 prefetchOnHover 和 prefetchOnVisible 内部调用此模块的 API
 * - 也可以直接调用 prefetchRoute 进行编程式预取
 *
 * @module
 */

import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * 预取选项
 */
export interface PrefetchOptions {
  /**
   * 是否预取 JS chunk
   * @default true
   */
  prefetchChunk?: boolean;

  /**
   * 是否预取数据
   * @default false
   */
  prefetchData?: boolean;

  /**
   * 数据预取 API 的 URL 前缀
   * @default '/_nami/data'
   */
  dataApiPrefix?: string;

  /**
   * 预取超时时间（毫秒）
   * 超时后放弃预取，不影响后续正常加载
   * @default 5000
   */
  timeout?: number;
}

// ==================== 内部状态 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:route-prefetch');

/**
 * 已预取 JS chunk 的路径集合
 *
 * 避免同一路径的 JS 文件被重复预取。
 * 浏览器自身也有缓存机制，但提前去重可以减少 DOM 操作。
 */
const prefetchedChunks = new Set<string>();

/**
 * 预取的数据缓存
 *
 * key 为路径，value 为 { data, timestamp } 结构。
 * 数据有效期为 5 分钟，过期后允许重新预取。
 */
const dataCache = new Map<string, { data: unknown; timestamp: number }>();

/** 数据缓存有效期（毫秒）— 5 分钟 */
const DATA_CACHE_TTL = 5 * 60 * 1000;

// ==================== 公共 API ====================

/**
 * 预取指定路由的资源
 *
 * 主入口函数，整合 JS chunk 预取和数据预取。
 * 可以通过 options 控制预取的内容和行为。
 *
 * @param path    - 目标路由路径（如 '/dashboard'）
 * @param options - 预取选项
 *
 * @example
 * ```typescript
 * // 预取路由的 JS chunk（默认行为）
 * await prefetchRoute('/about');
 *
 * // 同时预取 JS chunk 和数据
 * await prefetchRoute('/user/123', {
 *   prefetchData: true,
 *   dataApiPrefix: '/_nami/data',
 * });
 *
 * // 编程式场景：页面加载完成后预取可能访问的页面
 * window.addEventListener('load', () => {
 *   prefetchRoute('/dashboard');
 *   prefetchRoute('/settings');
 * });
 * ```
 */
export async function prefetchRoute(
  path: string,
  options: PrefetchOptions = {},
): Promise<void> {
  const {
    prefetchChunk = true,
    prefetchData = false,
    dataApiPrefix = '/_nami/data',
    timeout = 5000,
  } = options;

  logger.debug('开始预取路由', { path, prefetchChunk, prefetchData });

  /**
   * 构造超时 Promise
   * 预取是非关键路径操作，超时后静默放弃即可
   */
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error(`路由预取超时: ${path}`)), timeout);
  });

  const tasks: Promise<void>[] = [];

  // JS chunk 预取
  if (prefetchChunk) {
    tasks.push(prefetchChunkForRoute(path));
  }

  // 数据预取
  if (prefetchData) {
    tasks.push(prefetchDataForRoute(path, dataApiPrefix));
  }

  if (tasks.length === 0) return;

  try {
    // 使用 Promise.race 实现超时控制
    await Promise.race([
      Promise.allSettled(tasks),
      timeoutPromise,
    ]);

    logger.debug('路由预取完成', { path });
  } catch (error) {
    // 预取超时或失败 — 仅记录日志，不影响应用正常运行
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('路由预取异常', { path, error: message });
  }
}

/**
 * 获取预取的数据缓存
 *
 * 供 useClientFetch 或路由组件使用，
 * 如果有缓存且未过期，直接使用缓存数据避免重复请求。
 *
 * @param path - 路由路径
 * @returns 缓存的数据，如果没有缓存或已过期返回 null
 */
export function getPrefetchedData<T = unknown>(path: string): T | null {
  const entry = dataCache.get(path);
  if (!entry) return null;

  // 检查缓存是否过期
  if (Date.now() - entry.timestamp > DATA_CACHE_TTL) {
    dataCache.delete(path);
    return null;
  }

  return entry.data as T;
}

/**
 * 清除所有预取缓存
 *
 * 在需要强制重新获取数据时使用（如用户身份变更）。
 */
export function clearPrefetchCache(): void {
  prefetchedChunks.clear();
  dataCache.clear();
  logger.debug('预取缓存已清除');
}

// ==================== 内部函数 ====================

/**
 * 预取路由的 JS chunk
 *
 * 实现方式：
 * 动态创建 <link rel="prefetch" as="script" href="..."> 标签，
 * 浏览器会以低优先级在空闲时间下载指定的 JS 文件。
 *
 * 路径到 chunk URL 的映射：
 * Nami 框架在构建阶段会生成 asset-manifest.json，
 * 其中包含路由路径到 chunk 文件名的对应关系。
 * 此处通过 window.__NAMI_MANIFEST__ 访问该映射。
 *
 * @param path - 路由路径
 */
async function prefetchChunkForRoute(path: string): Promise<void> {
  // 已经预取过，跳过
  if (prefetchedChunks.has(path)) {
    logger.debug('JS chunk 已预取，跳过', { path });
    return;
  }

  // 尝试从资源清单中获取 chunk URL
  const chunkUrl = resolveChunkUrl(path);
  if (!chunkUrl) {
    logger.debug('未找到路由对应的 chunk URL', { path });
    return;
  }

  try {
    /**
     * 创建 <link rel="prefetch"> 标签
     *
     * rel="prefetch" 告诉浏览器这是未来可能需要的资源，
     * 浏览器会在空闲时间以低优先级下载。
     * as="script" 告诉浏览器这是一个 JavaScript 文件。
     */
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'script';
    link.href = chunkUrl;

    // 使用 crossOrigin 属性确保跨域 chunk 可以被正确缓存
    link.crossOrigin = 'anonymous';

    /**
     * 监听加载完成/失败事件
     */
    await new Promise<void>((resolve, reject) => {
      link.onload = () => {
        prefetchedChunks.add(path);
        logger.debug('JS chunk 预取成功', { path, chunkUrl });
        resolve();
      };
      link.onerror = () => {
        logger.warn('JS chunk 预取失败', { path, chunkUrl });
        reject(new Error(`JS chunk 预取失败: ${chunkUrl}`));
      };
      document.head.appendChild(link);
    });
  } catch (error) {
    // 预取失败不影响后续正常加载
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('JS chunk 预取异常', { path, error: message });
  }
}

/**
 * 预取路由的数据
 *
 * 通过调用 Nami 框架的数据预取 API 获取目标路由的服务端数据。
 * 获取到的数据会被缓存到 dataCache 中。
 *
 * @param path          - 路由路径
 * @param dataApiPrefix - 数据 API 前缀
 */
async function prefetchDataForRoute(
  path: string,
  dataApiPrefix: string,
): Promise<void> {
  // 检查缓存是否存在且未过期
  const cached = dataCache.get(path);
  if (cached && Date.now() - cached.timestamp < DATA_CACHE_TTL) {
    logger.debug('数据缓存命中，跳过预取', { path });
    return;
  }

  try {
    const apiUrl = `${dataApiPrefix}${path}`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      logger.warn('数据预取请求失败', {
        path,
        status: response.status,
      });
      return;
    }

    const data = await response.json();

    // 存入缓存
    dataCache.set(path, { data, timestamp: Date.now() });
    logger.debug('数据预取成功', { path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('数据预取异常', { path, error: message });
  }
}

/**
 * 解析路由路径对应的 chunk URL
 *
 * 从框架生成的资源清单中查找路由路径对应的 JS chunk 文件 URL。
 * 资源清单在构建阶段生成，通过 window.__NAMI_MANIFEST__ 注入到页面。
 *
 * @param path - 路由路径
 * @returns chunk 文件 URL，未找到时返回 null
 */
function resolveChunkUrl(path: string): string | null {
  // 声明 window 上的自定义属性类型
  const win = window as unknown as {
    __NAMI_MANIFEST__?: {
      routes?: Record<string, { chunk?: string }>;
    };
  };

  const manifest = win.__NAMI_MANIFEST__;
  if (!manifest?.routes) {
    logger.debug('资源清单不可用，无法解析 chunk URL');
    return null;
  }

  const routeInfo = manifest.routes[path];
  return routeInfo?.chunk ?? null;
}
