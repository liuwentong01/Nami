/**
 * @nami/server - Stale-While-Revalidate (SWR) 逻辑辅助模块
 *
 * 实现 HTTP RFC 5861 中定义的 stale-while-revalidate 缓存策略的核心判断逻辑。
 *
 * SWR 策略的三种状态：
 *
 * ```
 * 时间线 →
 * |---------- fresh ---------|---- stale (可用) ----|---- expired (不可用) ----|
 * 0                      revalidateAfter        revalidateAfter * 2        ∞
 * ```
 *
 * 1. fresh（新鲜）: 创建时间 + revalidateAfter > 当前时间
 *    → 直接返回缓存，无需任何操作
 *
 * 2. stale（过期但可用）: 已过 revalidateAfter，但在宽限期内
 *    → 返回缓存给用户，同时后台触发重验证
 *
 * 3. expired（完全过期）: 超出宽限期
 *    → 缓存不可用，需要同步重新渲染
 *
 * @example
 * ```typescript
 * import { evaluateCacheFreshness, SWRState } from '@nami/server';
 *
 * const state = evaluateCacheFreshness(entry.createdAt, entry.revalidateAfter);
 *
 * switch (state) {
 *   case SWRState.Fresh:
 *     return cachedContent;
 *   case SWRState.Stale:
 *     triggerBackgroundRevalidation();
 *     return cachedContent;
 *   case SWRState.Expired:
 *     return await render();
 * }
 * ```
 */

/**
 * SWR 缓存新鲜度状态
 */
export enum SWRState {
  /** 新鲜 — 缓存在有效期内，可以直接使用 */
  Fresh = 'fresh',

  /** 过期但可用 — 可以返回给用户，但需要触发后台重验证 */
  Stale = 'stale',

  /** 完全过期 — 缓存不可用，需要同步重新渲染 */
  Expired = 'expired',
}

/**
 * SWR 评估结果
 */
export interface SWREvaluation {
  /** 缓存状态 */
  state: SWRState;

  /** 缓存年龄（秒） */
  age: number;

  /** 距离过期的剩余时间（秒），负数表示已过期 */
  ttl: number;

  /** 是否需要触发重验证 */
  needsRevalidation: boolean;
}

/**
 * SWR 配置选项
 */
export interface SWROptions {
  /**
   * stale 宽限期乘数
   *
   * stale 状态的最大持续时间 = revalidateAfter * staleMultiplier
   *
   * 默认: 2
   *
   * 例如 revalidateAfter = 60s, staleMultiplier = 2:
   * - 0-60s: Fresh（新鲜）
   * - 60-120s: Stale（过期但可用，触发后台重验证）
   * - >120s: Expired（完全过期，需要同步渲染）
   */
  staleMultiplier?: number;
}

/**
 * 评估缓存条目的新鲜度
 *
 * 根据缓存创建时间和重验证间隔，判断当前时刻缓存处于哪种状态。
 *
 * @param createdAt - 缓存创建时间戳（毫秒）
 * @param revalidateAfter - 重验证间隔（秒）
 * @param options - SWR 配置选项
 * @returns SWR 评估结果
 */
export function evaluateCacheFreshness(
  createdAt: number,
  revalidateAfter: number,
  options: SWROptions = {},
): SWREvaluation {
  const { staleMultiplier = 2 } = options;
  const now = Date.now();

  /**
   * 计算缓存年龄（秒）
   * 从缓存创建到当前时间的间隔
   */
  const ageMs = now - createdAt;
  const ageSec = ageMs / 1000;

  /**
   * 计算 TTL（距离过期的剩余时间）
   * 正数表示缓存仍然新鲜，负数表示已过期
   */
  const ttl = revalidateAfter - ageSec;

  /**
   * stale 状态的最大持续时间
   * 超过此时间后缓存完全不可用
   */
  const maxStaleAge = revalidateAfter * staleMultiplier;

  // 判断缓存状态
  if (ageSec <= revalidateAfter) {
    /**
     * Fresh 状态
     * 缓存在有效期内，可以直接使用，无需任何操作
     */
    return {
      state: SWRState.Fresh,
      age: ageSec,
      ttl,
      needsRevalidation: false,
    };
  }

  if (ageSec <= maxStaleAge) {
    /**
     * Stale 状态
     * 缓存已过期但在宽限期内，可以返回给用户，
     * 但需要触发后台重验证来更新缓存
     */
    return {
      state: SWRState.Stale,
      age: ageSec,
      ttl,
      needsRevalidation: true,
    };
  }

  /**
   * Expired 状态
   * 缓存完全过期，不应返回给用户
   * 需要同步执行渲染
   */
  return {
    state: SWRState.Expired,
    age: ageSec,
    ttl,
    needsRevalidation: true,
  };
}

/**
 * 判断缓存条目是否可直接使用（Fresh 或 Stale）
 *
 * 便捷函数，用于快速判断是否可以返回缓存内容给用户。
 *
 * @param createdAt - 缓存创建时间戳（毫秒）
 * @param revalidateAfter - 重验证间隔（秒）
 * @param options - SWR 配置选项
 * @returns 缓存是否可用
 */
export function isCacheUsable(
  createdAt: number,
  revalidateAfter: number,
  options?: SWROptions,
): boolean {
  const evaluation = evaluateCacheFreshness(createdAt, revalidateAfter, options);
  return evaluation.state !== SWRState.Expired;
}

/**
 * 判断缓存条目是否需要触发后台重验证
 *
 * @param createdAt - 缓存创建时间戳（毫秒）
 * @param revalidateAfter - 重验证间隔（秒）
 * @param options - SWR 配置选项
 * @returns 是否需要重验证
 */
export function needsRevalidation(
  createdAt: number,
  revalidateAfter: number,
  options?: SWROptions,
): boolean {
  const evaluation = evaluateCacheFreshness(createdAt, revalidateAfter, options);
  return evaluation.needsRevalidation;
}
