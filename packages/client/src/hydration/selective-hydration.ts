/**
 * @nami/client - 选择性 Hydration（Selective Hydration）
 *
 * 选择性 Hydration 是一种性能优化策略，允许页面中的不同区域
 * 按照优先级逐步完成 Hydration，而不是一次性 Hydrate 整个页面。
 *
 * 工作原理：
 * 1. 首屏（above-the-fold）内容优先 Hydrate，确保用户看到的内容最先可交互
 * 2. 非首屏内容使用 React.lazy + Suspense 延迟加载和 Hydrate
 * 3. 当用户滚动到视口区域或与之交互时，触发该区域的 Hydration
 *
 * React 18 的 Selective Hydration 支持：
 * - Suspense 边界内的组件可以独立完成 Hydration
 * - 用户交互（如点击）可以提升对应 Suspense 边界的 Hydration 优先级
 * - 这使得即使整体 Hydration 未完成，用户也能与已 Hydrate 的部分交互
 *
 * @module
 */

import React, { Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * Hydration 优先级枚举
 *
 * 决定组件何时被 Hydrate：
 * - Immediate: 立即 Hydrate（首屏关键内容）
 * - Idle:      浏览器空闲时 Hydrate
 * - Visible:   进入视口时 Hydrate
 * - Interaction: 用户交互时 Hydrate（如 hover、focus）
 */
export enum HydrationPriority {
  /** 立即 Hydrate — 用于首屏关键交互区域 */
  Immediate = 'immediate',
  /** 空闲时 Hydrate — 用于非紧急但需要预加载的区域 */
  Idle = 'idle',
  /** 进入视口时 Hydrate — 用于长页面的非首屏内容 */
  Visible = 'visible',
  /** 用户交互时 Hydrate — 用于极少使用的重型组件 */
  Interaction = 'interaction',
}

/**
 * SelectiveHydration 组件的 Props
 */
export interface SelectiveHydrationProps {
  /** 子组件 — 需要延迟 Hydrate 的内容 */
  children: React.ReactNode;

  /**
   * Hydration 优先级
   * @default HydrationPriority.Visible
   */
  priority?: HydrationPriority;

  /**
   * Hydration 之前显示的占位内容
   * 默认显示服务端渲染的 HTML（通过 dangerouslySetInnerHTML 保留）
   */
  fallback?: React.ReactNode;

  /**
   * IntersectionObserver 的 rootMargin 参数
   * 控制提前触发 Hydration 的距离（提前加载）
   * @default '200px'
   */
  rootMargin?: string;

  /**
   * 是否在 SSR 时渲染子组件
   * 设为 false 则 SSR 阶段跳过此组件的渲染
   * @default true
   */
  ssrRender?: boolean;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:selective-hydration');

// ==================== 组件实现 ====================

/**
 * 选择性 Hydration 容器组件
 *
 * 包裹需要延迟 Hydrate 的子组件，根据优先级策略决定何时触发 Hydration。
 *
 * 实现机制：
 * - 使用 React.Suspense 边界隔离 Hydration 过程
 * - 通过 `shouldHydrate` 状态控制组件是否被渲染（从而触发 Hydration）
 * - Visible 模式使用 IntersectionObserver 监听元素是否进入视口
 * - Idle 模式使用 requestIdleCallback 在浏览器空闲时触发
 * - Interaction 模式监听容器元素的 mouseenter/focusin 事件
 *
 * @example
 * ```tsx
 * // 首屏关键区域 — 立即 Hydrate
 * <SelectiveHydration priority={HydrationPriority.Immediate}>
 *   <Header />
 * </SelectiveHydration>
 *
 * // 非首屏内容 — 进入视口时 Hydrate
 * <SelectiveHydration priority={HydrationPriority.Visible}>
 *   <HeavyChart />
 * </SelectiveHydration>
 *
 * // 不常用的弹窗 — 用户交互时 Hydrate
 * <SelectiveHydration priority={HydrationPriority.Interaction}>
 *   <SettingsPanel />
 * </SelectiveHydration>
 * ```
 */
export const SelectiveHydration: React.FC<SelectiveHydrationProps> = ({
  children,
  priority = HydrationPriority.Visible,
  fallback,
  rootMargin = '200px',
  ssrRender = true,
}) => {
  /**
   * 是否应该开始 Hydration
   * Immediate 模式默认为 true，其他模式默认为 false，等待条件满足后触发
   */
  const [shouldHydrate, setShouldHydrate] = useState(
    priority === HydrationPriority.Immediate,
  );

  /** 容器 DOM 元素引用 — 用于 IntersectionObserver 和事件监听 */
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * 触发 Hydration 的回调函数
   * 使用 useCallback 缓存以避免不必要的重渲染
   */
  const triggerHydration = useCallback(() => {
    setShouldHydrate(true);
    logger.debug('触发 Hydration', { priority });
  }, [priority]);

  // -------------------- Idle 模式 --------------------
  useEffect(() => {
    if (priority !== HydrationPriority.Idle || shouldHydrate) return;

    /**
     * 使用 requestIdleCallback 在浏览器空闲时触发 Hydration。
     * 这保证了不会阻塞用户交互和关键渲染任务。
     * 如果浏览器不支持（如旧版 Safari），降级使用 setTimeout。
     */
    let handle: number;

    if (typeof requestIdleCallback === 'function') {
      handle = requestIdleCallback(() => {
        triggerHydration();
      });
      return () => cancelIdleCallback(handle);
    }

    // 降级：使用 setTimeout 模拟空闲调度
    handle = window.setTimeout(() => {
      triggerHydration();
    }, 200);

    return () => clearTimeout(handle);
  }, [priority, shouldHydrate, triggerHydration]);

  // -------------------- Visible 模式 --------------------
  useEffect(() => {
    if (priority !== HydrationPriority.Visible || shouldHydrate) return;

    const element = containerRef.current;
    if (!element) return;

    /**
     * IntersectionObserver 监听容器元素是否进入视口。
     * rootMargin 参数允许提前触发（在元素还未完全进入视口时就开始 Hydration），
     * 这减少了用户滚动到该区域时等待 Hydration 的延迟。
     */
    if (typeof IntersectionObserver === 'undefined') {
      // 不支持 IntersectionObserver 的环境，直接触发
      triggerHydration();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            triggerHydration();
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [priority, shouldHydrate, rootMargin, triggerHydration]);

  // -------------------- Interaction 模式 --------------------
  useEffect(() => {
    if (priority !== HydrationPriority.Interaction || shouldHydrate) return;

    const element = containerRef.current;
    if (!element) return;

    /**
     * 监听用户交互事件来触发 Hydration。
     * 使用 focusin（而非 focus）因为 focusin 支持事件冒泡，
     * 可以捕获容器内任意子元素的聚焦行为。
     */
    const handleInteraction = () => {
      triggerHydration();
    };

    element.addEventListener('mouseenter', handleInteraction, { once: true });
    element.addEventListener('focusin', handleInteraction, { once: true });
    element.addEventListener('touchstart', handleInteraction, { once: true, passive: true });

    return () => {
      element.removeEventListener('mouseenter', handleInteraction);
      element.removeEventListener('focusin', handleInteraction);
      element.removeEventListener('touchstart', handleInteraction);
    };
  }, [priority, shouldHydrate, triggerHydration]);

  // -------------------- 渲染逻辑 --------------------

  /**
   * SSR 阶段的渲染处理：
   * - 当 ssrRender 为 true 时，服务端正常渲染子组件
   * - 当 ssrRender 为 false 时，服务端返回空容器（节省首屏 HTML 体积）
   */
  if (typeof window === 'undefined') {
    // 服务端环境
    return React.createElement(
      'div',
      { 'data-nami-hydration': priority, ref: containerRef },
      ssrRender ? children : fallback || null,
    );
  }

  /**
   * 客户端渲染：
   * - 未触发 Hydration 前：显示 fallback 内容（或保留 SSR HTML）
   * - 触发 Hydration 后：通过 Suspense 渲染真正的子组件
   */
  if (!shouldHydrate) {
    return React.createElement(
      'div',
      {
        ref: containerRef,
        'data-nami-hydration': priority,
        'data-nami-hydration-pending': 'true',
      },
      fallback || null,
    );
  }

  return React.createElement(
    Suspense,
    { fallback: fallback || null },
    React.createElement(
      'div',
      {
        ref: containerRef,
        'data-nami-hydration': priority,
        'data-nami-hydration-ready': 'true',
      },
      children,
    ),
  );
};

SelectiveHydration.displayName = 'SelectiveHydration';
