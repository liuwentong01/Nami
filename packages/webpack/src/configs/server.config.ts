/**
 * @nami/webpack - 服务端构建配置
 *
 * 生成 Node.js 端运行的 SSR Bundle，特点：
 * - target: node（使用 Node.js 内置模块）
 * - externals: node_modules 不打包（运行时 require）
 * - 不处理 CSS（服务端不需要样式）
 * - 不做代码分割（单一 Bundle 入口）
 * - 输出 CommonJS 模块格式
 */

import type { Configuration } from 'webpack';
import { NEEDS_SERVER_BUNDLE, type NamiConfig } from '@nami/shared';
import path from 'path';
import fs from 'fs';
import webpack from 'webpack';
import nodeExternals from 'webpack-node-externals';
import { createBaseConfig } from './base.config';
import { ensureServerRuntimeAliases } from './generated-runtime-modules';
import { createStyleRules } from '../rules/styles';

/**
 * 服务端构建配置选项
 */
export interface ServerConfigOptions {
  /** Nami 框架配置 */
  config: NamiConfig;
  /** 项目根目录 */
  projectRoot: string;
  /** 是否为开发模式 */
  isDev?: boolean;
}

/**
 * 创建服务端 Webpack 配置
 *
 * 服务端 Bundle 的产物结构：
 * ```
 * dist/server/
 * ├── entry-server.js        # SSR 入口
 * ├── pages/                 # 页面组件（服务端版本）
 * └── data-fetchers/         # 数据预取函数
 * ```
 *
 * @param options - 服务端构建选项
 * @returns Webpack Configuration
 */
export function createServerConfig(options: ServerConfigOptions): Configuration {
  const { config, projectRoot, isDev = false } = options;

  const baseConfig = createBaseConfig({
    config,
    projectRoot,
    isServer: true,
    isDev,
  });
  const generatedAliases = ensureServerRuntimeAliases(projectRoot);

  const outputDir = path.resolve(projectRoot, config.outDir, 'server');
  const entryServerBasePath = path.resolve(projectRoot, config.srcDir, 'entry-server');
  const entryServerPath = ['.tsx', '.ts', '.jsx', '.js']
    .map((ext) => `${entryServerBasePath}${ext}`)
    .find((candidate) => fs.existsSync(candidate));
  const needsServerEntry = config.routes.some((route) =>
    NEEDS_SERVER_BUNDLE.includes(route.renderMode),
  );

  if (needsServerEntry && !entryServerPath) {
    throw new Error(
      `检测到 SSR/SSG/ISR 路由，但缺少 ${config.srcDir}/entry-server；请导出 createAppElement(context)`,
    );
  }
  const routeEntries = Object.fromEntries(
    Array.from(
      new Set(
        config.routes
          .map((route) => route.component)
          .filter(
            (componentPath: unknown): componentPath is string =>
              typeof componentPath === 'string' && componentPath.length > 0,
          ),
      ),
    ).map((componentPath) => {
      const normalizedEntryName = componentPath.replace(/^\.\//, '');
      return [
        normalizedEntryName,
        path.resolve(projectRoot, config.srcDir, componentPath.replace(/^\.\//, '')),
      ];
    }),
  );

  return {
    ...baseConfig,
    name: 'server',
    target: 'node',

    // 入口
    entry: {
      // `entry-server` 是应用级服务端入口，唯一公开渲染契约为
      // createAppElement(context)；纯 CSR 项目无需提供该文件。
      ...(entryServerPath ? { 'entry-server': entryServerPath } : {}),
      ...routeEntries,
    },

    // 输出
    output: {
      path: outputDir,
      filename: '[name].js',
      // 服务端使用 CommonJS 格式
      libraryTarget: 'commonjs2',
      publicPath: config.assets.publicPath,
      clean: !isDev,
    },

    // 业务页面可以从公开 @nami/client 入口导入同构 Hook。该入口内部引用
    // 两个 browser 构建虚拟模块，因此 server bundle 也必须提供可解析实现：
    // core shim 复用宿主单例，route modules 则为空表（服务端不运行 BrowserRouter）。
    resolve: {
      ...(baseConfig.resolve || {}),
      alias: {
        ...((baseConfig.resolve && baseConfig.resolve.alias) || {}),
        '@nami/core-client-shim': generatedAliases.coreClientShim,
        '@nami/generated-route-modules': generatedAliases.routeModules,
      },
    },

    // 模块规则：服务端忽略 CSS
    module: {
      ...baseConfig.module,
      rules: [...(baseConfig.module?.rules || []), ...createStyleRules({ isServer: true })],
    },

    // 外部化 node_modules
    // 服务端不打包 node_modules，运行时直接 require
    // 这大幅减少 Bundle 体积并加速构建
    externals: [
      // React 树由宿主 Renderer 执行，页面 bundle 不能再内联另一份 React。
      /^react(?:\/.*)?$/,
      /^react-dom(?:\/.*)?$/,
      // BaseRenderer 与业务页面必须复用同一份 @nami/core，尤其是
      // NamiDataContext；若把 core 再打入 server bundle，Provider 与 Hook
      // 会来自两个模块实例，useServerData 在 SSR 阶段将读不到预取数据。
      /^@nami\/core(?:\/.*)?$/,
      nodeExternals({
        // 允许打包的模块（通常是需要 webpack 转换的模块）
        allowlist: [
          // CSS 文件需要被 loader 处理
          /\.css$/,
          // 其余 Nami 包仍参与 bundle；@nami/core 已由前一条规则强制 externalize。
          /^@nami\//,
        ],
      }),
    ],

    // 优化
    optimization: {
      // 服务端不需要代码压缩
      minimize: false,
      // 服务端不需要代码分割
      splitChunks: false,
    },

    // 不需要 polyfill Node.js 内置模块
    node: {
      __dirname: false,
      __filename: false,
    },

    // Source Map：服务端始终生成（便于错误堆栈定位）
    devtool: 'source-map',

    plugins: [
      ...(baseConfig.plugins || []),
      // 定义环境变量
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
        'process.env.NAMI_RENDER_MODE': JSON.stringify('server'),
      }),
      // 限制 Chunk 数量为 1（服务端不需要多 Chunk）
      new webpack.optimize.LimitChunkCountPlugin({
        maxChunks: 1,
      }),
    ],
  };
}
