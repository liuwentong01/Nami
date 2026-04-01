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
 * ├── [串行] SSG Generate → dist/static/ (如有 SSG/ISR 路由)
 * │
 * └── 生成 nami-manifest.json
 * ```
 */

import webpack from 'webpack';
import type { Configuration, Stats } from 'webpack';
import type { NamiConfig, NamiRoute } from '@nami/shared';
import { RenderMode, createLogger, NAMI_MANIFEST_FILENAME } from '@nami/shared';
import { ModuleLoader } from '@nami/core';
import path from 'path';
import fs from 'fs';
import { createClientConfig } from './configs/client.config';
import { createServerConfig } from './configs/server.config';
import { NamiManifestPlugin } from './plugins/manifest-plugin';
import { NamiHtmlInjectPlugin } from './plugins/html-inject-plugin';
import { createProgressPlugin } from './plugins/progress-plugin';

const logger = createLogger('@nami/webpack');

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

/**
 * Nami 构建编排器
 */
export class NamiBuilder {
  private config: NamiConfig;
  private projectRoot: string;

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
    const outDir = path.resolve(this.projectRoot, this.config.outDir);
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
  async build(mode: 'development' | 'production' = 'production'): Promise<BuildResult> {
    const startTime = Date.now();
    const isDev = mode === 'development';
    const errors: string[] = [];
    const warnings: string[] = [];
    const stats: Record<string, Stats | null> = {};

    logger.info(`开始构建 [${this.config.appName}]，模式: ${mode}`);

    // 构建前清理产物目录
    this.clean();

    try {
      // 1. 分析路由，确定构建任务
      const tasks = this.determineBuildTasks(isDev);
      logger.info(`需要执行 ${tasks.length} 个构建任务`);

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

      // 3. 执行 SSG 静态生成（需要 Server Bundle 已就绪）
      const ssgTask = tasks.find((t) => t.type === 'ssg');
      if (ssgTask?.routes && ssgTask.routes.length > 0) {
        await this.generateStaticPages(ssgTask.routes);
      }

      // 4. 生成框架清单文件
      await this.generateManifest();

      const duration = Date.now() - startTime;
      logger.info(`构建完成，耗时 ${duration}ms`);

      return { success: true, duration, errors, warnings, stats };
    } catch (error) {
      const err = error as Error;
      logger.error(`构建失败: ${err.message}`);
      errors.push(err.message);
      return {
        success: false,
        duration: Date.now() - startTime,
        errors,
        warnings,
        stats,
      };
    }
  }

  /**
   * 分析路由配置，确定需要哪些构建任务
   *
   * 根据路由表中各路由的 renderMode 决定需要哪些构建产物：
   * - Client Bundle：始终需要（CSR 渲染和 Hydration 都依赖它）
   * - Server Bundle：仅当存在 SSR 或 ISR 路由时需要（服务端渲染用）
   * - SSG 生成：仅当存在 SSG 或 ISR 路由且为生产模式时执行
   *
   * @param isDev - 是否为开发模式（开发模式跳过 SSG）
   * @returns 构建任务列表
   */
  private determineBuildTasks(isDev: boolean): BuildTask[] {
    const tasks: BuildTask[] = [];
    const routes = this.config.routes;

    // 客户端 Bundle 始终需要
    const clientConfig = this.enhanceConfig(
      createClientConfig({
        config: this.config,
        projectRoot: this.projectRoot,
        isDev,
      }),
      'client',
    );
    tasks.push({ type: 'client', config: clientConfig });

    // 检查是否需要服务端 Bundle
    const hasSSR = routes.some(
      (route: NamiRoute) => route.renderMode === RenderMode.SSR || route.renderMode === RenderMode.ISR,
    );
    if (hasSSR) {
      const serverConfig = this.enhanceConfig(
        createServerConfig({
          config: this.config,
          projectRoot: this.projectRoot,
          isDev,
        }),
        'server',
      );
      tasks.push({ type: 'server', config: serverConfig });
    }

    // 检查是否需要 SSG
    const ssgRoutes = routes.filter(
      (route: NamiRoute) => route.renderMode === RenderMode.SSG || route.renderMode === RenderMode.ISR,
    );
    if (ssgRoutes.length > 0 && !isDev) {
      tasks.push({ type: 'ssg', config: {}, routes: ssgRoutes });
    }

    return tasks;
  }

  /**
   * 增强 Webpack 配置：添加框架内置插件
   *
   * 在原始 Webpack 配置的基础上注入 Nami 框架内置的 Webpack 插件：
   * - 所有构建：添加进度条插件（显示构建进度）
   * - 客户端构建额外添加：
   *   - NamiManifestPlugin：生成资源清单，供服务端渲染时引用正确的 JS/CSS 路径
   *   - NamiHtmlInjectPlugin：为 CSR 路由生成 HTML 模板（仅当存在 CSR 路由时）
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
      // CSR 模式需要 HTML 模板
      const hasCSR = this.config.routes.some((route: NamiRoute) => route.renderMode === RenderMode.CSR);
      if (hasCSR) {
        plugins.push(
          new NamiHtmlInjectPlugin({
            title: this.config.title || this.config.appName,
          }),
        );
      }
    }

    return { ...config, plugins };
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
            errors.push(...info.errors.map((error: string | { message?: string }) => (
              typeof error === 'string' ? error : (error.message ?? 'Unknown webpack error')
            )));
          }
          if (info.warnings) {
            warnings.push(...info.warnings.map((warning: string | { message?: string }) => (
              typeof warning === 'string' ? warning : (warning.message ?? 'Unknown webpack warning')
            )));
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
   * 执行 SSG 静态页面生成
   *
   * 在 Client/Server Webpack 编译完成后执行，从 server bundle 中加载页面模块，
   * 遍历所有 SSG/ISR 路由执行数据预取和 HTML 渲染，将结果写入 dist/static/ 目录。
   *
   * 渲染策略（按优先级）：
   * 1. serverBundle.renderToHTML() — server bundle 导出的统一渲染入口（推荐）
   * 2. pageModule.render() / pageModule.default() — 页面级渲染函数
   * 3. 兜底 HTML Shell — 仅包含数据注入和客户端 JS 引用，由客户端完成渲染
   *
   * 对于动态路由（路径含 :param），需要 getStaticPaths 提供预生成的参数列表。
   *
   * @param routes - 需要静态生成的路由列表
   */
  private async generateStaticPages(routes: NamiRoute[]): Promise<void> {
    logger.info(`开始静态页面生成，共 ${routes.length} 个路由...`);

    const serverBundlePath = path.resolve(this.projectRoot, this.config.outDir, 'server', 'entry-server.js');
    const staticOutputDir = path.resolve(this.projectRoot, this.config.outDir, 'static');

    // 确保输出目录存在
    fs.mkdirSync(staticOutputDir, { recursive: true });

    // 加载 Server Bundle
    if (!fs.existsSync(serverBundlePath)) {
      logger.warn('Server Bundle 不存在，跳过 SSG 生成');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const serverBundle = require(serverBundlePath);
    const moduleManifest = this.buildModuleManifest();
    const moduleLoader = new ModuleLoader({
      serverBundlePath,
      moduleManifest,
    });

    const resolvePageModule = async (route: NamiRoute): Promise<Record<string, unknown>> => {
      const loadedModule = await moduleLoader.loadModule(route.component);

      if (Object.keys(loadedModule).length > 0) {
        return loadedModule;
      }

      const manifestPath = moduleManifest[route.component];
      if (manifestPath) {
        const absolutePageModulePath = path.resolve(path.dirname(serverBundlePath), manifestPath);
        if (fs.existsSync(absolutePageModulePath)) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const pageModule = require(absolutePageModulePath) as Record<string, unknown>;
          return pageModule;
        }
      }

      // 兜底：直接使用 serverBundle（单页面场景）
      return serverBundle;
    };

    let generatedCount = 0;

    for (const route of routes) {
      try {
        logger.debug(`生成静态页面: ${route.path}`);

        const pageModule = await resolvePageModule(route);

        // 获取 getStaticPaths（动态路由需要）
        let paths: Array<{ params: Record<string, string> }> = [{ params: {} }];
        const isDynamicRoute = route.path.includes(':');

        if (isDynamicRoute && route.getStaticPaths) {
          const getStaticPathsFn = await moduleLoader.getExportedFunction<
            () => Promise<{ paths?: Array<{ params: Record<string, string> }> }>
          >(route.component, route.getStaticPaths);
          if (typeof getStaticPathsFn === 'function') {
            const staticPathsResult = await getStaticPathsFn();
            paths = staticPathsResult.paths || [];
          } else {
            logger.warn(`getStaticPaths 函数 "${route.getStaticPaths}" 未找到，跳过动态路由`, {
              route: route.path,
              availableExports: Object.keys(pageModule),
            });
            continue;
          }
        }

        // 对每个路径执行数据预取和渲染
        for (const pathConfig of paths) {
          // 执行 getStaticProps
          let props: Record<string, unknown> = {};
          if (route.getStaticProps) {
            const getStaticPropsFn = await moduleLoader.getExportedFunction<
              (context: { params: Record<string, string> }) => Promise<{ props?: Record<string, unknown> }>
            >(route.component, route.getStaticProps);
            if (typeof getStaticPropsFn === 'function') {
              const result = await getStaticPropsFn({
                params: pathConfig.params,
              });
              props = result.props || {};
            }
          }

          // 生成实际路径
          let actualPath = route.path;
          for (const [key, value] of Object.entries(pathConfig.params)) {
            actualPath = actualPath.replace(`:${key}`, value);
          }

          /**
           * 渲染 HTML — 支持三种 server bundle 导出格式
           *
           * 不同的项目结构会产生不同的 server bundle 导出格式，
           * 框架按优先级依次尝试以下三种渲染策略：
           */
          let html: string | null = null;

          if (typeof serverBundle.renderToHTML === 'function') {
            // 策略 1：server bundle 导出了统一的 renderToHTML 入口函数
            // 这是推荐的方式，entry-server.ts 中导出 renderToHTML(path, props) => html
            html = await serverBundle.renderToHTML(actualPath, props);
          } else if (typeof pageModule.default === 'function' || typeof pageModule.render === 'function') {
            // 策略 2：页面模块自身导出了 render 函数或 default 组件渲染函数
            // 适用于每个页面模块自包含渲染逻辑的场景
            const renderFn = (pageModule.render || pageModule.default) as Function;
            html = await renderFn({ path: actualPath, props });
          } else {
            // 策略 3：兜底 — 生成最小化的 HTML Shell
            // 仅包含数据注入（window.__NAMI_DATA__）和客户端 JS 引用，
            // 实际渲染由客户端 JS 接管（等同于带预取数据的 CSR）
            const title = (route.meta?.title as string) || this.config.title || this.config.appName;
            const publicPath = this.config.assets.publicPath;
            html = [
              '<!DOCTYPE html>',
              '<html lang="zh-CN">',
              '<head>',
              `  <meta charset="utf-8">`,
              `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
              `  <title>${title}</title>`,
              '  <meta name="renderer" content="ssg">',
              `  <link rel="stylesheet" href="${publicPath}static/css/main.css">`,
              '</head>',
              '<body>',
              '  <div id="nami-root"></div>',
              `  <script>window.__NAMI_DATA__ = ${JSON.stringify(props).replace(/</g, '\\u003c')}</script>`,
              `  <script defer src="${publicPath}static/js/main.js"></script>`,
              '</body>',
              '</html>',
            ].join('\n');
          }

          if (html) {
            // 写入文件
            const outputPath = path.join(
              staticOutputDir,
              actualPath === '/' ? 'index.html' : `${actualPath}/index.html`,
            );
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, html, 'utf-8');
            generatedCount++;

            logger.debug(`已生成: ${outputPath}`);
          }
        }
      } catch (error) {
        const err = error as Error;
        logger.error(`静态页面生成失败 [${route.path}]: ${err.message}`);
      }
    }

    logger.info(`静态页面生成完成，共生成 ${generatedCount} 个页面`);
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
      this.projectRoot,
      this.config.outDir,
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
          .filter((componentPath: unknown): componentPath is string => (
            typeof componentPath === 'string' && componentPath.length > 0
          )),
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
