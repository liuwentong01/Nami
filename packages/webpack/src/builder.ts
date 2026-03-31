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
      (r) => r.renderMode === RenderMode.SSR || r.renderMode === RenderMode.ISR,
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
      (r) => r.renderMode === RenderMode.SSG || r.renderMode === RenderMode.ISR,
    );
    if (ssgRoutes.length > 0 && !isDev) {
      tasks.push({ type: 'ssg', config: {}, routes: ssgRoutes });
    }

    return tasks;
  }

  /**
   * 增强 Webpack 配置：添加框架内置插件
   */
  private enhanceConfig(config: Configuration, name: string): Configuration {
    const plugins = [...(config.plugins || [])];

    // 添加进度插件
    plugins.push(createProgressPlugin({ name }));

    // 客户端构建：添加资源清单和 HTML 模板
    if (name === 'client') {
      plugins.push(new NamiManifestPlugin());
      // CSR 模式需要 HTML 模板
      const hasCSR = this.config.routes.some((r) => r.renderMode === RenderMode.CSR);
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
   */
  private runCompilation(
    config: Configuration,
  ): Promise<{ stats: Stats | null; errors: string[]; warnings: string[] }> {
    return new Promise((resolve) => {
      const compiler = webpack(config);

      compiler.run((err, stats) => {
        const errors: string[] = [];
        const warnings: string[] = [];

        if (err) {
          errors.push(err.message);
        }

        if (stats) {
          const info = stats.toJson({ errors: true, warnings: true });
          if (info.errors) {
            errors.push(...info.errors.map((e) => (typeof e === 'string' ? e : e.message)));
          }
          if (info.warnings) {
            warnings.push(...info.warnings.map((w) => (typeof w === 'string' ? w : w.message)));
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
   * 加载 Server Bundle，遍历 SSG 路由，
   * 对每个路由执行 getStaticProps + renderToString。
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

    for (const route of routes) {
      try {
        logger.debug(`生成静态页面: ${route.path}`);

        // 获取 getStaticPaths（动态路由需要）
        let paths: Array<{ params: Record<string, string> }> = [{ params: {} }];

        if (route.getStaticPaths && serverBundle[route.getStaticPaths]) {
          const staticPathsResult = await serverBundle[route.getStaticPaths]();
          paths = staticPathsResult.paths;
        }

        // 对每个路径执行数据预取和渲染
        for (const pathConfig of paths) {
          // 执行 getStaticProps
          let props = {};
          if (route.getStaticProps && serverBundle[route.getStaticProps]) {
            const result = await serverBundle[route.getStaticProps]({
              params: pathConfig.params,
            });
            props = result.props || {};
          }

          // 生成实际路径
          let actualPath = route.path;
          for (const [key, value] of Object.entries(pathConfig.params)) {
            actualPath = actualPath.replace(`:${key}`, value);
          }

          // 渲染 HTML
          if (serverBundle.renderToHTML) {
            const html = await serverBundle.renderToHTML(actualPath, props);

            // 写入文件
            const outputPath = path.join(
              staticOutputDir,
              actualPath === '/' ? 'index.html' : `${actualPath}/index.html`,
            );
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, html, 'utf-8');

            logger.debug(`已生成: ${outputPath}`);
          }
        }
      } catch (error) {
        const err = error as Error;
        logger.error(`静态页面生成失败 [${route.path}]: ${err.message}`);
      }
    }

    logger.info('静态页面生成完成');
  }

  /**
   * 生成框架总清单文件
   *
   * nami-manifest.json 包含路由映射、渲染模式、资源引用等信息，
   * 服务端运行时读取此文件来决定如何处理每个请求。
   */
  private async generateManifest(): Promise<void> {
    const manifest = {
      appName: this.config.appName,
      generatedAt: new Date().toISOString(),
      routes: this.config.routes.map((route) => ({
        path: route.path,
        renderMode: route.renderMode,
        revalidate: route.revalidate,
        fallback: route.fallback,
      })),
      buildInfo: {
        nodeVersion: process.version,
        namiVersion: '0.1.0',
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
}
