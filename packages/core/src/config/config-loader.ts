/**
 * @nami/core - 配置加载器
 *
 * ConfigLoader 负责从项目根目录加载 nami.config.ts（或 .js）配置文件，
 * 并与默认配置进行深度合并，生成最终的完整配置对象。
 *
 * 配置文件查找顺序：
 * 1. 用户显式指定的路径
 * 2. 项目根目录下的 nami.config.ts
 * 3. 项目根目录下的 nami.config.js
 *
 * 配置合并策略：
 * - 使用 @nami/shared 的 deepMerge 进行递归合并
 * - 纯对象递归合并，数组和基础类型以用户配置覆盖默认值
 * - undefined 值不会覆盖默认值
 */

import * as path from 'path';
import * as fs from 'fs';

import type { NamiConfig, UserNamiConfig } from '@nami/shared';
import {
  deepMerge,
  createLogger,
  ConfigError,
} from '@nami/shared';

import { getDefaultConfig } from './defaults';
import { ConfigValidator } from './config-validator';

/** 配置加载器内部日志 */
const logger = createLogger('@nami/core:config');

/** 支持的配置文件名列表（按优先级排列） */
const CONFIG_FILE_NAMES = [
  'nami.config.ts',
  'nami.config.js',
] as const;

/**
 * 配置加载器
 *
 * 负责查找、加载、合并和校验框架配置文件。
 *
 * @example
 * ```typescript
 * const loader = new ConfigLoader();
 *
 * // 从项目根目录加载配置
 * const config = await loader.load();
 *
 * // 从指定路径加载配置
 * const config = await loader.load('/path/to/nami.config.ts');
 * ```
 */
export class ConfigLoader {
  /** 配置校验器实例 */
  private readonly validator: ConfigValidator;

  constructor() {
    this.validator = new ConfigValidator();
  }

  /**
   * 加载并合并配置
   *
   * 加载流程：
   * 1. 解析配置文件路径（用户指定或自动查找）
   * 2. 加载配置文件模块
   * 3. 获取默认配置
   * 4. 使用 deepMerge 合并用户配置到默认配置
   * 5. 校验合并后的配置
   *
   * @param configPath - 可选的配置文件路径。不传则自动查找
   * @param cwd - 工作目录，用于自动查找配置文件，默认 process.cwd()
   * @returns 合并后的完整 NamiConfig
   * @throws ConfigError 配置文件不存在或校验失败时抛出
   */
  async load(configPath?: string, cwd?: string): Promise<NamiConfig> {
    const workDir = cwd ?? process.cwd();

    // 解析配置文件路径
    const resolvedPath = configPath
      ? path.resolve(workDir, configPath)
      : this.resolveConfigPath(workDir);

    if (!resolvedPath) {
      throw new ConfigError(
        '未找到配置文件。请在项目根目录创建 nami.config.ts 或 nami.config.js',
        { cwd: workDir, searchedFiles: [...CONFIG_FILE_NAMES] },
      );
    }

    logger.info('加载配置文件', { path: resolvedPath });

    // 加载用户配置模块
    const userConfig = await this.loadModule(resolvedPath);

    // 获取默认配置
    const defaultConfig = getDefaultConfig();

    // 深度合并：用户配置覆盖默认配置
    const mergedConfig = deepMerge(
      defaultConfig as unknown as Record<string, unknown>,
      userConfig as unknown as Record<string, unknown>,
    ) as unknown as NamiConfig;

    // 校验合并后的配置
    const validation = this.validator.validate(mergedConfig);
    if (!validation.valid) {
      throw new ConfigError(
        `配置校验失败:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
        { errors: validation.errors, configPath: resolvedPath },
      );
    }

    logger.info('配置加载完成', {
      appName: mergedConfig.appName,
      renderMode: mergedConfig.defaultRenderMode,
      routeCount: mergedConfig.routes.length,
    });

    return mergedConfig;
  }

  /**
   * 在指定目录下查找配置文件
   *
   * 按照 CONFIG_FILE_NAMES 定义的优先级依次查找：
   * 1. nami.config.ts（推荐）
   * 2. nami.config.js（兼容纯 JS 项目）
   *
   * @param cwd - 项目根目录路径
   * @returns 找到的配置文件绝对路径，未找到则返回 null
   */
  resolveConfigPath(cwd: string): string | null {
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = path.resolve(cwd, fileName);
      if (fs.existsSync(filePath)) {
        logger.debug('找到配置文件', { path: filePath });
        return filePath;
      }
    }

    logger.debug('未找到配置文件', {
      cwd,
      searchedFiles: [...CONFIG_FILE_NAMES],
    });
    return null;
  }

  /**
   * 加载配置文件模块
   *
   * 支持 CommonJS（require）和 ES Module（default export）两种导出方式。
   * TypeScript 文件需要项目已配置 ts-node 或 tsx 等运行时。
   *
   * @param filePath - 配置文件绝对路径
   * @returns 用户配置对象
   * @throws ConfigError 文件加载失败时抛出
   */
  private async loadModule(filePath: string): Promise<UserNamiConfig> {
    try {
      // 清除 require 缓存，确保每次加载最新内容（开发模式热重载场景）
      delete require.cache[filePath];

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require(filePath) as Record<string, unknown>;

      // 兼容 ES Module 的 default export 和 CommonJS 的 module.exports
      const config = (module.default ?? module) as UserNamiConfig;

      // 基础类型检查：配置必须是对象
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('配置文件必须导出一个对象');
      }

      return config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(
        `加载配置文件失败: ${message}`,
        { filePath, originalError: message },
      );
    }
  }
}
