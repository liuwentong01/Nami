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
  deepMerge,
  DEFAULT_SERVER_CONFIG,
  DEFAULT_ISR_CONFIG,
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_FALLBACK_CONFIG,
  DEFAULT_ASSETS_CONFIG,
  DEFAULT_SRC_DIR,
  DEFAULT_OUT_DIR,
  DEFAULT_RENDER_MODE,
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
      // 外部化 node_modules（配置文件可能引用框架包）
      external: ['@nami/*'],
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
  const defaults: Omit<NamiConfig, 'appName'> = {
    srcDir: DEFAULT_SRC_DIR,
    outDir: DEFAULT_OUT_DIR,
    defaultRenderMode: DEFAULT_RENDER_MODE,
    routes: [],
    server: DEFAULT_SERVER_CONFIG,
    webpack: {},
    isr: DEFAULT_ISR_CONFIG,
    assets: DEFAULT_ASSETS_CONFIG,
    monitor: DEFAULT_MONITOR_CONFIG,
    fallback: DEFAULT_FALLBACK_CONFIG,
    plugins: [],
  };

  return deepMerge(defaults as unknown as NamiConfig, userConfig as unknown as Partial<NamiConfig>);
}
