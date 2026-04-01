import fs from 'fs';
import path from 'path';
import type { NamiConfig } from '@nami/shared';
import { ModuleLoader } from '@nami/core';
import type { AppElementFactory, HTMLRenderer, ModuleLoaderLike } from '@nami/core';

interface RuntimeModuleShape {
  default?: unknown;
  renderToHTML?: unknown;
  createAppElement?: unknown;
  appElementFactory?: unknown;
}

export interface ResolvedServerRuntime {
  appElementFactory?: AppElementFactory;
  htmlRenderer?: HTMLRenderer;
  moduleLoader?: ModuleLoaderLike;
  serverBundlePath?: string;
}

interface ResolveServerRuntimeOptions {
  projectRoot: string;
  config: NamiConfig;
  fresh?: boolean;
}

/**
 * 解析当前项目的服务端运行时能力
 *
 * P0 阶段最关键的问题之一，是 CLI 默认启动路径无法自动把
 * `dist/server/entry-server.js` 与 renderer 所需的运行时对象连接起来。
 *
 * 这里集中做三件事：
 * 1. 读取 `entry-server.js` 导出的渲染入口（优先 `createAppElement`，兼容 `renderToHTML`）
 * 2. 构造 `ModuleLoader`，用于解析页面级数据预取函数
 * 3. 在开发模式下支持 `fresh` 读取，避免命中旧的 require 缓存
 */
export function resolveServerRuntime(
  options: ResolveServerRuntimeOptions,
): ResolvedServerRuntime {
  const { projectRoot, config, fresh = false } = options;
  const serverBundlePath = path.resolve(projectRoot, config.outDir, 'server', 'entry-server.js');

  if (!fs.existsSync(serverBundlePath)) {
    return {};
  }

  if (fresh) {
    delete require.cache[require.resolve(serverBundlePath)];
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const runtimeModule = require(serverBundlePath) as RuntimeModuleShape;
  const appElementFactory = resolveAppElementFactory(runtimeModule);
  const htmlRenderer = resolveHTMLRenderer(runtimeModule);
  const moduleLoader = new ModuleLoader({
    serverBundlePath,
    moduleManifest: readModuleManifest(projectRoot, config),
  });

  return {
    appElementFactory,
    htmlRenderer,
    moduleLoader,
    serverBundlePath,
  };
}

function resolveAppElementFactory(runtimeModule: RuntimeModuleShape): AppElementFactory | undefined {
  if (typeof runtimeModule.createAppElement === 'function') {
    return runtimeModule.createAppElement as AppElementFactory;
  }

  if (typeof runtimeModule.appElementFactory === 'function') {
    return runtimeModule.appElementFactory as AppElementFactory;
  }

  return undefined;
}

function resolveHTMLRenderer(runtimeModule: RuntimeModuleShape): HTMLRenderer | undefined {
  if (typeof runtimeModule.renderToHTML === 'function') {
    const renderToHTML = runtimeModule.renderToHTML as (
      url: string,
      initialData: Record<string, unknown>,
      context: unknown,
    ) => Promise<unknown> | unknown;

    return async (context, initialData) => {
      const maybeHTML = await renderToHTML(
        context.url,
        initialData,
        context,
      );
      return String(maybeHTML ?? '');
    };
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
