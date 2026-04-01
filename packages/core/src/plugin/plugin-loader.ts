/**
 * @nami/core - 插件加载器
 *
 * PluginLoader 负责将插件标识解析为可用的 NamiPlugin 实例。
 *
 * 支持两种输入形式：
 * 1. NamiPlugin 对象实例 — 直接返回
 * 2. 字符串（npm 包名） — 通过 require() 加载模块并验证
 *
 * 加载流程：
 * 字符串名称 -> require() 加载 -> 处理 default 导出 -> 验证必要字段 -> 返回实例
 *
 * 约定：
 * - npm 包名建议使用 'nami-plugin-xxx' 或 '@scope/nami-plugin-xxx' 格式
 * - 插件包必须导出一个符合 NamiPlugin 接口的对象（支持 default 导出）
 */

import {
  NamiError,
  ErrorCode,
  ErrorSeverity,
  createLogger,
} from '@nami/shared';
import type { NamiPlugin, Logger } from '@nami/shared';

// ==================== PluginLoader 类 ====================

/**
 * 插件加载器
 *
 * 负责将字符串形式的插件名称解析为 NamiPlugin 实例，
 * 并对加载结果进行严格校验。
 *
 * @example
 * ```typescript
 * const loader = new PluginLoader();
 *
 * // 加载 npm 包插件
 * const plugin1 = loader.loadPlugin('nami-plugin-monitor');
 *
 * // 直接传入插件实例（透传）
 * const plugin2 = loader.loadPlugin({ name: 'my-plugin', setup: () => {} });
 *
 * // 批量加载
 * const plugins = loader.loadPlugins(['nami-plugin-cache', myLocalPlugin]);
 * ```
 */
export class PluginLoader {
  /** 日志实例 */
  private readonly logger: Logger;

  /**
   * 创建插件加载器
   *
   * @param logger - 日志实例（可选）
   */
  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger('@nami/plugin-loader');
  }

  /**
   * 静态便捷方法：加载单个插件
   *
   * 历史代码中已有 `PluginLoader.load(...)` 的调用方式。
   * 为了兼容这条调用链，这里保留一个无状态的静态入口，
   * 内部仍复用实例方法，避免分叉两套实现。
   */
  static load(nameOrPlugin: NamiPlugin | string, logger?: Logger): NamiPlugin {
    return new PluginLoader(logger).loadPlugin(nameOrPlugin);
  }

  /**
   * 静态便捷方法：批量加载插件
   *
   * 与 `load()` 一样，这里主要用于兼容旧调用方，
   * 保证插件加载逻辑始终集中在实例方法中维护。
   */
  static loadAll(items: Array<NamiPlugin | string>, logger?: Logger): NamiPlugin[] {
    return new PluginLoader(logger).loadPlugins(items);
  }

  /**
   * 加载单个插件
   *
   * 接受两种输入：
   * - NamiPlugin 对象：直接验证并返回
   * - string（npm 包名）：通过 require() 动态加载后验证并返回
   *
   * @param nameOrPlugin - 插件对象或 npm 包名
   * @returns 经过验证的 NamiPlugin 实例
   * @throws NamiError 当加载失败或验证失败时抛出
   */
  loadPlugin(nameOrPlugin: NamiPlugin | string): NamiPlugin {
    // 如果已经是对象，直接验证并返回
    if (typeof nameOrPlugin !== 'string') {
      this.validatePlugin(nameOrPlugin);
      return nameOrPlugin;
    }

    // 字符串形式：作为 npm 包名加载
    const packageName = nameOrPlugin;
    this.logger.debug(
      `正在加载插件包: ${packageName}`,
      { packageName },
    );

    let loaded: unknown;

    try {
      // 使用 require() 加载 npm 包
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loaded = require(packageName);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      throw new NamiError(
        `无法加载插件包 [${packageName}]: ${errMessage}。` +
        `请确认该包已安装（pnpm add ${packageName}）且可被正确引入。`,
        ErrorCode.PLUGIN_LOAD_FAILED,
        ErrorSeverity.Error,
        {
          packageName,
          originalError: errMessage,
        },
      );
    }

    // 处理 ES Module 的 default 导出
    // 某些包可能使用 export default 导出插件对象
    const plugin = this.resolveExport(loaded, packageName);

    // 验证加载的模块是否符合 NamiPlugin 接口
    this.validatePlugin(plugin, packageName);

    this.logger.info(
      `插件包 [${packageName}] 加载成功 -> ${plugin.name}${plugin.version ? ` v${plugin.version}` : ''}`,
      {
        packageName,
        pluginName: plugin.name,
        version: plugin.version,
      },
    );

    return plugin;
  }

  /**
   * 批量加载插件
   *
   * 依次加载每个插件，如果某个插件加载失败，直接抛出错误。
   * 不做容错处理，因为插件加载失败通常意味着配置有误。
   *
   * @param items - 插件对象或 npm 包名的混合列表
   * @returns 经过验证的 NamiPlugin 实例列表
   */
  loadPlugins(items: Array<NamiPlugin | string>): NamiPlugin[] {
    return items.map((item, index) => {
      try {
        return this.loadPlugin(item);
      } catch (error) {
        // 包装错误，添加索引信息便于定位
        if (error instanceof NamiError) {
          throw error;
        }
        const errMessage = error instanceof Error ? error.message : String(error);
        throw new NamiError(
          `加载第 ${index + 1} 个插件失败: ${errMessage}`,
          ErrorCode.PLUGIN_LOAD_FAILED,
          ErrorSeverity.Error,
          { index, item: String(item), originalError: errMessage },
        );
      }
    });
  }

  // ==================== 私有方法 ====================

  /**
   * 解析模块导出
   *
   * 处理不同的导出格式：
   * 1. CommonJS 直接导出：module.exports = plugin
   * 2. ES Module default 导出：export default plugin（编译后 { default: plugin }）
   * 3. 工厂函数：module.exports = () => plugin（目前不支持，预留）
   *
   * @param exported    - require() 加载的原始导出
   * @param packageName - 包名（用于错误信息）
   * @returns 解析后的插件对象
   */
  private resolveExport(exported: unknown, packageName: string): NamiPlugin {
    // 如果导出对象有 default 属性，使用 default（ES Module 编译产物）
    if (
      exported !== null &&
      typeof exported === 'object' &&
      'default' in exported &&
      (exported as Record<string, unknown>)['default'] !== undefined
    ) {
      const defaultExport = (exported as Record<string, unknown>)['default'];

      // default 导出的可能也是一个带 default 的对象（双重 default 情况）
      if (
        defaultExport !== null &&
        typeof defaultExport === 'object' &&
        'name' in (defaultExport as Record<string, unknown>) &&
        'setup' in (defaultExport as Record<string, unknown>)
      ) {
        return defaultExport as NamiPlugin;
      }
    }

    // 直接导出的对象
    if (
      exported !== null &&
      typeof exported === 'object' &&
      'name' in (exported as Record<string, unknown>) &&
      'setup' in (exported as Record<string, unknown>)
    ) {
      return exported as NamiPlugin;
    }

    // 无法解析
    throw new NamiError(
      `插件包 [${packageName}] 的导出格式无法识别。` +
      `请确保插件导出了一个包含 name 和 setup 属性的对象。`,
      ErrorCode.PLUGIN_LOAD_FAILED,
      ErrorSeverity.Error,
      { packageName, exportedType: typeof exported },
    );
  }

  /**
   * 验证对象是否符合 NamiPlugin 接口
   *
   * 检查必要字段：
   * - name: 必须是非空字符串
   * - setup: 必须是函数
   * - enforce: 如果存在，必须是 'pre' 或 'post'
   * - version: 如果存在，必须是字符串
   *
   * @param plugin      - 待验证的对象
   * @param packageName - 包名（可选，用于错误信息）
   * @throws NamiError 当验证失败时抛出
   */
  private validatePlugin(
    plugin: NamiPlugin,
    packageName?: string,
  ): void {
    const source = packageName ? `插件包 [${packageName}]` : '插件';

    // 验证 name 字段
    if (!plugin.name || typeof plugin.name !== 'string') {
      throw new NamiError(
        `${source} 缺少有效的 name 字段。name 必须是一个非空字符串。`,
        ErrorCode.PLUGIN_LOAD_FAILED,
        ErrorSeverity.Error,
        { packageName, pluginName: plugin.name },
      );
    }

    // 验证 setup 字段
    if (typeof plugin.setup !== 'function') {
      throw new NamiError(
        `${source} [${plugin.name}] 缺少有效的 setup 方法。setup 必须是一个函数。`,
        ErrorCode.PLUGIN_LOAD_FAILED,
        ErrorSeverity.Error,
        { packageName, pluginName: plugin.name, setupType: typeof plugin.setup },
      );
    }

    // 验证 enforce 字段（可选，但如果存在必须是合法值）
    if (plugin.enforce !== undefined && plugin.enforce !== 'pre' && plugin.enforce !== 'post') {
      throw new NamiError(
        `${source} [${plugin.name}] 的 enforce 值无效: "${String(plugin.enforce)}"。` +
        `仅支持 'pre' 或 'post'。`,
        ErrorCode.PLUGIN_LOAD_FAILED,
        ErrorSeverity.Error,
        { packageName, pluginName: plugin.name, enforce: plugin.enforce },
      );
    }

    // 验证 version 字段（可选，但如果存在必须是字符串）
    if (plugin.version !== undefined && typeof plugin.version !== 'string') {
      throw new NamiError(
        `${source} [${plugin.name}] 的 version 字段必须是字符串。`,
        ErrorCode.PLUGIN_LOAD_FAILED,
        ErrorSeverity.Warning,
        { packageName, pluginName: plugin.name, versionType: typeof plugin.version },
      );
    }
  }
}
