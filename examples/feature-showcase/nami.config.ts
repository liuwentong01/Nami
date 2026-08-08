import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@nami/core';
import type { NamiPlugin } from '@nami/shared';
import { createRuntimeConfig } from './src/runtime-config';
import { createServerPlugins } from './src/plugins/showcase-plugins';

/**
 * CLI、Webpack 和服务端运行时使用的完整配置。
 *
 * 客户端不会直接复用这个实例，而是重新创建一组 client-safe 插件，
 * 避免把服务端插件状态或未解析的字符串配置带进浏览器。
 */
const staticOutputCompatibilityPlugin: NamiPlugin = {
  name: 'showcase:ssg-output-compatibility',
  enforce: 'post',
  setup(api) {
    api.onBuildEnd(() => {
      const staticRoot = path.resolve(process.cwd(), 'dist/static');
      if (!fs.existsSync(staticRoot)) return;

      const copyIndexAsFlatHTML = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const absolutePath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            copyIndexAsFlatHTML(absolutePath);
          }
        }

        if (directory === staticRoot) return;
        const indexPath = path.join(directory, 'index.html');
        if (!fs.existsSync(indexPath)) return;

        const relativeDirectory = path.relative(staticRoot, directory);
        fs.copyFileSync(indexPath, path.join(staticRoot, `${relativeDirectory}.html`));
      };

      copyIndexAsFlatHTML(staticRoot);
      api.getLogger().info('[showcase] 已生成 SSG 运行时兼容路径');
    });
  },
};

const config = createRuntimeConfig([...createServerPlugins(), staticOutputCompatibilityPlugin]);

const originalServerWebpack = config.webpack.server;
config.webpack = {
  ...config.webpack,
  server(webpackConfig) {
    const enhancedConfig = originalServerWebpack
      ? originalServerWebpack(webpackConfig)
      : webpackConfig;
    const existingExternals = enhancedConfig.externals
      ? Array.isArray(enhancedConfig.externals)
        ? enhancedConfig.externals
        : [enhancedConfig.externals]
      : [];

    // 页面为了同构读取数据会引用 @nami/client。当前 server webpack 配置没有
    // 继承 client 配置生成的两个虚拟模块 alias，这里在示例层补齐，使服务端
    // Bundle 能解析 client 包内部的精简 core shim 与静态路由模块映射。
    return {
      ...enhancedConfig,
      // StreamingSSRRenderer 在框架运行时调用宿主 react-dom/server。如果业务
      // server bundle 再内联一份 React，Hook dispatcher 会来自不同实例。
      // 显式 externalize React 家族，确保普通 SSR 与 Streaming 共用宿主实例。
      externals: [
        {
          react: 'commonjs react',
          'react/jsx-runtime': 'commonjs react/jsx-runtime',
          'react/jsx-dev-runtime': 'commonjs react/jsx-dev-runtime',
          'react-dom': 'commonjs react-dom',
          'react-dom/server': 'commonjs react-dom/server',
        },
        ...existingExternals,
      ],
      resolve: {
        ...enhancedConfig.resolve,
        alias: {
          ...(enhancedConfig.resolve?.alias ?? {}),
          '@nami/core-client-shim': path.resolve(
            process.cwd(),
            '.nami/generated-core-client-shim.ts',
          ),
          '@nami/generated-route-modules': path.resolve(
            process.cwd(),
            '.nami/generated-route-modules.ts',
          ),
        },
      },
    };
  },
};

export default defineConfig(config);
