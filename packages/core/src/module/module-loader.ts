/**
 * @nami/core - 模块加载器
 *
 * ModuleLoader 负责从编译后的 server bundle 中加载页面组件模块，
 * 提取 getServerSideProps / getStaticProps / getStaticPaths 等导出函数。
 *
 * 工作原理：
 * 1. Webpack 将每个页面组件编译为 server bundle 中的一个模块
 * 2. 构建阶段生成模块清单（module manifest），记录组件路径到模块 ID 的映射
 * 3. ModuleLoader 在运行时根据组件路径查找并加载对应的模块
 * 4. 从模块的 exports 中提取指定的函数
 */

import { createLogger } from '@nami/shared';

const logger = createLogger('@nami/core:module-loader');

/**
 * 模块加载器配置
 */
export interface ModuleLoaderOptions {
  /** server bundle 的绝对路径（如 dist/server/entry-server.js） */
  serverBundlePath?: string;

  /**
   * 已加载的 server bundle 模块对象
   * 如果提供此选项，则直接使用而不从文件加载
   */
  serverBundle?: Record<string, unknown>;

  /**
   * 模块清单：组件路径 → 模块导出名 的映射
   * 如果不提供，则尝试直接用组件路径作为 key 查找
   */
  moduleManifest?: Record<string, string>;
}

/**
 * 模块加载器
 *
 * 从 server bundle 中加载页面组件模块并提取导出函数。
 */
export class ModuleLoader {
  private serverBundle: Record<string, unknown> | null = null;
  private readonly serverBundlePath?: string;
  private readonly moduleManifest: Record<string, string>;
  private readonly moduleCache = new Map<string, Record<string, unknown>>();

  constructor(options: ModuleLoaderOptions = {}) {
    this.serverBundlePath = options.serverBundlePath;
    this.moduleManifest = options.moduleManifest ?? {};

    if (options.serverBundle) {
      this.serverBundle = options.serverBundle;
    }

    logger.debug('ModuleLoader 已初始化', {
      hasServerBundle: !!options.serverBundle,
      serverBundlePath: this.serverBundlePath,
      manifestEntries: Object.keys(this.moduleManifest).length,
    });
  }

  /**
   * 确保 server bundle 已加载
   */
  private async ensureBundle(): Promise<Record<string, unknown>> {
    if (this.serverBundle) {
      return this.serverBundle;
    }

    if (!this.serverBundlePath) {
      throw new Error(
        'ModuleLoader: 未配置 serverBundlePath 且未提供 serverBundle，无法加载模块',
      );
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.serverBundle = require(this.serverBundlePath);
      logger.info('Server bundle 加载成功', {
        path: this.serverBundlePath,
        exports: Object.keys(this.serverBundle!).length,
      });
      return this.serverBundle!;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Server bundle 加载失败', {
        path: this.serverBundlePath,
        error: msg,
      });
      throw new Error(`Server bundle 加载失败: ${msg}`);
    }
  }

  /**
   * 加载指定组件路径的模块
   *
   * @param componentPath - 组件路径（如 './pages/home'）
   * @returns 模块的所有导出
   */
  async loadModule(componentPath: string): Promise<Record<string, unknown>> {
    // 查缓存
    const cached = this.moduleCache.get(componentPath);
    if (cached) return cached;

    const bundle = await this.ensureBundle();

    // 策略 1：通过 moduleManifest 查找模块名
    const manifestKey = this.moduleManifest[componentPath];
    if (manifestKey && bundle[manifestKey]) {
      const mod = bundle[manifestKey] as Record<string, unknown>;
      this.moduleCache.set(componentPath, mod);
      return mod;
    }

    // 策略 2：直接以组件路径为 key 查找
    if (bundle[componentPath]) {
      const mod = bundle[componentPath] as Record<string, unknown>;
      this.moduleCache.set(componentPath, mod);
      return mod;
    }

    // 策略 3：尝试标准化路径后查找（去掉 ./ 前缀，加/不加 index）
    const normalizedPath = componentPath.replace(/^\.\//, '');
    const candidates = [
      normalizedPath,
      `pages/${normalizedPath}`,
      `./pages/${normalizedPath}`,
      `${normalizedPath}/index`,
    ];

    for (const candidate of candidates) {
      if (bundle[candidate]) {
        const mod = bundle[candidate] as Record<string, unknown>;
        this.moduleCache.set(componentPath, mod);
        return mod;
      }
    }

    // 策略 4：如果 bundle 自身就是单个模块的导出（简单场景），直接返回 bundle
    // 这处理的是 server bundle 直接导出所有页面函数的情况
    if (typeof bundle['getServerSideProps'] === 'function' ||
        typeof bundle['getStaticProps'] === 'function' ||
        typeof bundle['getStaticPaths'] === 'function' ||
        typeof bundle['default'] === 'function') {
      this.moduleCache.set(componentPath, bundle);
      return bundle;
    }

    logger.warn('模块未找到', {
      componentPath,
      normalizedPath,
      availableKeys: Object.keys(bundle).slice(0, 20),
    });

    return {};
  }

  /**
   * 从模块中提取指定的导出函数
   *
   * @param componentPath - 组件路径
   * @param functionName - 导出函数名（如 'getServerSideProps'）
   * @returns 导出的函数，未找到返回 null
   */
  async getExportedFunction<T extends (...args: any[]) => any>(
    componentPath: string,
    functionName: string,
  ): Promise<T | null> {
    const mod = await this.loadModule(componentPath);

    if (typeof mod[functionName] === 'function') {
      logger.debug('成功获取导出函数', { componentPath, functionName });
      return mod[functionName] as T;
    }

    logger.debug('导出函数未找到', {
      componentPath,
      functionName,
      availableExports: Object.keys(mod),
    });

    return null;
  }

  /**
   * 清除模块缓存
   * 用于开发模式下 server bundle 重新编译后刷新缓存
   */
  clearCache(): void {
    this.moduleCache.clear();
    this.serverBundle = null;
    logger.debug('ModuleLoader 缓存已清除');
  }

  /**
   * 设置/替换 server bundle
   * 用于开发模式下热更新
   */
  setServerBundle(bundle: Record<string, unknown>): void {
    this.serverBundle = bundle;
    this.moduleCache.clear();
    logger.debug('Server bundle 已更新');
  }
}
