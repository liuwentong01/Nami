/**
 * @nami/webpack - 数据预取 Loader
 *
 * 在客户端构建时，将 getServerSideProps 和 getStaticProps
 * 等仅服务端使用的数据预取函数从 Bundle 中移除。
 *
 * 这些函数可能包含服务端专用的逻辑（数据库访问、内部 API 调用等），
 * 不应该打包到客户端代码中，否则可能：
 * - 泄露服务端密钥和内部 API 地址
 * - 增加客户端 Bundle 体积
 * - 引入 Node.js 专用模块导致编译错误
 *
 * 此 Loader 的作用是在客户端构建时将这些函数替换为空函数或完全移除。
 */

import type { LoaderContext } from 'webpack';

/**
 * Data Fetch Loader 选项
 */
export interface DataFetchLoaderOptions {
  /** 是否为服务端构建（服务端保留这些函数） */
  isServer?: boolean;
}

/**
 * 需要在客户端移除的导出函数名
 */
const SERVER_ONLY_EXPORTS = [
  'getServerSideProps',
  'getStaticProps',
  'getStaticPaths',
];

/**
 * Nami 数据预取函数分离 Loader
 *
 * 客户端构建时：
 * - 检测源码中的 getServerSideProps / getStaticProps / getStaticPaths 导出
 * - 将这些函数替换为空实现
 * - 保留函数签名（不影响类型检查）但移除函数体
 *
 * 服务端构建时：不做任何转换
 */
export default function dataFetchLoader(
  this: LoaderContext<DataFetchLoaderOptions>,
  source: string,
): string {
  const options = this.getOptions();

  // 服务端构建：保留原始代码
  if (options.isServer) {
    return source;
  }

  let result = source;

  for (const fnName of SERVER_ONLY_EXPORTS) {
    // 匹配 export async function getServerSideProps(...) { ... }
    // 以及 export function getStaticProps(...) { ... }
    const asyncPattern = new RegExp(
      `export\\s+async\\s+function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}`,
      'g',
    );
    const syncPattern = new RegExp(
      `export\\s+function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}`,
      'g',
    );

    // 替换为空函数（保留导出以避免编译警告）
    const replacement = `export async function ${fnName}() { return { props: {} }; }`;

    result = result.replace(asyncPattern, replacement);
    result = result.replace(syncPattern, replacement);
  }

  return result;
}
