/**
 * @nami/webpack - 构建编排器
 *
 * NamiBuilder 是构建流程的总控制器，负责：
 * 1. 加载和验证配置
 * 2. 确定需要哪些构建任务（根据路由配置的渲染模式）
 * 3. 创建和执行 Webpack 编译
 * 4. 执行 SSG 静态生成
 * 5. 生成框架清单文件
 *
 * 构建流程图：
 * ```
 * nami build
 * ├── 加载 nami.config.ts
 * ├── 执行 modifyWebpackConfig 钩子
 * ├── 确定构建任务
 * │
 * ├── [并行] Client Build → dist/client/
 * ├── [并行] Server Build → dist/server/ (如有 SSR/ISR 路由)
 * │
 * ├── [串行] SSG Generate → dist/static/ (依赖 Client/Server Bundle，故编译完成后执行)
 * │
 * └── 生成 nami-manifest.json
 * ```
 */

import webpack from 'webpack';
import type { Configuration, Stats } from 'webpack';
import type { NamiConfig, NamiRoute, NamiPlugin } from '@nami/shared';
import {
  NEEDS_SERVER_BUNDLE,
  RenderMode,
  createLogger,
  NAMI_MANIFEST_FILENAME,
  ASSET_MANIFEST_FILENAME,
} from '@nami/shared';
import { ModuleLoader, PluginLoader, PluginManager, SSGRenderer } from '@nami/core';
import type { AppElementFactory, AssetManifest } from '@nami/core';
import path from 'path';
import fs from 'fs';
import { createClientConfig } from './configs/client.config';
import { createServerConfig } from './configs/server.config';
import { NamiManifestPlugin } from './plugins/manifest-plugin';
import { NamiHtmlInjectPlugin } from './plugins/html-inject-plugin';
import { createProgressPlugin } from './plugins/progress-plugin';

const logger = createLogger('@nami/webpack');

// 判断 path.relative() 的结果是否已经逃出基准目录。
function isOutsideDirectory(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
}

// 解析构建输出目录，并禁止输出到项目外、项目根、.git 或 node_modules。
function resolveSafeOutDir(projectRoot: string, configuredOutDir: string): string {
  if (typeof configuredOutDir !== 'string' || configuredOutDir.trim().length === 0) {
    throw new Error('outDir 必须是非空字符串');
  }

  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedOutDir = path.resolve(resolvedProjectRoot, configuredOutDir);
  const relative = path.relative(resolvedProjectRoot, resolvedOutDir);
  const topLevelDir = relative.split(path.sep)[0];

  if (
    relative === '' ||
    isOutsideDirectory(relative) ||
    path.isAbsolute(relative) ||
    topLevelDir === '.git' ||
    topLevelDir === 'node_modules'
  ) {
    throw new Error(`outDir 必须位于项目内的安全子目录，当前值: ${configuredOutDir}`);
  }

  return resolvedOutDir;
}

/**
 * 构建任务类型
 */
interface BuildTask {
  /** 任务类型 */
  type: 'client' | 'server' | 'ssg';
  /** Webpack 配置 */
  config: Configuration;
  /** 相关路由（SSG 需要） */
  routes?: NamiRoute[];
}

/**
 * 构建结果
 */
export interface BuildResult {
  /** 是否成功 */
  success: boolean;
  /** 构建耗时（毫秒） */
  duration: number;
  /** 错误信息列表 */
  errors: string[];
  /** 警告信息列表 */
  warnings: string[];
  /** 各构建任务的统计信息 */
  stats: Record<string, Stats | null>;
}

export interface BuildOptions {
  /** 是否生成 bundle 分析报告 */
  analyze?: boolean;
  /** 是否启用压缩，默认跟随各端构建配置 */
  minimize?: boolean;
  /** 构建前是否清空输出目录，默认 true */
  clean?: boolean;
  /** 仅对这些路由执行 SSG/ISR 预生成 */
  ssgRoutes?: string[];
}

/**
 * Nami 构建编排器
 */
export class NamiBuilder {
  private config: NamiConfig;
  private projectRoot: string;
  private pluginManager?: PluginManager;

  /** SSG 生成阶段收集的路由级错误，最终合并到 BuildResult.errors */
  private ssgErrors: string[] = [];

  constructor(config: NamiConfig, projectRoot: string) {
    this.config = config;
    this.projectRoot = projectRoot;
  }

  /**
   * 清理构建输出目录
   *
   * 在每次构建前调用，确保不会残留上次构建的产物。
   * 仅清理框架管理的 outDir 目录（默认 dist/）。
   */
  private clean(): void {
    const outDir = resolveSafeOutDir(this.projectRoot, this.config.outDir);
    if (fs.existsSync(outDir)) {
      logger.info(`清理构建输出目录: ${outDir}`);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outDir, { recursive: true });
  }

  /**
   * 执行完整构建流程
   *
   * @param mode - 构建模式
   * @returns 构建结果
   */
  async build(
    mode: 'development' | 'production' = 'production',
    options: BuildOptions = {},
  ): Promise<BuildResult> {
    const startTime = Date.now();
    const isDev = mode === 'development';
    const errors: string[] = [];
    const warnings: string[] = [];
    const stats: Record<string, Stats | null> = {};

    logger.info(`开始构建 [${this.config.appName}]，模式: ${mode}`);

    resolveSafeOutDir(this.projectRoot, this.config.outDir);

    if (options.clean !== false) {
      this.clean();
    }

    try {
      await this.prepareBuildContext(isDev);

      // 1. 分析路由，确定构建任务
      // tasks 示例（生产模式，路由里同时有 SSR 和 SSG/ISR）：
      // [
      //   { type: 'client', config: clientWebpackConfig },
      //   { type: 'server', config: serverWebpackConfig },
      //   { type: 'ssg', config: {}, routes: [{ path: '/', renderMode: RenderMode.SSG }] },
      // ]
      const tasks = await this.determineBuildTasks(isDev, options);
      logger.info(`需要执行 ${tasks.length} 个构建任务`);

      await this.pluginManager?.callHook('buildStart');

      // 2. 并行执行 Client 和 Server 构建
      const compileTasks = tasks.filter((t) => t.type !== 'ssg');
      if (compileTasks.length > 0) {
        const compileResults = await this.runParallelCompilation(compileTasks);
        for (const [name, result] of Object.entries(compileResults)) {
          stats[name] = result.stats;
          errors.push(...result.errors);
          warnings.push(...result.warnings);
        }
      }

      // 如果编译有错误，不继续 SSG
      if (errors.length > 0) {
        return {
          success: false,
          duration: Date.now() - startTime,
          errors,
          warnings,
          stats,
        };
      }

      // 所有需要 server bundle 的项目都在构建期校验唯一入口协议，
      // 避免 SSR-only 项目到 nami start 才发现仍在导出旧 API。
      if (tasks.some((task) => task.type === 'server')) {
        this.resolveBuiltAppElementFactory();
      }

      // 3. 执行 SSG 静态生成（需要 Server Bundle 已就绪）
      this.ssgErrors = [];
      const ssgTask = tasks.find((t) => t.type === 'ssg');
      if (ssgTask?.routes && ssgTask.routes.length > 0) {
        await this.generateStaticPages(ssgTask.routes);
      }
      // 将 SSG 路由级错误纳入 BuildResult，让 CI 能感知部分页面生成失败
      if (this.ssgErrors.length > 0) {
        errors.push(...this.ssgErrors);
      }

      // 4. 生成框架清单文件
      await this.generateManifest();

      await this.pluginManager?.callHook('buildEnd');

      const duration = Date.now() - startTime;
      const success = errors.length === 0;
      logger.info(`构建完成，耗时 ${duration}ms`, { success, errorCount: errors.length });

      return { success, duration, errors, warnings, stats };
    } catch (error) {
      const err = error as Error;
      logger.error(`构建失败: ${err.message}`);
      errors.push(err.message);
      try {
        await this.pluginManager?.callHook('buildEnd');
      } catch {
        // 构建收尾钩子失败不应覆盖主错误
      }
      return {
        success: false,
        duration: Date.now() - startTime,
        errors,
        warnings,
        stats,
      };
    }
  }

  async createWebpackConfig(
    target: 'client' | 'server',
    mode: 'development' | 'production' = 'production',
    options: BuildOptions = {},
  ): Promise<Configuration> {
    const isDev = mode === 'development';
    await this.prepareBuildContext(isDev);

    const rawConfig =
      target === 'server'
        ? createServerConfig({
            config: this.config,
            projectRoot: this.projectRoot,
            isDev,
          })
        : createClientConfig({
            config: this.config,
            projectRoot: this.projectRoot,
            isDev,
          });

    return await this.applyWebpackConfigEnhancers(rawConfig, target, isDev, options);
  }

  /**
   * 分析路由配置，确定需要哪些构建任务
   *
   * 根据路由表中各路由的 renderMode 决定需要哪些构建产物：
   * - Client Bundle：始终需要（CSR 渲染和 Hydration 都依赖它）
   * - Server Bundle：仅当存在 SSR,  SSG 或 ISR 路由时需要（服务端渲染用）
   * - SSG 生成：仅当存在 SSG 或 ISR 路由且为生产模式时执行
   *
   * @param isDev - 是否为开发模式（开发模式跳过 SSG）
   * @returns 构建任务列表
   */
  private async determineBuildTasks(
    isDev: boolean,
    options: BuildOptions = {},
  ): Promise<BuildTask[]> {
    const tasks: BuildTask[] = [];
    const routes = this.config.routes;

    // 客户端 Bundle 始终需要
    const clientConfig = await this.applyWebpackConfigEnhancers(
      createClientConfig({
        config: this.config,
        projectRoot: this.projectRoot,
        isDev,
      }),
      'client',
      isDev,
      options,
    );
    tasks.push({ type: 'client', config: clientConfig });

    // 检查是否需要服务端 Bundle
    const needsServerBundle = routes.some((route: NamiRoute) =>
      NEEDS_SERVER_BUNDLE.includes(route.renderMode),
    );
    if (needsServerBundle) {
      const serverConfig = await this.applyWebpackConfigEnhancers(
        createServerConfig({
          config: this.config,
          projectRoot: this.projectRoot,
          isDev,
        }),
        'server',
        isDev,
        options,
      );
      tasks.push({ type: 'server', config: serverConfig });
    }

    // 检查是否需要 SSG
    let ssgRoutes = routes.filter(
      (route: NamiRoute) =>
        route.renderMode === RenderMode.SSG || route.renderMode === RenderMode.ISR,
    );
    if (options.ssgRoutes && options.ssgRoutes.length > 0) {
      const ssgRouteSet = new Set(options.ssgRoutes);
      ssgRoutes = ssgRoutes.filter((route) => ssgRouteSet.has(route.path));
    }
    if (ssgRoutes.length > 0 && !isDev) {
      tasks.push({ type: 'ssg', config: {}, routes: ssgRoutes });
    }

    return tasks;
  }

  /**
   * 初始化构建期插件上下文
   *
   * 构建链路需要显式执行 build 阶段插件钩子：
   * - modifyRoutes：先产出最终路由表，再驱动 client/server/ssg 三条任务链
   * - modifyWebpackConfig：在每份 webpack 配置创建后继续做 waterfall 修改
   */
  // @Riven
  private async prepareBuildContext(isDev: boolean): Promise<void> {
    const resolvedPlugins: NamiPlugin[] = [];
    this.pluginManager = new PluginManager(this.config, logger);

    for (const pluginEntry of this.config.plugins) {
      if (typeof pluginEntry === 'string') {
        resolvedPlugins.push(await PluginLoader.load(pluginEntry));
      } else {
        resolvedPlugins.push(pluginEntry);
      }
    }

    await this.pluginManager.registerPlugins(resolvedPlugins);

    const modifiedRoutes = await this.pluginManager.runWaterfallHook('modifyRoutes', [
      ...this.config.routes,
    ]);

    // modifiedRoutes 示例：插件可能追加路由，或把已有路由改成 SSG/SSR/ISR。
    // [
    //   { path: '/', component: 'pages/index.tsx', renderMode: RenderMode.CSR },
    //   { path: '/docs', component: 'pages/docs.tsx', renderMode: RenderMode.SSG, getStaticProps: 'getStaticProps' },
    //   { path: '/preview/:id', component: 'pages/preview.tsx', renderMode: RenderMode.SSR, getServerSideProps: 'getServerSideProps' },
    // ]
    // Builder 是单次使用对象，这里直接更新内部 config，
    // 让后续任务划分、生成模块映射和 manifest 都基于同一份最终路由表。
    this.config = {
      ...this.config,
      routes: modifiedRoutes,
    };

    logger.debug('构建上下文初始化完成', {
      isDev,
      routeCount: this.config.routes.length,
      pluginCount: resolvedPlugins.length,
    });
  }

  /**
   * 增强 Webpack 配置：添加框架内置插件
   *
   * 在原始 Webpack 配置的基础上注入 Nami 框架内置的 Webpack 插件：
   * - 所有构建：添加进度条插件（显示构建进度）
   * - 客户端构建额外添加：
   *   - NamiManifestPlugin：生成资源清单，供服务端渲染时引用正确的 JS/CSS 路径
   *   - NamiHtmlInjectPlugin：存在 CSR 路由时生成 index.html，并始终生成 emergency.html
   *
   * @param config - 原始 Webpack 配置
   * @param name - 构建任务名称（'client' | 'server'）
   * @returns 增强后的 Webpack 配置
   */
  private enhanceConfig(config: Configuration, name: string): Configuration {
    const plugins = [...(config.plugins || [])];

    // 添加进度插件
    plugins.push(createProgressPlugin({ name }));

    // 客户端构建：添加资源清单和 HTML 模板
    if (name === 'client') {
      plugins.push(new NamiManifestPlugin());
      // CSR 模式需要 index.html；emergency.html 则始终产出，供反代/CDN 在
      // Node 服务完全不可达时使用。
      const hasCSR = this.config.routes.some(
        (route: NamiRoute) => route.renderMode === RenderMode.CSR,
      );
      plugins.push(
        new NamiHtmlInjectPlugin({
          title: this.config.title || this.config.appName,
          emitIndex: hasCSR,
          staticEmergencyHTML: this.config.fallback.staticHTML,
        }),
      );
    }

    return { ...config, plugins };
  }

  private async applyWebpackConfigEnhancers(
    rawConfig: Configuration,
    name: 'client' | 'server',
    isDev: boolean,
    options: BuildOptions,
  ): Promise<Configuration> {
    let config = this.enhanceConfig(rawConfig, name);

    if (name === 'client' && typeof options.minimize === 'boolean') {
      config = {
        ...config,
        optimization: {
          ...(config.optimization || {}),
          minimize: options.minimize,
        },
      };
    }

    const customModifier =
      name === 'client' ? this.config.webpack.client : this.config.webpack.server;
    if (customModifier) {
      config = customModifier(config);
    }

    if (this.pluginManager) {
      config = await this.pluginManager.runWaterfallHook('modifyWebpackConfig', config, {
        isServer: name === 'server',
        isDev,
      });
    }

    if (options.analyze) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer') as {
        BundleAnalyzerPlugin: new (options: {
          analyzerMode: string;
          reportFilename: string;
          openAnalyzer: boolean;
          logLevel: string;
        }) => webpack.WebpackPluginInstance;
      };

      config = {
        ...config,
        plugins: [
          ...(config.plugins || []),
          new BundleAnalyzerPlugin({
            analyzerMode: 'static',
            reportFilename: `${name}-bundle-report.html`,
            openAnalyzer: false,
            logLevel: 'silent',
          }),
        ],
      };
    }

    return config;
  }

  /**
   * 并行执行多个 Webpack 编译任务
   *
   * Client 和 Server 构建互相独立，可并行执行以缩短总构建时间。
   * 每个任务独立创建 Webpack Compiler 实例，编译完成后收集错误和警告。
   *
   * @param tasks - 待执行的构建任务列表
   * @returns 各任务的编译结果（按 task.type 为键）
   */
  private async runParallelCompilation(
    tasks: BuildTask[],
  ): Promise<Record<string, { stats: Stats | null; errors: string[]; warnings: string[] }>> {
    const results: Record<string, { stats: Stats | null; errors: string[]; warnings: string[] }> =
      {};

    await Promise.all(
      tasks.map(async (task) => {
        logger.info(`开始 ${task.type} 构建...`);
        const result = await this.runCompilation(task.config);
        results[task.type] = result;
        if (result.errors.length > 0) {
          logger.error(`${task.type} 构建失败，${result.errors.length} 个错误`);
        } else {
          logger.info(`${task.type} 构建完成`);
        }
      }),
    );

    return results;
  }

  /**
   * 执行单个 Webpack 编译
   *
   * 封装 webpack compiler.run() 为 Promise，统一错误和警告的收集格式。
   * 编译完成后主动调用 compiler.close() 释放文件 watcher 等系统资源。
   *
   * @param config - Webpack 配置
   * @returns 包含 stats、错误列表和警告列表的结果对象
   */
  private runCompilation(
    config: Configuration,
  ): Promise<{ stats: Stats | null; errors: string[]; warnings: string[] }> {
    return new Promise((resolve) => {
      const compiler = webpack(config);

      compiler.run((err?: Error | null, stats?: Stats) => {
        const errors: string[] = [];
        const warnings: string[] = [];

        if (err) {
          errors.push(err.message);
        }

        if (stats) {
          // 从 Webpack Stats 中提取错误和警告
          // Webpack 5 的 stats.toJson() 返回的 errors/warnings 可能是字符串或对象
          const info = stats.toJson({ errors: true, warnings: true });
          if (info.errors) {
            errors.push(
              ...info.errors.map((error: string | { message?: string }) =>
                typeof error === 'string' ? error : (error.message ?? 'Unknown webpack error'),
              ),
            );
          }
          if (info.warnings) {
            warnings.push(
              ...info.warnings.map((warning: string | { message?: string }) =>
                typeof warning === 'string'
                  ? warning
                  : (warning.message ?? 'Unknown webpack warning'),
              ),
            );
          }
        }

        // 关闭编译器释放资源
        compiler.close(() => {
          resolve({ stats: stats || null, errors, warnings });
        });
      });
    });
  }

  /**
   * 解析并校验编译后的服务端入口。
   *
   * 同一进程可能连续执行多次构建，因此读取前清除 require cache，确保拿到
   * 本次 compilation 产出的 createAppElement，而不是上一轮 bundle。
   */
  private resolveBuiltAppElementFactory(): {
    appElementFactory: AppElementFactory;
    serverBundlePath: string;
  } {
    const outDir = resolveSafeOutDir(this.projectRoot, this.config.outDir);
    const serverBundlePath = path.resolve(outDir, 'server', 'entry-server.js');

    if (!fs.existsSync(serverBundlePath)) {
      throw new Error(
        '构建缺少 dist/server/entry-server.js；请创建 src/entry-server 并导出 createAppElement(context)',
      );
    }

    const resolvedBundlePath = require.resolve(serverBundlePath);
    delete require.cache[resolvedBundlePath];

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const serverBundle = require(resolvedBundlePath) as {
      createAppElement?: unknown;
    };
    if (typeof serverBundle.createAppElement !== 'function') {
      throw new Error(
        '服务端入口必须导出 createAppElement(context)，旧的 renderToHTML 协议已不再支持',
      );
    }

    return {
      appElementFactory: serverBundle.createAppElement as AppElementFactory,
      serverBundlePath,
    };
  }

  /**
   * 执行 SSG 静态页面生成
   *
   * 在 Client/Server Webpack 编译完成后执行，并复用 core 的 SSGRenderer：
   * 页面模块负责 getStaticPaths/getStaticProps，entry-server 的 createAppElement
   * 只负责创建 React 元素树，React 字符串渲染、Document、资源与注水均由框架负责。
   *
   * 对于动态路由（路径含 :param），需要 getStaticPaths 提供预生成的参数列表。
   *
   * @param routes - 需要静态生成的路由列表
   */
  private async generateStaticPages(routes: NamiRoute[]): Promise<void> {
    logger.info(`开始静态页面生成，共 ${routes.length} 个路由...`);

    const outDir = resolveSafeOutDir(this.projectRoot, this.config.outDir);
    const staticOutputDir = path.resolve(outDir, 'static');
    const { appElementFactory, serverBundlePath } = this.resolveBuiltAppElementFactory();

    const moduleManifest = this.buildModuleManifest();
    const moduleLoader = new ModuleLoader({
      serverBundlePath,
      moduleManifest,
    });

    const assetManifestPath = path.resolve(outDir, 'client', ASSET_MANIFEST_FILENAME);
    if (!fs.existsSync(assetManifestPath)) {
      throw new Error(`SSG 构建缺少客户端资源清单: ${assetManifestPath}`);
    }
    const assetManifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf-8')) as AssetManifest;

    const renderer = new SSGRenderer({
      config: this.config,
      pluginManager: this.pluginManager,
      moduleLoader,
      assetManifest,
      appElementFactory,
      staticDir: staticOutputDir,
    });
    const generationResult = await renderer.generateStatic(routes);

    for (const failure of generationResult.errors) {
      this.ssgErrors.push(`SSG 页面 [${failure.path}] 生成失败: ${failure.error}`);
    }

    logger.info(`静态页面生成完成，共生成 ${generationResult.generatedPaths.length} 个页面`, {
      failedPages: generationResult.errors.length,
      duration: generationResult.duration,
    });
  }

  /**
   * 生成框架总清单文件
   *
   * nami-manifest.json 包含路由映射、渲染模式、资源引用等信息，
   * 服务端运行时读取此文件来决定如何处理每个请求。
   */
  private async generateManifest(): Promise<void> {
    const moduleManifest = this.buildModuleManifest();

    const manifest = {
      appName: this.config.appName,
      generatedAt: new Date().toISOString(),
      routes: this.config.routes.map((route: NamiRoute) => ({
        path: route.path,
        component: route.component,
        renderMode: route.renderMode,
        getServerSideProps: route.getServerSideProps,
        getStaticProps: route.getStaticProps,
        getStaticPaths: route.getStaticPaths,
        revalidate: route.revalidate,
        fallback: route.fallback,
      })),
      // 运行时通过这份映射定位独立编译出来的页面模块，
      // 让默认 SSR/ISR 启动路径也能解析页面级数据预取函数。
      moduleManifest,
      buildInfo: {
        nodeVersion: process.version,
        namiVersion: this.resolveNamiVersion(),
      },
    };

    const outputPath = path.resolve(
      resolveSafeOutDir(this.projectRoot, this.config.outDir),
      NAMI_MANIFEST_FILENAME,
    );

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf-8');

    logger.info(`框架清单已生成: ${outputPath}`);
  }

  /**
   * 解析 Nami 框架版本号
   *
   * 优先级：
   * 1. 环境变量 NAMI_VERSION（CI/CD 场景注入）
   * 2. 项目根目录 package.json 的 version 字段
   * 3. @nami/webpack 自身 package.json 的 version 字段
   * 4. 兜底 '0.0.0-unknown'
   */
  private resolveNamiVersion(): string {
    // 优先使用环境变量
    if (process.env.NAMI_VERSION) {
      return process.env.NAMI_VERSION;
    }

    // 尝试从项目根目录 package.json 读取
    try {
      const rootPkgPath = path.resolve(this.projectRoot, 'package.json');
      if (fs.existsSync(rootPkgPath)) {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
        if (rootPkg.version) {
          return rootPkg.version;
        }
      }
    } catch {
      // 读取失败，继续尝试下一个来源
    }

    // 尝试从 @nami/webpack 自身 package.json 读取
    try {
      const selfPkgPath = path.resolve(__dirname, '..', 'package.json');
      if (fs.existsSync(selfPkgPath)) {
        const selfPkg = JSON.parse(fs.readFileSync(selfPkgPath, 'utf-8'));
        if (selfPkg.version) {
          return selfPkg.version;
        }
      }
    } catch {
      // 读取失败，使用兜底值
    }

    return '0.0.0-unknown';
  }

  /**
   * 根据路由组件路径生成页面模块清单
   *
   * 这份映射既用于运行时 ModuleLoader，也用于构建阶段的 SSG/ISR 预生成，
   * 保证两条链路对页面模块定位规则完全一致。
   */
  private buildModuleManifest(): Record<string, string> {
    const uniqueComponentPaths: string[] = Array.from(
      new Set(
        this.config.routes
          .map((route: NamiRoute) => route.component)
          .filter(
            (componentPath: unknown): componentPath is string =>
              typeof componentPath === 'string' && componentPath.length > 0,
          ),
      ),
    );

    return Object.fromEntries(
      uniqueComponentPaths.map((componentPath) => [
        componentPath,
        `${componentPath.replace(/^\.\//, '')}.js`,
      ]),
    );
  }
}
