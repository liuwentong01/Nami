/**
 * @nami/cli - 配置文件加载器
 *
 * 负责加载和编译 nami.config.ts 配置文件。
 * 使用 esbuild 将 TypeScript 配置文件编译为 JavaScript 后执行。
 */

import path from 'path';
import fs from 'fs';
import { build } from 'esbuild';
import type { NamiConfig, UserNamiConfig } from '@nami/shared';
import {
  resolveNamiConfig,
  RenderMode,
} from '@nami/shared';

/** 支持的配置文件名 */
const CONFIG_FILE_NAMES = [
  'nami.config.ts',
  'nami.config.js',
  'nami.config.mjs',
];

/**
 * 查找配置文件路径
 *
 * @param cwd - 当前工作目录
 * @returns 配置文件绝对路径，未找到返回 null
 */
export function resolveConfigPath(cwd: string): string | null {
  for (const filename of CONFIG_FILE_NAMES) {
    const filePath = path.resolve(cwd, filename);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * 加载 nami.config.ts 配置文件
 *
 * 流程：
 * 1. 查找配置文件
 * 2. 使用 esbuild 编译 TypeScript -> JavaScript
 * 3. 执行编译后的代码获取配置对象
 * 4. 合并默认配置
 * 5. 返回完整配置
 *
 * @param cwd - 当前工作目录
 * @returns 完整的 NamiConfig 配置对象
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<NamiConfig> {
  const configPath = resolveConfigPath(cwd);

  if (!configPath) {
    throw new Error(
      `未找到 nami 配置文件。请在项目根目录创建 nami.config.ts 文件。\n` +
        `支持的文件名: ${CONFIG_FILE_NAMES.join(', ')}`,
    );
  }

  // 使用 esbuild 编译 TypeScript 配置文件
  const tempOutputPath = path.resolve(cwd, 'node_modules/.cache/nami/config.compiled.js');
  const tempDir = path.dirname(tempOutputPath);

  // 确保临时目录存在
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await build({
      entryPoints: [configPath],
      outfile: tempOutputPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      // 框架包与 React 由宿主项目解析。配置可以导入本地同构 wrapApp 插件；
      // 若把该插件使用的 JSX runtime 打进临时 config bundle，服务端 Renderer
      // 可能同时看到两份 React，带 Hook 的 App Shell 会触发 invalid hook call。
      external: [
        '@nami/*',
        'react',
        'react/*',
        'react-dom',
        'react-dom/*',
      ],
      logLevel: 'silent',
    });

    // 加载编译后的配置
    // 清除 require 缓存以支持配置热更新
    delete require.cache[tempOutputPath];
    const configModule = require(tempOutputPath);
    const userConfig: UserNamiConfig = configModule.default || configModule;

    // 合并默认配置
    const fullConfig = mergeWithDefaults(userConfig);

    return fullConfig;
  } catch (error) {
    const err = error as Error;
    throw new Error(`配置文件编译失败: ${err.message}`);
  } finally {
    // 清理临时文件
    try {
      fs.unlinkSync(tempOutputPath);
    } catch {
      // 忽略清理错误
    }
  }
}

/**
 * 将用户配置与默认配置合并
 */
function mergeWithDefaults(userConfig: UserNamiConfig): NamiConfig {
  const legacyISR = userConfig.isr as (Partial<NamiConfig['isr']> & {
    cacheStrategy?: NamiConfig['isr']['cacheAdapter'];
  }) | undefined;
  const { cacheStrategy, ...currentISR } = legacyISR ?? {};
  const normalizedConfig: UserNamiConfig = {
    ...userConfig,
    isr: {
      ...currentISR,
      ...(currentISR.cacheAdapter === undefined && cacheStrategy
        ? { cacheAdapter: cacheStrategy }
        : {}),
    },
  };
  const merged = resolveNamiConfig(normalizedConfig);

  // 兼容历史约定：只要默认模式或任一路由使用 ISR，就自动开启 ISR。
  // 否则业务方还需要再额外写一遍 `isr.enabled = true`，容易让示例和旧项目“看起来是 ISR，实际没启用缓存层”。
  const hasISRRoute =
    merged.defaultRenderMode === RenderMode.ISR
    || merged.routes.some((route) => route.renderMode === RenderMode.ISR);

  if (userConfig.isr?.enabled === undefined && hasISRRoute) {
    merged.isr.enabled = true;
  }

  return merged;
}
