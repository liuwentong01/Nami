/**
 * @nami/core - 钩子注册表
 *
 * HookRegistry 负责管理所有生命周期钩子的注册与查询。
 * 它是插件系统的核心数据结构，维护钩子名称到处理器列表的映射关系。
 *
 * 设计要点：
 * 1. 每个钩子可以有多个处理器（来自不同插件）
 * 2. 处理器按照插件的 enforce 属性排序：pre -> normal -> post
 * 3. 相同 enforce 级别的处理器按注册顺序执行
 * 4. 注册时会验证钩子名称是否合法（是否在 HOOK_DEFINITIONS 中定义）
 */

import {
  HOOK_DEFINITIONS,
  NamiError,
  ErrorCode,
  ErrorSeverity,
} from '@nami/shared';
import type { HookDefinition } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * 钩子处理器条目
 *
 * 记录一个钩子处理器的完整信息，包括：
 * - 处理函数本身
 * - 来源插件名称（用于调试和错误追踪）
 * - 执行顺序标记（用于排序）
 */
export interface HookHandler {
  /** 钩子处理函数 */
  fn: (...args: unknown[]) => unknown;
  /** 注册此处理器的插件名称 */
  pluginName: string;
  /** 执行顺序控制：pre 在前，post 在后，undefined 为 normal */
  enforce?: 'pre' | 'post';
}

/**
 * enforce 属性到排序权重的映射
 *
 * 数值越小越靠前执行：
 * - pre:    0（最先执行）
 * - normal: 1（默认顺序）
 * - post:   2（最后执行）
 */
const ENFORCE_ORDER: Record<string, number> = {
  pre: 0,
  normal: 1,
  post: 2,
};

// ==================== HookRegistry 类 ====================

/**
 * 钩子注册表
 *
 * 管理所有生命周期钩子处理器的注册和检索。
 * 是 PluginManager 和 PluginAPIImpl 之间的桥梁。
 *
 * @example
 * ```typescript
 * const registry = new HookRegistry();
 *
 * // 注册钩子处理器
 * registry.register('onBeforeRender', myHandler, 'my-plugin', 'pre');
 *
 * // 获取某个钩子的所有处理器（已排序）
 * const handlers = registry.getHandlers('onBeforeRender');
 * ```
 */
export class HookRegistry {
  /**
   * 钩子处理器存储
   *
   * 键: 钩子名称（如 'onBeforeRender'）
   * 值: 该钩子对应的所有处理器列表
   */
  private handlers: Map<string, HookHandler[]> = new Map();

  /**
   * 注册一个钩子处理器
   *
   * @param hookName   - 钩子名称，必须是 HOOK_DEFINITIONS 中定义的合法钩子
   * @param fn         - 处理函数
   * @param pluginName - 注册此处理器的插件名称（用于调试追踪）
   * @param enforce    - 执行顺序控制，可选值: 'pre' | 'post' | undefined
   *
   * @throws NamiError 当钩子名称不合法时抛出 PLUGIN_HOOK_FAILED 错误
   */
  register(
    hookName: string,
    fn: (...args: unknown[]) => unknown,
    pluginName: string,
    enforce?: 'pre' | 'post',
  ): void {
    // 验证钩子名称是否在框架定义的钩子列表中
    if (!HOOK_DEFINITIONS[hookName]) {
      throw new NamiError(
        `插件 [${pluginName}] 尝试注册未知钩子: ${hookName}`,
        ErrorCode.PLUGIN_HOOK_FAILED,
        ErrorSeverity.Error,
        { pluginName, hookName },
      );
    }

    // 验证处理函数是否为函数类型
    if (typeof fn !== 'function') {
      throw new NamiError(
        `插件 [${pluginName}] 为钩子 [${hookName}] 注册了非函数类型的处理器`,
        ErrorCode.PLUGIN_HOOK_FAILED,
        ErrorSeverity.Error,
        { pluginName, hookName, fnType: typeof fn },
      );
    }

    // 如果该钩子还没有处理器列表，先初始化
    if (!this.handlers.has(hookName)) {
      this.handlers.set(hookName, []);
    }

    // 创建处理器条目
    const handler: HookHandler = {
      fn,
      pluginName,
      enforce,
    };

    // 添加到处理器列表中
    const handlerList = this.handlers.get(hookName)!;
    handlerList.push(handler);

    // 重新排序：按照 enforce 优先级排序（pre -> normal -> post）
    // 相同 enforce 级别内保持注册顺序（稳定排序）
    handlerList.sort((a, b) => {
      const orderA = ENFORCE_ORDER[a.enforce ?? 'normal'] ?? 1;
      const orderB = ENFORCE_ORDER[b.enforce ?? 'normal'] ?? 1;
      return orderA - orderB;
    });
  }

  /**
   * 获取指定钩子的所有处理器
   *
   * 返回按照 enforce 排序后的处理器列表副本。
   * 如果钩子不存在或没有注册处理器，返回空数组。
   *
   * @param hookName - 钩子名称
   * @returns 已排序的处理器列表（防御性复制，不影响内部数据）
   */
  getHandlers(hookName: string): HookHandler[] {
    return [...(this.handlers.get(hookName) ?? [])];
  }

  /**
   * 检查指定钩子是否有已注册的处理器
   *
   * @param hookName - 钩子名称
   * @returns 如果有至少一个处理器返回 true
   */
  hasHandlers(hookName: string): boolean {
    const list = this.handlers.get(hookName);
    return list !== undefined && list.length > 0;
  }

  /**
   * 获取指定钩子的定义信息
   *
   * @param hookName - 钩子名称
   * @returns 钩子定义，如果钩子不存在则返回 undefined
   */
  getHookDefinition(hookName: string): HookDefinition | undefined {
    return HOOK_DEFINITIONS[hookName];
  }

  /**
   * 获取所有已注册处理器的钩子名称
   *
   * 用于调试和监控，可以查看哪些钩子被插件使用了。
   *
   * @returns 有处理器注册的钩子名称列表
   */
  getRegisteredHookNames(): string[] {
    const names: string[] = [];
    for (const [hookName, handlerList] of this.handlers.entries()) {
      if (handlerList.length > 0) {
        names.push(hookName);
      }
    }
    return names;
  }

  /**
   * 获取注册表统计信息
   *
   * 返回每个钩子的处理器数量，用于调试和监控。
   *
   * @returns 钩子名称到处理器数量的映射
   */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const [hookName, handlerList] of this.handlers.entries()) {
      stats[hookName] = handlerList.length;
    }
    return stats;
  }

  /**
   * 移除指定插件注册的所有处理器
   *
   * 在插件卸载或热更新时使用。
   *
   * @param pluginName - 要移除处理器的插件名称
   * @returns 被移除的处理器数量
   */
  removeByPlugin(pluginName: string): number {
    let removedCount = 0;

    for (const [hookName, handlerList] of this.handlers.entries()) {
      const originalLength = handlerList.length;
      const filtered = handlerList.filter((h) => h.pluginName !== pluginName);
      removedCount += originalLength - filtered.length;
      this.handlers.set(hookName, filtered);
    }

    return removedCount;
  }

  /**
   * 清空所有注册的处理器
   *
   * 在框架关闭或重置时使用。
   */
  clear(): void {
    this.handlers.clear();
  }
}
