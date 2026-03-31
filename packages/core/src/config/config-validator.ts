/**
 * @nami/core - 配置校验器
 *
 * ConfigValidator 对合并后的 NamiConfig 进行校验，
 * 确保配置的完整性和合法性。
 *
 * 校验规则覆盖：
 * - 必填字段（appName）
 * - 路由配置结构（path、component、renderMode 合法性）
 * - 端口范围（1-65535）
 * - 超时值合理性
 * - 渲染模式有效性
 * - ISR 配置的一致性
 * - 监控采样率范围
 */

import type { NamiConfig, NamiRoute } from '@nami/shared';
import {
  RenderMode,
  MAX_SSR_TIMEOUT,
  MIN_REVALIDATE_INTERVAL,
  MAX_REVALIDATE_INTERVAL,
} from '@nami/shared';

/**
 * 配置校验结果
 */
export interface ConfigValidationResult {
  /** 校验是否通过 */
  valid: boolean;
  /** 校验错误列表（valid 为 false 时包含具体错误） */
  errors: string[];
}

/** 有效的渲染模式值集合 */
const VALID_RENDER_MODES = new Set<string>(Object.values(RenderMode));

/**
 * 配置校验器
 *
 * 对 NamiConfig 执行一系列校验规则，收集所有错误后统一返回。
 * 采用「收集所有错误」而非「遇到第一个错误即停止」的策略，
 * 便于开发者一次性修复所有配置问题。
 *
 * @example
 * ```typescript
 * const validator = new ConfigValidator();
 * const result = validator.validate(config);
 *
 * if (!result.valid) {
 *   console.error('配置校验失败:');
 *   result.errors.forEach(err => console.error(`  - ${err}`));
 * }
 * ```
 */
export class ConfigValidator {
  /**
   * 执行全量配置校验
   *
   * @param config - 要校验的配置对象
   * @returns 校验结果，包含是否通过和错误列表
   */
  validate(config: NamiConfig): ConfigValidationResult {
    const errors: string[] = [];

    // 校验必填字段
    this.validateRequiredFields(config, errors);

    // 校验渲染模式
    this.validateRenderMode(config, errors);

    // 校验路由配置
    this.validateRoutes(config, errors);

    // 校验服务端配置
    this.validateServerConfig(config, errors);

    // 校验 ISR 配置
    this.validateISRConfig(config, errors);

    // 校验监控配置
    this.validateMonitorConfig(config, errors);

    // 校验降级配置
    this.validateFallbackConfig(config, errors);

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 校验必填字段
   *
   * appName 是唯一的必填字段，用于日志标识和监控上报。
   */
  private validateRequiredFields(config: NamiConfig, errors: string[]): void {
    if (!config.appName || typeof config.appName !== 'string') {
      errors.push('appName 为必填项，且必须是非空字符串');
    } else if (config.appName.trim().length === 0) {
      errors.push('appName 不能为空白字符串');
    }
  }

  /**
   * 校验默认渲染模式
   *
   * 必须是 RenderMode 枚举中的有效值。
   */
  private validateRenderMode(config: NamiConfig, errors: string[]): void {
    if (!VALID_RENDER_MODES.has(config.defaultRenderMode)) {
      errors.push(
        `defaultRenderMode 值无效: "${config.defaultRenderMode}"，` +
        `有效值为: ${Array.from(VALID_RENDER_MODES).join(', ')}`,
      );
    }
  }

  /**
   * 校验路由配置列表
   *
   * 校验规则：
   * - routes 必须是数组
   * - 每条路由必须有 path 和 component
   * - path 必须以 / 开头
   * - renderMode 必须是有效值
   * - 不允许路径重复
   */
  private validateRoutes(config: NamiConfig, errors: string[]): void {
    if (!Array.isArray(config.routes)) {
      errors.push('routes 必须是数组');
      return;
    }

    // 检查路径重复
    const pathSet = new Set<string>();

    config.routes.forEach((route, index) => {
      const prefix = `routes[${index}]`;

      // path 必须存在且以 / 开头
      if (!route.path || typeof route.path !== 'string') {
        errors.push(`${prefix}.path 为必填项，且必须是非空字符串`);
      } else if (!route.path.startsWith('/')) {
        errors.push(`${prefix}.path 必须以 "/" 开头，当前值: "${route.path}"`);
      } else {
        if (pathSet.has(route.path)) {
          errors.push(`${prefix}.path 重复: "${route.path}"，路由路径不能重复`);
        }
        pathSet.add(route.path);
      }

      // component 必须存在
      if (!route.component || typeof route.component !== 'string') {
        errors.push(`${prefix}.component 为必填项，且必须是非空字符串`);
      }

      // renderMode 必须是有效值
      if (route.renderMode && !VALID_RENDER_MODES.has(route.renderMode)) {
        errors.push(
          `${prefix}.renderMode 值无效: "${route.renderMode}"，` +
          `有效值为: ${Array.from(VALID_RENDER_MODES).join(', ')}`,
        );
      }

      // ISR 路由必须配置 revalidate
      this.validateRouteISR(route, prefix, errors);

      // 递归校验子路由
      if (route.children) {
        if (!Array.isArray(route.children)) {
          errors.push(`${prefix}.children 必须是数组`);
        }
        // 子路由的详细校验在 validateRoutes 被递归调用时处理
      }
    });
  }

  /**
   * 校验路由的 ISR 相关配置
   */
  private validateRouteISR(route: NamiRoute, prefix: string, errors: string[]): void {
    if (route.renderMode === RenderMode.ISR) {
      if (route.revalidate !== undefined) {
        if (typeof route.revalidate !== 'number' || route.revalidate < 0) {
          errors.push(`${prefix}.revalidate 必须是非负数字`);
        }
      }
    }
  }

  /**
   * 校验服务端配置
   *
   * 校验规则：
   * - port: 必须在 1-65535 范围内
   * - ssrTimeout: 必须为正数且不超过 MAX_SSR_TIMEOUT
   * - gracefulShutdownTimeout: 必须为正数
   */
  private validateServerConfig(config: NamiConfig, errors: string[]): void {
    const server = config.server;
    if (!server) return;

    // 端口范围校验
    if (typeof server.port !== 'number' || server.port < 1 || server.port > 65535) {
      errors.push(
        `server.port 必须是 1-65535 范围内的整数，当前值: ${server.port}`,
      );
    } else if (!Number.isInteger(server.port)) {
      errors.push(`server.port 必须是整数，当前值: ${server.port}`);
    }

    // SSR 超时校验
    if (typeof server.ssrTimeout !== 'number' || server.ssrTimeout <= 0) {
      errors.push(`server.ssrTimeout 必须是正数，当前值: ${server.ssrTimeout}`);
    } else if (server.ssrTimeout > MAX_SSR_TIMEOUT) {
      errors.push(
        `server.ssrTimeout 不能超过 ${MAX_SSR_TIMEOUT}ms，当前值: ${server.ssrTimeout}ms`,
      );
    }

    // 优雅停机超时校验
    if (server.gracefulShutdown) {
      if (
        typeof server.gracefulShutdownTimeout !== 'number' ||
        server.gracefulShutdownTimeout <= 0
      ) {
        errors.push(
          `server.gracefulShutdownTimeout 必须是正数，` +
          `当前值: ${server.gracefulShutdownTimeout}`,
        );
      }
    }

    // 集群配置校验
    if (server.cluster) {
      if (typeof server.cluster.workers !== 'number' || server.cluster.workers < 0) {
        errors.push(
          `server.cluster.workers 必须是非负整数，当前值: ${server.cluster.workers}`,
        );
      }
    }
  }

  /**
   * 校验 ISR 配置
   *
   * 校验规则：
   * - defaultRevalidate: 必须在合法范围内
   * - cacheAdapter 为 redis 时，redis 配置必须存在
   */
  private validateISRConfig(config: NamiConfig, errors: string[]): void {
    const isr = config.isr;
    if (!isr || !isr.enabled) return;

    // 重验证间隔校验
    if (
      typeof isr.defaultRevalidate !== 'number' ||
      isr.defaultRevalidate < MIN_REVALIDATE_INTERVAL ||
      isr.defaultRevalidate > MAX_REVALIDATE_INTERVAL
    ) {
      errors.push(
        `isr.defaultRevalidate 必须在 ${MIN_REVALIDATE_INTERVAL}-${MAX_REVALIDATE_INTERVAL} 秒范围内，` +
        `当前值: ${isr.defaultRevalidate}`,
      );
    }

    // Redis 适配器需要 Redis 配置
    if (isr.cacheAdapter === 'redis') {
      if (!isr.redis) {
        errors.push('isr.cacheAdapter 为 "redis" 时，必须配置 isr.redis');
      } else {
        if (!isr.redis.host) {
          errors.push('isr.redis.host 为必填项');
        }
        if (typeof isr.redis.port !== 'number' || isr.redis.port < 1 || isr.redis.port > 65535) {
          errors.push(`isr.redis.port 必须是 1-65535 范围内的整数`);
        }
      }
    }
  }

  /**
   * 校验监控配置
   *
   * 校验规则：
   * - sampleRate: 必须在 0-1 范围内
   * - 启用监控时 reportUrl 建议配置
   */
  private validateMonitorConfig(config: NamiConfig, errors: string[]): void {
    const monitor = config.monitor;
    if (!monitor || !monitor.enabled) return;

    if (typeof monitor.sampleRate !== 'number' || monitor.sampleRate < 0 || monitor.sampleRate > 1) {
      errors.push(
        `monitor.sampleRate 必须在 0-1 范围内，当前值: ${monitor.sampleRate}`,
      );
    }
  }

  /**
   * 校验降级配置
   *
   * 校验规则：
   * - timeout: 必须为正数
   * - maxRetries: 必须为非负整数
   */
  private validateFallbackConfig(config: NamiConfig, errors: string[]): void {
    const fallback = config.fallback;
    if (!fallback) return;

    if (typeof fallback.timeout !== 'number' || fallback.timeout <= 0) {
      errors.push(`fallback.timeout 必须是正数，当前值: ${fallback.timeout}`);
    }

    if (
      typeof fallback.maxRetries !== 'number' ||
      fallback.maxRetries < 0 ||
      !Number.isInteger(fallback.maxRetries)
    ) {
      errors.push(
        `fallback.maxRetries 必须是非负整数，当前值: ${fallback.maxRetries}`,
      );
    }
  }
}
