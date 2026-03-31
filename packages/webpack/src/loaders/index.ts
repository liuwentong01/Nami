/**
 * @nami/webpack - Loader 导出入口
 *
 * 注意：Webpack Loader 需要通过文件路径引用，不能通过包名导入。
 * 此文件仅用于类型导出和文档目的。
 *
 * 使用方式：
 * ```javascript
 * {
 *   loader: require.resolve('@nami/webpack/dist/loaders/page-loader'),
 *   options: { renderMode: 'ssr' }
 * }
 * ```
 */

export type { PageLoaderOptions } from './page-loader';
export type { DataFetchLoaderOptions } from './data-fetch-loader';
