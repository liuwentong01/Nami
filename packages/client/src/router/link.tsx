/**
 * @nami/client - NamiLink 链接组件
 *
 * NamiLink 是对 react-router-dom 的 Link 组件的增强封装，
 * 在保持完整路由导航能力的基础上，增加了智能预取（prefetch）功能。
 *
 * 预取策略：
 * 1. Hover 预取（prefetchOnHover）
 *    当鼠标悬停在链接上时，提前加载目标路由的 JS chunk。
 *    基于"用户意图"推测：悬停通常意味着即将点击。
 *    延迟 100ms 触发，避免快速划过时产生无效请求。
 *
 * 2. 视口预取（prefetchOnVisible）
 *    当链接元素进入浏览器视口时，自动预加载目标路由。
 *    使用 IntersectionObserver 实现，适合导航列表、推荐链接等场景。
 *    通过 rootMargin 参数可以控制提前加载的距离。
 *
 * @module
 */

import React, { useRef, useEffect, useCallback, forwardRef } from 'react';
import { Link } from 'react-router-dom';
import type { LinkProps } from 'react-router-dom';
import { createLogger } from '@nami/shared';
import { prefetchRoute } from './route-prefetch';

// ==================== 类型定义 ====================

/**
 * NamiLink 组件的 Props
 *
 * 继承 react-router-dom Link 的所有 props，
 * 并增加预取相关的配置选项。
 */
export interface NamiLinkProps extends LinkProps {
  /**
   * 是否启用 hover 预取
   *
   * 当鼠标悬停在链接上时，提前加载目标路由的代码和数据。
   * @default false
   */
  prefetchOnHover?: boolean;

  /**
   * 是否启用视口预取
   *
   * 当链接进入浏览器可视区域时，自动预加载目标路由。
   * @default false
   */
  prefetchOnVisible?: boolean;

  /**
   * IntersectionObserver 的 rootMargin 参数
   * 控制提前触发预取的视口边距
   * @default '100px'
   */
  prefetchMargin?: string;

  /**
   * Hover 预取的延迟时间（毫秒）
   *
   * 避免鼠标快速划过时触发不必要的预取。
   * 设为 0 则立即触发。
   * @default 100
   */
  prefetchDelay?: number;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:link');

/**
 * 已预取路径的缓存集合
 *
 * 同一路径只需预取一次，避免重复请求浪费网络资源。
 */
const prefetchedPaths = new Set<string>();

/**
 * 从 LinkProps.to 中提取路径字符串
 *
 * react-router-dom 的 to prop 支持 string | Partial<Location> 两种类型，
 * 此函数统一提取为字符串路径。
 *
 * @param to - Link 组件的 to 属性值
 * @returns 字符串路径
 */
function extractPath(to: LinkProps['to']): string {
  if (typeof to === 'string') return to;
  return to.pathname ?? '/';
}

// ==================== 组件实现 ====================

/**
 * Nami 增强链接组件
 *
 * 使用 forwardRef 支持外部获取底层 <a> 元素的 ref，
 * 便于集成第三方库或进行 DOM 操作。
 *
 * @example
 * ```tsx
 * // 基础使用
 * <NamiLink to="/about">关于我们</NamiLink>
 *
 * // Hover 预取 — 悬停时提前加载
 * <NamiLink to="/dashboard" prefetchOnHover>
 *   控制台
 * </NamiLink>
 *
 * // 视口预取 — 进入视口时自动加载
 * <NamiLink to="/article/123" prefetchOnVisible prefetchMargin="200px">
 *   查看文章
 * </NamiLink>
 *
 * // 同时启用两种预取
 * <NamiLink to="/shop" prefetchOnHover prefetchOnVisible>
 *   商店
 * </NamiLink>
 * ```
 */
export const NamiLink = forwardRef<HTMLAnchorElement, NamiLinkProps>(
  (
    {
      prefetchOnHover = false,
      prefetchOnVisible = false,
      prefetchMargin = '100px',
      prefetchDelay = 100,
      to,
      onMouseEnter,
      ...restProps
    },
    forwardedRef,
  ) => {
    /** 内部 ref — 用于 IntersectionObserver 观察 */
    const internalRef = useRef<HTMLAnchorElement>(null);

    /**
     * 合并 ref
     *
     * 同时满足外部 forwardedRef 和内部 internalRef 的需求。
     * 当 DOM 元素挂载/卸载时，两个 ref 都会被更新。
     */
    const setRefs = useCallback(
      (node: HTMLAnchorElement | null) => {
        // 更新内部 ref
        (internalRef as React.MutableRefObject<HTMLAnchorElement | null>).current = node;

        // 更新外部 ref
        if (typeof forwardedRef === 'function') {
          forwardedRef(node);
        } else if (forwardedRef) {
          (forwardedRef as React.MutableRefObject<HTMLAnchorElement | null>).current = node;
        }
      },
      [forwardedRef],
    );

    /** 提取目标路径 */
    const targetPath = extractPath(to);

    /**
     * 执行预取操作
     *
     * 使用 Set 去重避免同一路径重复预取。
     */
    const doPrefetch = useCallback(() => {
      if (prefetchedPaths.has(targetPath)) return;

      prefetchedPaths.add(targetPath);
      logger.debug('预取路由', { path: targetPath });

      prefetchRoute(targetPath).catch((error) => {
        // 预取失败不应阻断用户操作，仅记录日志
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('路由预取失败', { path: targetPath, error: message });
        // 清除失败记录，允许重试
        prefetchedPaths.delete(targetPath);
      });
    }, [targetPath]);

    // -------------------- Hover 预取 --------------------

    /**
     * 鼠标进入事件处理
     *
     * 延迟执行预取以过滤掉快速划过的情况。
     * 同时保留外部传入的 onMouseEnter 回调。
     */
    const handleMouseEnter = useCallback(
      (event: React.MouseEvent<HTMLAnchorElement>) => {
        // 先调用外部的 onMouseEnter（如果有）
        onMouseEnter?.(event);

        if (!prefetchOnHover) return;

        if (prefetchDelay > 0) {
          // 延迟预取 — 避免快速划过时触发
          const timer = setTimeout(doPrefetch, prefetchDelay);
          const element = event.currentTarget;

          /**
           * 鼠标离开时取消延迟预取
           * 使用 { once: true } 确保事件监听器只触发一次并自动清理
           */
          const cancel = () => clearTimeout(timer);
          element.addEventListener('mouseleave', cancel, { once: true });
        } else {
          // 立即预取
          doPrefetch();
        }
      },
      [onMouseEnter, prefetchOnHover, prefetchDelay, doPrefetch],
    );

    // -------------------- 视口预取 --------------------

    useEffect(() => {
      if (!prefetchOnVisible) return;
      if (prefetchedPaths.has(targetPath)) return;

      const element = internalRef.current;
      if (!element) return;

      // 检查 IntersectionObserver 是否可用
      if (typeof IntersectionObserver === 'undefined') {
        // 降级：不支持 IntersectionObserver 的环境直接预取
        doPrefetch();
        return;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              doPrefetch();
              observer.disconnect();
              break;
            }
          }
        },
        { rootMargin: prefetchMargin },
      );

      observer.observe(element);

      return () => {
        observer.disconnect();
      };
    }, [prefetchOnVisible, targetPath, prefetchMargin, doPrefetch]);

    // -------------------- 渲染 --------------------

    return (
      <Link
        ref={setRefs}
        to={to}
        onMouseEnter={handleMouseEnter}
        {...restProps}
      />
    );
  },
);

NamiLink.displayName = 'NamiLink';
