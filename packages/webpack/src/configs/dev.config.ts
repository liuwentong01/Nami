/**
 * @nami/webpack - 开发模式配置
 *
 * 开发模式优化目标：
 * - 快速启动（跳过优化步骤）
 * - 快速增量编译（文件系统缓存 + 转译模式）
 * - HMR 热模块替换（即时反馈）
 * - 详细错误信息（丰富的 Source Map）
 */

import type { Configuration } from 'webpack';
import type { NamiConfig } from '@nami/shared';
import { createClientConfig } from './client.config';
import { createServerConfig } from './server.config';

/**
 * 开发模式配置选项
 */
export interface DevConfigOptions {
  /** Nami 框架配置 */
  config: NamiConfig;
  /** 项目根目录 */
  projectRoot: string;
}

/**
 * 创建开发模式的客户端 Webpack 配置
 *
 * @param options - 开发配置选项
 * @returns Webpack Configuration
 */
export function createDevClientConfig(options: DevConfigOptions): Configuration {
  return createClientConfig({
    ...options,
    isDev: true,
  });
}

/**
 * 创建开发模式的服务端 Webpack 配置
 *
 * @param options - 开发配置选项
 * @returns Webpack Configuration
 */
export function createDevServerConfig(options: DevConfigOptions): Configuration {
  return createServerConfig({
    ...options,
    isDev: true,
  });
}
