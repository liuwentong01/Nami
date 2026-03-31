/**
 * @nami/shared - 框架配置类型定义
 *
 * NamiConfig 是框架的核心配置结构，业务方通过 nami.config.ts 文件定义。
 * 框架在启动时加载并校验配置，合并默认值后传递给各模块使用。
 */

import type { RenderMode } from './render-mode';
import type { NamiRoute } from './route';
import type { NamiPlugin } from './plugin';
import type { Configuration as WebpackConfiguration } from 'webpack';

/**
 * 服务端配置
 */
export interface ServerConfig {
  /** 监听端口，默认 3000 */
  port: number;

  /** 监听地址，默认 '0.0.0.0' */
  host: string;

  /**
   * SSR 超时时间（毫秒）
   * 超过此时间数据预取将被中断，触发降级
   * 默认 5000ms
   */
  ssrTimeout: number;

  /** 是否启用优雅停机，默认 true */
  gracefulShutdown: boolean;

  /** 优雅停机等待时间（毫秒），默认 30000 */
  gracefulShutdownTimeout: number;

  /**
   * 多进程配置
   * 不配置则使用单进程模式
   */
  cluster?: {
    /** 工作进程数量，0 = CPU 核心数 */
    workers: number;
  };

  /**
   * 自定义 Koa 中间件
   * 在插件中间件之前注入
   */
  middlewares?: Array<import('koa').Middleware>;
}

/**
 * Webpack 自定义配置
 */
export interface WebpackCustomConfig {
  /** 修改客户端 Webpack 配置 */
  client?: (config: WebpackConfiguration) => WebpackConfiguration;
  /** 修改服务端 Webpack 配置 */
  server?: (config: WebpackConfiguration) => WebpackConfiguration;
}

/**
 * ISR 配置
 */
export interface ISRConfig {
  /** 是否启用 ISR，默认 false */
  enabled: boolean;

  /** 缓存目录，默认 '.nami-cache/isr' */
  cacheDir: string;

  /** 默认重验证间隔（秒），默认 60 */
  defaultRevalidate: number;

  /**
   * 缓存适配器类型
   * - 'memory':     进程内存缓存（适合开发和单进程部署）
   * - 'filesystem': 文件系统缓存（适合单机多进程部署）
   * - 'redis':      Redis 缓存（适合分布式多机部署）
   */
  cacheAdapter: 'filesystem' | 'redis' | 'memory';

  /** Redis 连接配置（当 cacheAdapter 为 'redis' 时必填） */
  redis?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    /** 键名前缀，默认 'nami:isr:' */
    keyPrefix?: string;
  };
}

/**
 * 监控配置
 */
export interface MonitorConfig {
  /** 是否启用监控，默认 false */
  enabled: boolean;

  /**
   * 采样率（0-1）
   * 1 = 全量采集，0.1 = 10% 采样
   */
  sampleRate: number;

  /** 监控数据上报地址 */
  reportUrl?: string;

  /** 是否采集 Web Vitals，默认 true */
  webVitals?: boolean;

  /** 是否采集渲染性能，默认 true */
  renderMetrics?: boolean;
}

/**
 * 降级配置
 */
export interface FallbackConfig {
  /**
   * SSR 失败时是否自动降级到 CSR
   * 默认 true
   */
  ssrToCSR: boolean;

  /**
   * 降级超时时间（毫秒）
   * SSR 渲染超过此时间自动触发降级
   * 默认与 server.ssrTimeout 一致
   */
  timeout: number;

  /**
   * 兜底静态 HTML
   * 所有降级手段失败后返回此 HTML
   */
  staticHTML?: string;

  /**
   * 最大重试次数
   * 默认 0（不重试）
   */
  maxRetries: number;
}

/**
 * 静态资源配置
 */
export interface AssetsConfig {
  /** 静态资源公共路径前缀，默认 '/' */
  publicPath: string;

  /** CDN 地址（如果使用 CDN） */
  cdnUrl?: string;

  /** 是否开启资源指纹（content hash），默认 true */
  hash: boolean;
}

/**
 * Nami 框架主配置
 *
 * 业务方在项目根目录创建 nami.config.ts 文件定义此配置。
 *
 * @example
 * ```typescript
 * // nami.config.ts
 * import { defineConfig } from '@nami/core';
 *
 * export default defineConfig({
 *   appName: 'my-app',
 *   defaultRenderMode: 'ssr',
 *   routes: [
 *     { path: '/', component: './pages/home', renderMode: 'ssr' },
 *     { path: '/about', component: './pages/about', renderMode: 'ssg' },
 *   ],
 * });
 * ```
 */
export interface NamiConfig {
  /** 应用名称，用于日志标识和监控上报 */
  appName: string;

  /** 源码目录，默认 'src' */
  srcDir: string;

  /** 输出目录，默认 'dist' */
  outDir: string;

  /** 默认渲染模式，默认 RenderMode.CSR */
  defaultRenderMode: RenderMode;

  /** 路由配置列表 */
  routes: NamiRoute[];

  /** 服务端配置 */
  server: ServerConfig;

  /** Webpack 自定义配置 */
  webpack: WebpackCustomConfig;

  /** ISR 增量静态再生配置 */
  isr: ISRConfig;

  /** 静态资源配置 */
  assets: AssetsConfig;

  /** 监控配置 */
  monitor: MonitorConfig;

  /** 降级配置 */
  fallback: FallbackConfig;

  /**
   * 插件列表
   * 支持插件实例或插件包名字符串
   */
  plugins: Array<NamiPlugin | string>;

  /** HTML 页面标题（默认值） */
  title?: string;

  /** HTML 页面描述（默认值） */
  description?: string;

  /** HTML 模板文件路径 */
  htmlTemplate?: string;

  /**
   * 环境变量注入
   * 以 NAMI_PUBLIC_ 前缀的变量会被注入到客户端代码中
   */
  env?: Record<string, string>;
}

/**
 * 用户侧配置（Partial）
 * 业务方在 nami.config.ts 中只需要填写需要覆盖默认值的字段
 */
export type UserNamiConfig = Partial<NamiConfig> & {
  /** appName 为必填项 */
  appName: string;
};
