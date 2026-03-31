/**
 * @nami/webpack - 自定义 Webpack 插件导出入口
 */

export { NamiManifestPlugin } from './manifest-plugin';
export type { AssetManifest, ManifestPluginOptions } from './manifest-plugin';

export { NamiRouteCollectPlugin } from './route-collect-plugin';
export type { RouteCollectPluginOptions } from './route-collect-plugin';

export { NamiSSRExternalsPlugin } from './ssr-externals-plugin';
export type { SSRExternalsPluginOptions } from './ssr-externals-plugin';

export { createProgressPlugin } from './progress-plugin';
export type { ProgressPluginOptions } from './progress-plugin';

export { NamiHtmlInjectPlugin } from './html-inject-plugin';
export type { HtmlInjectPluginOptions } from './html-inject-plugin';
