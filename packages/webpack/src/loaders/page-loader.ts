/**
 * @nami/webpack - 页面 Loader
 *
 * 用于处理页面组件文件，自动注入框架所需的运行时代码：
 * - 包裹页面组件为路由组件
 * - 注入数据预取函数引用
 * - 注入渲染模式标识
 *
 * 此 Loader 主要在客户端构建时使用，为每个页面组件
 * 添加必要的运行时绑定。
 */

import type { LoaderContext } from 'webpack';

/**
 * Page Loader 选项
 */
export interface PageLoaderOptions {
  /** 该页面的渲染模式 */
  renderMode?: string;
  /** 是否有 getServerSideProps */
  hasServerSideProps?: boolean;
  /** 是否有 getStaticProps */
  hasStaticProps?: boolean;
}

/**
 * Nami 页面 Loader
 *
 * 对页面组件的源码进行转换，添加框架所需的元信息。
 * 转换后的代码会在原始导出基础上追加 __namiPageMeta 属性。
 *
 * 输入:
 * ```tsx
 * export default function HomePage() { return <div>Home</div> }
 * export async function getServerSideProps() { ... }
 * ```
 *
 * 输出:
 * ```tsx
 * export default function HomePage() { return <div>Home</div> }
 * export async function getServerSideProps() { ... }
 * // Nami 框架注入的页面元信息
 * if (typeof HomePage !== 'undefined') {
 *   HomePage.__namiPageMeta = { renderMode: 'ssr', hasServerSideProps: true };
 * }
 * ```
 */
export default function pageLoader(this: LoaderContext<PageLoaderOptions>, source: string): string {
  const options = this.getOptions();

  // 检测源码中是否导出了数据预取函数
  const hasGetServerSideProps =
    options.hasServerSideProps || /export\s+(async\s+)?function\s+getServerSideProps/.test(source);
  const hasGetStaticProps =
    options.hasStaticProps || /export\s+(async\s+)?function\s+getStaticProps/.test(source);
  const hasGetStaticPaths = /export\s+(async\s+)?function\s+getStaticPaths/.test(source);

  // 构建页面元信息
  const meta = {
    renderMode: options.renderMode || 'csr',
    hasGetServerSideProps,
    hasGetStaticProps,
    hasGetStaticPaths,
  };

  // 在源码末尾追加元信息注入代码
  const injection = `
// ===== Nami 框架自动注入 =====
// 页面元信息，用于运行时路由匹配和数据预取
export const __namiPageMeta = ${JSON.stringify(meta)};
`;

  return source + injection;
}
