/**
 * @nami/webpack - SSG 静态生成构建配置
 *
 * SSG 构建分为两步：
 * 1. 编译服务端代码（复用 server.config）
 * 2. 加载编译后的代码，执行 getStaticProps 并 renderToString 生成 HTML
 *
 * 此配置主要用于步骤 1，步骤 2 由 NamiBuilder 的 generateStatic 方法执行。
 */

import type { Configuration } from 'webpack';
import type { NamiConfig } from '@nami/shared';
import { createServerConfig } from './server.config';

/**
 * SSG 构建配置选项
 */
export interface SSGConfigOptions {
  /** Nami 框架配置 */
  config: NamiConfig;
  /** 项目根目录 */
  projectRoot: string;
}

/**
 * 创建 SSG 构建配置
 *
 * SSG 的 Webpack 配置与 Server 配置基本相同，
 * 区别在于输出目录和入口文件不同。
 *
 * SSG 产物结构：
 * ```
 * dist/static/
 * ├── index.html                # 首页
 * ├── about/index.html          # 关于页
 * ├── user/
 * │   ├── 1/index.html          # 动态路由预生成
 * │   └── 2/index.html
 * └── _nami/
 *     ├── cache-manifest.json   # 缓存清单
 *     └── revalidation.json     # ISR 重验证配置
 * ```
 *
 * @param options - SSG 构建选项
 * @returns Webpack Configuration
 */
export function createSSGConfig(options: SSGConfigOptions): Configuration {
  const { config, projectRoot } = options;

  // SSG 复用 Server 配置，因为都需要在 Node.js 中执行 renderToString
  const serverConfig = createServerConfig({
    config,
    projectRoot,
    isDev: false,
  });

  return {
    ...serverConfig,
    name: 'ssg',
  };
}
