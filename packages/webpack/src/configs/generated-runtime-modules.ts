/**
 * @nami/webpack - 构建期生成的客户端运行时桥接模块
 *
 * `@nami/client` 的公开入口同时导出路由、插件和数据能力，因此无论浏览器
 * Bundle 还是服务端页面 Bundle，只要从该入口导入一个 Hook，Webpack 都必须
 * 能解析两个虚拟模块。两端的实现不能完全相同：
 *
 * - client 使用静态路由 loader 和精简 core 入口；
 * - server 只需要可解析的空路由表，并把 core 能力重新导向宿主 `@nami/core`，
 *   避免打入第二份 NamiDataContext。
 */

import fs from 'fs';
import path from 'path';
import type { NamiConfig } from '@nami/shared';

export interface GeneratedRuntimeAliases {
  coreClientShim: string;
  routeModules: string;
}

function toPosixImportPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function createChunkName(componentPath: string): string {
  return `route-${componentPath
    .replace(/^\.\//, '')
    .replace(/[^a-zA-Z0-9/_-]/g, '-')
    .replace(/\//g, '-')}`;
}

function ensureGeneratedDir(projectRoot: string): string {
  const generatedDir = path.resolve(projectRoot, '.nami');
  fs.mkdirSync(generatedDir, { recursive: true });
  return generatedDir;
}

function writeGeneratedFile(filePath: string, lines: string[]): string {
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

function ensureGeneratedRouteModules(projectRoot: string, config: NamiConfig): string {
  const generatedDir = ensureGeneratedDir(projectRoot);
  const generatedFile = path.join(generatedDir, 'generated-route-modules.ts');

  const uniqueComponentPaths = Array.from(
    new Set(
      config.routes
        .map((route) => route.component)
        .filter(
          (componentPath: unknown): componentPath is string =>
            typeof componentPath === 'string' && componentPath.length > 0,
        ),
    ),
  );

  return writeGeneratedFile(generatedFile, [
    '/** 构建阶段自动生成的浏览器路由模块映射。 */',
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
      const normalizedImportPath = toPosixImportPath(
        relativeImportPath.startsWith('.') ? relativeImportPath : `./${relativeImportPath}`,
      );
      const chunkName = createChunkName(componentPath);

      return `  ${JSON.stringify(componentPath)}: () => import(/* webpackChunkName: ${JSON.stringify(chunkName)} */ ${JSON.stringify(normalizedImportPath)}),`;
    }),
    '} as Record<string, () => Promise<unknown>>;',
    '',
    'export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [',
    ...config.routes.map(
      (route) =>
        `  { path: ${JSON.stringify(route.path)}, component: ${JSON.stringify(route.component)}, exact: ${route.exact === false ? 'false' : 'true'} },`,
    ),
    '];',
    '',
  ]);
}

function ensureGeneratedCoreClientShim(projectRoot: string): string {
  const generatedDir = ensureGeneratedDir(projectRoot);
  const generatedFile = path.join(generatedDir, 'generated-core-client-shim.ts');
  const corePackageRoot = path.dirname(require.resolve('@nami/core/package.json'));
  const entries = {
    pluginManager: path.join(corePackageRoot, 'dist/plugin/plugin-manager'),
    dataContext: path.join(corePackageRoot, 'dist/data/data-context'),
    pathMatcher: path.join(corePackageRoot, 'dist/router/path-matcher'),
  };

  const toRelativeImport = (entryPath: string): string => {
    const relativePath = path.relative(generatedDir, entryPath);
    return toPosixImportPath(relativePath.startsWith('.') ? relativePath : `./${relativePath}`);
  };

  return writeGeneratedFile(generatedFile, [
    '/** client bundle 专用的 @nami/core 精简入口。 */',
    `export { PluginManager } from ${JSON.stringify(toRelativeImport(entries.pluginManager))};`,
    `export { NamiDataProvider } from ${JSON.stringify(toRelativeImport(entries.dataContext))};`,
    `export { matchPath } from ${JSON.stringify(toRelativeImport(entries.pathMatcher))};`,
    '',
  ]);
}

/** 生成浏览器 Bundle 使用的真实路由表与精简 core shim。 */
export function ensureClientRuntimeAliases(
  projectRoot: string,
  config: NamiConfig,
): GeneratedRuntimeAliases {
  return {
    coreClientShim: ensureGeneratedCoreClientShim(projectRoot),
    routeModules: ensureGeneratedRouteModules(projectRoot, config),
  };
}

/**
 * 生成服务端页面 Bundle 使用的安全 shim。
 *
 * 服务端不会运行 BrowserRouter，因此路由模块只需满足静态解析；core shim 则
 * 重新导出包名，让 server externals 保证 Provider 与 Hook 共用宿主单例。
 */
export function ensureServerRuntimeAliases(projectRoot: string): GeneratedRuntimeAliases {
  const generatedDir = ensureGeneratedDir(projectRoot);
  const coreClientShim = writeGeneratedFile(
    path.join(generatedDir, 'generated-core-server-shim.ts'),
    [
      '/** server bundle 专用 shim：复用宿主 @nami/core 单例。 */',
      "export { PluginManager, NamiDataProvider, matchPath } from '@nami/core';",
      '',
    ],
  );
  const routeModules = writeGeneratedFile(
    path.join(generatedDir, 'generated-route-modules.server.ts'),
    [
      '/** server bundle 只需解析 @nami/client，不能启动 BrowserRouter 路由加载。 */',
      'export interface GeneratedRouteDefinition {',
      '  path: string;',
      '  component: string;',
      '  exact?: boolean;',
      '}',
      'export const generatedComponentLoaders = {} as Record<string, () => Promise<unknown>>;',
      'export const generatedRouteDefinitions: GeneratedRouteDefinition[] = [];',
      '',
    ],
  );

  return { coreClientShim, routeModules };
}
