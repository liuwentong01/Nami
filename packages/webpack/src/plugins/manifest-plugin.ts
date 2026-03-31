/**
 * @nami/webpack - 资源清单生成插件
 *
 * 在构建完成后生成 asset-manifest.json，记录每个入口和 Chunk 对应的实际文件名。
 * 服务端渲染时通过读取此清单来注入正确的 <script> 和 <link> 标签。
 *
 * 清单格式：
 * ```json
 * {
 *   "files": {
 *     "main.js": "/static/js/main.abc12345.js",
 *     "main.css": "/static/css/main.def67890.css",
 *     "vendor-react.js": "/static/js/vendor-react.hij11111.js",
 *     "runtime.js": "/static/js/runtime.klm22222.js"
 *   },
 *   "entrypoints": ["runtime.js", "vendor-react.js", "main.js"]
 * }
 * ```
 */

import type { Compiler, Compilation } from 'webpack';
import path from 'path';

/**
 * 资源清单数据结构
 */
export interface AssetManifest {
  /** 逻辑名称到实际文件路径的映射 */
  files: Record<string, string>;
  /** 入口文件列表（按加载顺序排列） */
  entrypoints: string[];
}

/**
 * 资源清单插件选项
 */
export interface ManifestPluginOptions {
  /** 清单文件名，默认 'asset-manifest.json' */
  filename?: string;
}

/**
 * Nami 资源清单 Webpack 插件
 */
export class NamiManifestPlugin {
  private filename: string;

  constructor(options: ManifestPluginOptions = {}) {
    this.filename = options.filename || 'asset-manifest.json';
  }

  apply(compiler: Compiler): void {
    compiler.hooks.emit.tapAsync('NamiManifestPlugin', (compilation: Compilation, callback) => {
      const manifest: AssetManifest = {
        files: {},
        entrypoints: [],
      };

      const publicPath = compilation.outputOptions.publicPath || '/';

      // 收集所有资源文件
      for (const [name, source] of Object.entries(compilation.assets)) {
        // 跳过 Source Map 文件
        if (name.endsWith('.map')) continue;

        // 确定逻辑名称（去除 hash 部分）
        const logicalName = name
          .replace(/\.[a-f0-9]{8}\./, '.')
          .replace(/^static\/(js|css)\//, '');

        manifest.files[logicalName] = `${publicPath}${name}`.replace(/\/\//g, '/');
      }

      // 收集入口文件（按加载顺序）
      for (const [entryName, entrypoint] of compilation.entrypoints) {
        const files = entrypoint.getFiles().filter((f: string) => !f.endsWith('.map'));
        for (const file of files) {
          const fullPath = `${publicPath}${file}`.replace(/\/\//g, '/');
          if (!manifest.entrypoints.includes(fullPath)) {
            manifest.entrypoints.push(fullPath);
          }
        }
      }

      // 将清单写入输出
      const manifestJson = JSON.stringify(manifest, null, 2);
      compilation.assets[this.filename] = {
        source: () => manifestJson,
        size: () => Buffer.byteLength(manifestJson),
      } as any;

      callback();
    });
  }
}
