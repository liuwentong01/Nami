import fs from 'fs';
import path from 'path';
import type { NamiConfig } from '@nami/shared';
import { ASSET_MANIFEST_FILENAME } from '@nami/shared';
import { ModuleLoader } from '@nami/core';
import type { AppElementFactory, ModuleLoaderLike, AssetManifest } from '@nami/core';

interface RuntimeModuleShape {
  createAppElement?: unknown;
}

export interface ResolvedServerRuntime {
  appElementFactory?: AppElementFactory;
  moduleLoader?: ModuleLoaderLike;
  assetManifest?: AssetManifest;
  serverBundlePath?: string;
}

interface ResolveServerRuntimeOptions {
  projectRoot: string;
  config: NamiConfig;
  fresh?: boolean;
  /** 存在需要 Server Bundle 的路由时，在生产启动阶段对入口协议做强校验。 */
  requireServerEntry?: boolean;
}

/**
 * 解析当前项目的服务端运行时能力
 *
 * P0 阶段最关键的问题之一，是 CLI 默认启动路径无法自动把
 * `dist/server/entry-server.js` 与 renderer 所需的运行时对象连接起来。
 *
 * 这里集中做四件事：
 * 1. 读取 `entry-server.js` 导出的唯一渲染入口 `createAppElement`
 * 2. 构造 `ModuleLoader`，用于解析页面级数据预取函数
 * 3. 读取客户端 `asset-manifest.json`，让服务端 HTML 注入真实资源路径
 * 4. 在开发模式下支持 `fresh` 读取，避免命中旧的 require 缓存
 */
export function resolveServerRuntime(options: ResolveServerRuntimeOptions): ResolvedServerRuntime {
  const { projectRoot, config, fresh = false, requireServerEntry = false } = options;
  const serverOutputDir = path.resolve(projectRoot, config.outDir, 'server');
  const serverBundlePath = path.resolve(serverOutputDir, 'entry-server.js');
  const assetManifest = readAssetManifest(projectRoot, config);

  if (!fs.existsSync(serverBundlePath)) {
    if (requireServerEntry) {
      throw new Error(
        `缺少服务端入口产物: ${serverBundlePath}；请先构建并确保 entry-server 导出 createAppElement(context)`,
      );
    }
    return { assetManifest };
  }

  if (fresh) {
    delete require.cache[require.resolve(serverBundlePath)];
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const runtimeModule = require(serverBundlePath) as RuntimeModuleShape;
  const appElementFactory = resolveAppElementFactory(runtimeModule);
  if (requireServerEntry && !appElementFactory) {
    throw new Error(
      '服务端入口必须导出 createAppElement(context)，旧的 renderToHTML 协议已不再支持',
    );
  }
  const moduleLoader = new ModuleLoader({
    serverOutputDir,
    moduleManifest: readModuleManifest(projectRoot, config),
  });

  return {
    appElementFactory,
    moduleLoader,
    assetManifest,
    serverBundlePath,
  };
}

function resolveAppElementFactory(
  runtimeModule: RuntimeModuleShape,
): AppElementFactory | undefined {
  if (typeof runtimeModule.createAppElement === 'function') {
    return runtimeModule.createAppElement as AppElementFactory;
  }

  return undefined;
}

function readModuleManifest(projectRoot: string, config: NamiConfig): Record<string, string> {
  const manifestPath = path.resolve(projectRoot, config.outDir, 'nami-manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return {};
  }

  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(manifestContent) as {
      moduleManifest?: Record<string, string>;
    };
    return parsed.moduleManifest ?? {};
  } catch {
    return {};
  }
}

function readAssetManifest(projectRoot: string, config: NamiConfig): AssetManifest | undefined {
  const manifestPath = path.resolve(projectRoot, config.outDir, 'client', ASSET_MANIFEST_FILENAME);

  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(manifestContent) as AssetManifest;
  } catch {
    return undefined;
  }
}
