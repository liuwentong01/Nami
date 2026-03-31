/**
 * @nami/webpack - 路由收集插件
 *
 * 在编译阶段自动扫描页面文件，收集路由信息，
 * 生成路由清单供运行时使用。
 *
 * 支持约定式路由（基于文件系统）和配置式路由。
 */

import type { Compiler } from 'webpack';
import path from 'path';
import fs from 'fs';

/**
 * 路由收集插件选项
 */
export interface RouteCollectPluginOptions {
  /** 页面目录路径 */
  pagesDir: string;
  /** 输出的路由清单文件名 */
  outputFilename?: string;
}

/**
 * 收集到的路由信息
 */
interface CollectedRoute {
  /** 路由路径 */
  path: string;
  /** 组件文件路径 */
  componentPath: string;
  /** 是否为动态路由 */
  isDynamic: boolean;
}

/**
 * Nami 路由收集 Webpack 插件
 *
 * 扫描 pages/ 目录，按文件结构生成路由配置。
 * 文件命名约定：
 * - pages/index.tsx       -> /
 * - pages/about.tsx       -> /about
 * - pages/user/[id].tsx   -> /user/:id
 * - pages/[...slug].tsx   -> /*
 */
export class NamiRouteCollectPlugin {
  private pagesDir: string;
  private outputFilename: string;

  constructor(options: RouteCollectPluginOptions) {
    this.pagesDir = options.pagesDir;
    this.outputFilename = options.outputFilename || 'routes-manifest.json';
  }

  apply(compiler: Compiler): void {
    compiler.hooks.beforeCompile.tapAsync(
      'NamiRouteCollectPlugin',
      (_params, callback) => {
        try {
          const routes = this.scanPages(this.pagesDir);
          // 将路由信息存储到编译上下文中，供其他插件使用
          (compiler as any).__namiRoutes = routes;
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    );
  }

  /**
   * 递归扫描页面目录
   */
  private scanPages(dir: string, prefix: string = ''): CollectedRoute[] {
    if (!fs.existsSync(dir)) return [];

    const routes: CollectedRoute[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // 跳过非页面文件
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 递归扫描子目录
        const subRoutes = this.scanPages(fullPath, `${prefix}/${entry.name}`);
        routes.push(...subRoutes);
      } else if (this.isPageFile(entry.name)) {
        const route = this.fileToRoute(entry.name, prefix, fullPath);
        if (route) routes.push(route);
      }
    }

    return routes;
  }

  /**
   * 判断文件是否为页面文件
   */
  private isPageFile(filename: string): boolean {
    return /\.(tsx?|jsx?)$/.test(filename) && !filename.includes('.test.') && !filename.includes('.spec.');
  }

  /**
   * 将文件名转换为路由配置
   */
  private fileToRoute(filename: string, prefix: string, fullPath: string): CollectedRoute | null {
    // 去除扩展名
    const name = filename.replace(/\.(tsx?|jsx?)$/, '');

    let routePath: string;
    let isDynamic = false;

    if (name === 'index') {
      routePath = prefix || '/';
    } else if (name.startsWith('[...') && name.endsWith(']')) {
      // Catch-all 路由: [...slug] -> *
      routePath = `${prefix}/*`;
      isDynamic = true;
    } else if (name.startsWith('[') && name.endsWith(']')) {
      // 动态路由: [id] -> :id
      const param = name.slice(1, -1);
      routePath = `${prefix}/:${param}`;
      isDynamic = true;
    } else {
      routePath = `${prefix}/${name}`;
    }

    return {
      path: routePath,
      componentPath: fullPath,
      isDynamic,
    };
  }
}
