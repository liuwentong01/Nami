/**
 * @nami/core - 服务端页面模块加载器
 *
 * `ModuleLoader` 只实现一条确定的加载链路：
 *
 * ```text
 * route.component
 *   -> moduleManifest
 *   -> dist/server 下的页面文件
 *   -> require()
 *   -> moduleCache
 *   -> 页面具名导出
 * ```
 *
 * 例如路由配置：
 *
 * ```ts
 * {
 *   path: '/products/:id',
 *   component: './pages/product-detail',
 *   getServerSideProps: 'getServerSideProps',
 * }
 * ```
 *
 * 构建器会生成页面产物和 manifest：
 *
 * ```text
 * dist/server/pages/product-detail.js
 *
 * moduleManifest = {
 *   './pages/product-detail': 'pages/product-detail.js',
 * }
 * ```
 *
 * 页面文件经 `require()` 后的输出类似：
 *
 * ```ts
 * {
 *   default: ProductDetailPage,
 *   getServerSideProps: async (context) => ({
 *     props: { product: { id: context.params.id, name: 'Nami' } },
 *   }),
 * }
 * ```
 *
 * ModuleLoader 负责定位并返回这个导出对象或其中的函数，不负责执行数据函数；
 * 函数调用、超时、降级和数据注水由 SSR/SSG/ISR Renderer 处理。
 */

import { createLogger } from '@nami/shared';
import fs from 'fs';
import path from 'path';

const logger = createLogger('@nami/core:module-loader');

/** ModuleLoader 的唯一正式输入契约。 */
export interface ModuleLoaderOptions {
  /**
   * 服务端构建产物目录。
   *
   * 输入示例：
   * ```text
   * /app/dist/server
   * ```
   */
  serverOutputDir: string;

  /**
   * 路由组件路径到服务端页面文件的映射。
   *
   * key 必须与 `route.component` 完全一致；value 必须是
   * `serverOutputDir` 内的相对文件路径。
   *
   * 输入示例：
   * ```ts
   * {
   *   './pages/home': 'pages/home.js',
   *   './pages/product-detail': 'pages/product-detail.js',
   * }
   * ```
   */
  moduleManifest: Readonly<Record<string, string>>;
}

/**
 * 根据 module manifest 加载服务端页面 CommonJS 产物。
 *
 * 业务项目通常不直接创建该实例。Nami Builder 生成 manifest，CLI 启动服务时
 * 创建 ModuleLoader，Renderer 再根据路由声明提取数据函数。
 *
 * @example 手动使用
 * ```ts
 * const loader = new ModuleLoader({
 *   serverOutputDir: '/app/dist/server',
 *   moduleManifest: {
 *     './pages/product-detail': 'pages/product-detail.js',
 *   },
 * });
 *
 * const getServerSideProps = await loader.getExportedFunction<
 *   (context: { params: Record<string, string> }) => Promise<{
 *     props: { product: { id: string; name: string } };
 *   }>
 * >('./pages/product-detail', 'getServerSideProps');
 *
 * const result = await getServerSideProps?.({ params: { id: '42' } });
 * // { props: { product: { id: '42', name: 'Nami' } } }
 * ```
 */
export class ModuleLoader {
  /** 绝对化后的服务端产物根目录。 */
  private readonly serverOutputDir: string;

  /** 构造时复制一份，避免外部运行时修改映射导致同一实例前后行为不一致。 */
  private readonly moduleManifest: Readonly<Record<string, string>>;

  /** 已加载页面模块缓存，key 为原始 route.component。 */
  private readonly moduleCache = new Map<string, Record<string, unknown>>();

  constructor(options: ModuleLoaderOptions) {
    if (
      !options ||
      typeof options.serverOutputDir !== 'string' ||
      !options.serverOutputDir.trim()
    ) {
      throw new Error('ModuleLoader: serverOutputDir 必须是非空路径');
    }

    if (!options.moduleManifest || typeof options.moduleManifest !== 'object') {
      throw new Error('ModuleLoader: moduleManifest 必须是页面路径映射对象');
    }

    this.serverOutputDir = path.resolve(options.serverOutputDir);
    this.moduleManifest = { ...options.moduleManifest };

    logger.debug('ModuleLoader 已初始化', {
      serverOutputDir: this.serverOutputDir,
      manifestEntries: Object.keys(this.moduleManifest).length,
    });
  }

  /**
   * 加载一个路由对应的服务端页面模块。
   *
   * 输入：
   * ```text
   * componentPath = './pages/product-detail'
   * ```
   *
   * 处理过程：
   * ```text
   * moduleManifest['./pages/product-detail']
   *   -> 'pages/product-detail.js'
   *   -> '/app/dist/server/pages/product-detail.js'
   *   -> require(...)
   * ```
   *
   * 成功输出：
   * ```ts
   * {
   *   default: ProductDetailPage,
   *   getServerSideProps: [AsyncFunction: getServerSideProps],
   * }
   * ```
   *
   * 同一实例第一次加载后写入 `moduleCache`，后续使用相同 componentPath 时
   * 直接返回同一个模块对象。
   *
   * @param componentPath - 路由配置中的 `route.component`
   * @returns 页面 CommonJS 模块的完整导出对象
   * @throws manifest 缺少映射、映射越界、页面文件不存在或 require 失败时抛错
   */
  async loadModule(componentPath: string): Promise<Record<string, unknown>> {
    const cached = this.moduleCache.get(componentPath);
    if (cached) {
      return cached;
    }

    const relativeModulePath = this.moduleManifest[componentPath];
    if (typeof relativeModulePath !== 'string' || !relativeModulePath.trim()) {
      throw new Error(`ModuleLoader: moduleManifest 中不存在页面 "${componentPath}"`);
    }

    const absoluteModulePath = this.resolveModulePath(componentPath, relativeModulePath);

    if (!fs.existsSync(absoluteModulePath)) {
      throw new Error(
        `ModuleLoader: 页面 "${componentPath}" 的编译产物不存在: ${absoluteModulePath}`,
      );
    }

    if (!fs.statSync(absoluteModulePath).isFile()) {
      throw new Error(
        `ModuleLoader: 页面 "${componentPath}" 的 manifest 目标不是文件: ${absoluteModulePath}`,
      );
    }

    try {
      const resolvedModulePath = require.resolve(absoluteModulePath);

      // 新 ModuleLoader 可能由开发态 runtimeProvider 在重新编译后创建。
      // 清除 Node 进程级缓存，保证本实例第一次读取的是当前磁盘产物；
      // 随后的请求内复用由 moduleCache 负责。
      delete require.cache[resolvedModulePath];

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(resolvedModulePath) as unknown;
      if (!loaded || typeof loaded !== 'object') {
        throw new Error(`页面模块必须导出 CommonJS 对象，实际类型为 ${typeof loaded}`);
      }

      const pageModule = loaded as Record<string, unknown>;
      this.moduleCache.set(componentPath, pageModule);

      logger.debug('页面模块加载成功', {
        componentPath,
        source: absoluteModulePath,
        exports: Object.keys(pageModule),
      });

      return pageModule;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('页面模块加载失败', {
        componentPath,
        source: absoluteModulePath,
        error: message,
      });
      throw new Error(`ModuleLoader: 页面 "${componentPath}" 加载失败: ${message}`);
    }
  }

  /**
   * 从页面模块中提取指定的具名导出函数。
   *
   * 输入：
   * ```text
   * componentPath = './pages/product-detail'
   * functionName  = 'getServerSideProps'
   * ```
   *
   * 输出：
   * ```text
   * [AsyncFunction: getServerSideProps]
   * ```
   *
   * 如果模块存在，但该导出不存在或不是函数，则返回 `null`。该方法只返回函数
   * 引用，不会执行它；泛型 `T` 也只提供 TypeScript 静态类型，不做运行时签名校验。
   *
   * @typeParam T - 调用方期望的函数签名
   * @param componentPath - 路由配置中的 `route.component`
   * @param functionName - 路由配置声明的导出函数名
   * @returns 导出函数或 `null`
   */
  async getExportedFunction<T extends (...args: any[]) => any>(
    componentPath: string,
    functionName: string,
  ): Promise<T | null> {
    const pageModule = await this.loadModule(componentPath);
    const exported = pageModule[functionName];

    if (typeof exported === 'function') {
      logger.debug('成功获取页面导出函数', { componentPath, functionName });
      return exported as T;
    }

    logger.debug('页面导出函数未找到', {
      componentPath,
      functionName,
      availableExports: Object.keys(pageModule),
    });
    return null;
  }

  /**
   * 将 manifest 相对路径解析为受约束的页面绝对路径。
   *
   * manifest 不允许写绝对路径，也不允许通过 `../` 逃逸 `serverOutputDir`。
   */
  private resolveModulePath(componentPath: string, relativeModulePath: string): string {
    if (path.isAbsolute(relativeModulePath)) {
      throw new Error(
        `ModuleLoader: 页面 "${componentPath}" 的 manifest 必须使用相对路径: ${relativeModulePath}`,
      );
    }

    const absoluteModulePath = path.resolve(this.serverOutputDir, relativeModulePath);
    const relativeToOutputDir = path.relative(this.serverOutputDir, absoluteModulePath);
    const escapesOutputDir =
      relativeToOutputDir === '..' ||
      relativeToOutputDir.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToOutputDir);

    if (escapesOutputDir) {
      throw new Error(
        `ModuleLoader: 页面 "${componentPath}" 的 manifest 路径越界: ${relativeModulePath}`,
      );
    }

    return absoluteModulePath;
  }
}
