/**
 * @nami/webpack - 客户端构建配置
 *
 * 生成浏览器端运行的 JavaScript Bundle，包含：
 * - React 应用代码
 * - 路由懒加载 Chunk
 * - CSS 提取
 * - 代码分割（vendor/runtime/pages）
 * - 资源指纹（Content Hash）
 */

import type { Configuration } from 'webpack';
import type { NamiConfig } from '@nami/shared';
import path from 'path';
import fs from 'fs';
import webpack from 'webpack';
import { createBaseConfig } from './base.config';
import { createStyleRules, createCssExtractPlugin } from '../rules/styles';
import { createSplitChunksConfig } from '../optimization/split-chunks';
import { createTerserPlugin } from '../optimization/terser';

/**
 * 客户端构建配置选项
 */
export interface ClientConfigOptions {
  /** Nami 框架配置 */
  config: NamiConfig;
  /** 项目根目录 */
  projectRoot: string;
  /** 是否为开发模式 */
  isDev?: boolean;
}

function toPosixImportPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function createChunkName(componentPath: string): string {
  return `route-${componentPath.replace(/^\.\//, '').replace(/[^a-zA-Z0-9/_-]/g, '-').replace(/\//g, '-')}`;
}

function ensureGeneratedRouteModules(projectRoot: string, config: NamiConfig): string {
  const generatedDir = path.resolve(projectRoot, '.nami');
  const generatedFile = path.join(generatedDir, 'generated-route-modules.ts');

  const uniqueComponentPaths = Array.from(
    new Set(
      config.routes
        .map((route) => route.component)
        .filter((componentPath: unknown): componentPath is string => (
          typeof componentPath === 'string' && componentPath.length > 0
        )),
    ),
  );

  const fileContent = [
    '/**',
    ' * 构建阶段自动生成的路由模块映射。',
    ' *',
    ' * 这里使用静态 import 工厂而不是表达式 import，',
    ' * 避免 webpack 对 `import(`${componentPath}`)` 发出 Critical dependency 警告。',
    ' */',
    'export interface GeneratedRouteDefinition {',
    '  path: string;',
    '  component: string;',
    '  exact?: boolean;',
    '}',
    '',
    'export const generatedComponentLoaders = {',
    ...uniqueComponentPaths.map((componentPath) => {
      const sourceFilePath = path.resolve(
        projectRoot,
        config.srcDir,
        componentPath.replace(/^\.\//, ''),
      );
      const relativeImportPath = path.relative(generatedDir, sourceFilePath);
      const normalizedImportPath = toPosixImportPath(relativeImportPath.startsWith('.')
        ? relativeImportPath
        : `./${relativeImportPath}`);
      const chunkName = createChunkName(componentPath);

      return `  ${JSON.stringify(componentPath)}: () => import(/* webpackChunkName: ${JSON.stringify(chunkName)} */ ${JSON.stringify(normalizedImportPath)}),`;
    }),
    '} as Record<string, () => Promise<unknown>>;',
    '',
    'export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [',
    ...config.routes.map((route) => (
      `  { path: ${JSON.stringify(route.path)}, component: ${JSON.stringify(route.component)}, exact: ${route.exact === false ? 'false' : 'true'} },`
    )),
    '];',
    '',
  ].join('\n');

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(generatedFile, fileContent, 'utf-8');

  return generatedFile;
}

function ensureGeneratedCoreClientShim(projectRoot: string): string {
  const generatedDir = path.resolve(projectRoot, '.nami');
  const generatedFile = path.join(generatedDir, 'generated-core-client-shim.ts');
  const corePackageRoot = path.dirname(require.resolve('@nami/core/package.json'));
  const pluginManagerEntry = path.join(corePackageRoot, 'dist/plugin/plugin-manager');
  const dataContextEntry = path.join(corePackageRoot, 'dist/data/data-context');
  const pathMatcherEntry = path.join(corePackageRoot, 'dist/router/path-matcher');
  const relativeImportPath = path.relative(generatedDir, pluginManagerEntry);
  const relativeDataContextPath = path.relative(generatedDir, dataContextEntry);
  const relativePathMatcherPath = path.relative(generatedDir, pathMatcherEntry);
  const normalizedImportPath = toPosixImportPath(relativeImportPath.startsWith('.')
    ? relativeImportPath
    : `./${relativeImportPath}`);
  const normalizedDataContextPath = toPosixImportPath(relativeDataContextPath.startsWith('.')
    ? relativeDataContextPath
    : `./${relativeDataContextPath}`);
  const normalizedPathMatcherPath = toPosixImportPath(relativePathMatcherPath.startsWith('.')
    ? relativePathMatcherPath
    : `./${relativePathMatcherPath}`);

  const fileContent = [
    '/**',
    ' * client bundle 专用的 @nami/core 精简入口。',
    ' *',
    ' * 浏览器端当前只需要 PluginManager，直接引用完整 core 入口会把',
    ' * config-loader / module-loader / plugin-loader 这类 Node 专属模块一并卷入，',
    ' * 从而触发表达式 require 的 webpack 警告。',
    ' */',
    `export { PluginManager } from ${JSON.stringify(normalizedImportPath)};`,
    `export { NamiDataProvider } from ${JSON.stringify(normalizedDataContextPath)};`,
    `export { matchPath } from ${JSON.stringify(normalizedPathMatcherPath)};`,
    '',
  ].join('\n');

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(generatedFile, fileContent, 'utf-8');

  return generatedFile;
}

/**
 * 创建客户端 Webpack 配置
 *
 * 客户端 Bundle 的产物结构：
 * ```
 * dist/client/
 * ├── static/
 * │   ├── js/
 * │   │   ├── main.[hash].js        # 应用入口
 * │   │   ├── vendor.[hash].js      # 第三方库
 * │   │   ├── runtime.[hash].js     # Webpack 运行时
 * │   │   └── pages/
 * │   │       └── [page].[hash].js  # 页面级 Chunk
 * │   └── css/
 * │       └── [name].[hash].css     # 提取的 CSS
 * └── asset-manifest.json           # 资源清单
 * ```
 *
 * @param options - 客户端构建选项
 * @returns Webpack Configuration
 */
export function createClientConfig(options: ClientConfigOptions): Configuration {
  const { config, projectRoot, isDev = false } = options;

  // 获取基础配置
  const baseConfig = createBaseConfig({
    config,
    projectRoot,
    isServer: false,
    isDev,
  });

  const outputDir = path.resolve(projectRoot, config.outDir, 'client');
  const generatedRouteModulesPath = ensureGeneratedRouteModules(projectRoot, config);
  const generatedCoreClientShimPath = ensureGeneratedCoreClientShim(projectRoot);

  // 客户端专属插件
  const plugins: webpack.WebpackPluginInstance[] = [
    // 定义环境变量
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
      'process.env.NAMI_RENDER_MODE': JSON.stringify('client'),
      // 注入用户自定义环境变量（仅 NAMI_PUBLIC_ 前缀）
      ...Object.entries(config.env || {}).reduce(
        (acc, [key, value]) => {
          if (key.startsWith('NAMI_PUBLIC_')) {
            acc[`process.env.${key}`] = JSON.stringify(value);
          }
          return acc;
        },
        {} as Record<string, string>,
      ),
    }),
  ];

  // 生产环境：提取 CSS 到独立文件
  if (!isDev) {
    plugins.push(createCssExtractPlugin());
  }

  // 开发环境：HMR 插件
  if (isDev) {
    plugins.push(new webpack.HotModuleReplacementPlugin());
  }

  return {
    ...baseConfig,
    name: 'client',
    target: 'web',

    // 入口
    entry: {
      main: isDev
        ? [
            // HMR 客户端入口
            'webpack-hot-middleware/client?reload=true&noInfo=true',
            path.resolve(projectRoot, config.srcDir, 'entry-client'),
          ]
        : [path.resolve(projectRoot, config.srcDir, 'entry-client')],
    },

    // 输出
    output: {
      path: outputDir,
      // 开发模式不使用 hash 以加速构建
      filename: isDev ? 'static/js/[name].js' : 'static/js/[name].[contenthash:8].js',
      chunkFilename: isDev
        ? 'static/js/[name].chunk.js'
        : 'static/js/[name].[contenthash:8].chunk.js',
      publicPath: config.assets.publicPath,
      // 清理旧构建产物
      clean: !isDev,
    },

    resolve: {
      ...(baseConfig.resolve || {}),
      alias: {
        ...((baseConfig.resolve && baseConfig.resolve.alias) || {}),
        '@nami/core-client-shim': generatedCoreClientShimPath,
        '@nami/generated-route-modules': generatedRouteModulesPath,
      },
    },

    // 模块规则：追加样式规则
    module: {
      ...baseConfig.module,
      rules: [...(baseConfig.module?.rules || []), ...createStyleRules({ isDev, isServer: false })],
    },

    // 优化
    optimization: isDev
      ? {
          // 开发模式：最小化优化以加速构建
          minimize: false,
          splitChunks: false,
        }
      : {
          minimize: true,
          minimizer: [createTerserPlugin()],
          // 代码分割策略
          splitChunks: createSplitChunksConfig(),
          // 提取 Webpack 运行时为独立 Chunk
          runtimeChunk: {
            name: 'runtime',
          },
          // 模块 ID 使用确定性哈希（利于长期缓存）
          moduleIds: 'deterministic',
        },

    // Source Map
    devtool: isDev ? 'eval-cheap-module-source-map' : 'source-map',

    plugins: [...(baseConfig.plugins || []), ...plugins],
  };
}
