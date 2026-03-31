/**
 * @nami/shared - 路径处理工具
 *
 * 提供路径规范化和处理能力。
 */

import path from 'path';

/**
 * 规范化 URL 路径
 * 确保路径以 / 开头，去除尾部 /（根路径除外），去除多余 /
 *
 * @param urlPath - 原始路径
 * @returns 规范化后的路径
 *
 * @example
 * ```typescript
 * normalizePath('user/profile/') // '/user/profile'
 * normalizePath('//a///b//') // '/a/b'
 * normalizePath('') // '/'
 * ```
 */
export function normalizePath(urlPath: string): string {
  // 替换多个连续 / 为单个 /
  let normalized = ('/' + urlPath).replace(/\/+/g, '/');
  // 去除尾部 /（根路径除外）
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * 将相对路径解析为绝对路径
 *
 * @param basePath - 基准目录
 * @param relativePath - 相对路径
 * @returns 绝对路径
 */
export function resolveAbsolute(basePath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.resolve(basePath, relativePath);
}

/**
 * 从 URL 路径中提取纯路径部分（不含查询参数和哈希）
 *
 * @param url - 完整 URL 或路径
 * @returns 纯路径部分
 */
export function extractPathname(url: string): string {
  const queryIndex = url.indexOf('?');
  const hashIndex = url.indexOf('#');
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (hashIndex !== -1) end = Math.min(end, hashIndex);
  return url.slice(0, end);
}

/**
 * 将页面组件路径转换为路由缓存键
 * 例: './pages/user/[id]' -> 'pages-user-[id]'
 */
export function componentPathToKey(componentPath: string): string {
  return componentPath
    .replace(/^\.\//, '')
    .replace(/\.(tsx?|jsx?)$/, '')
    .replace(/\//g, '-');
}

/**
 * 确保路径以 publicPath 为前缀
 */
export function withPublicPath(assetPath: string, publicPath: string): string {
  const normalizedPublic = publicPath.endsWith('/') ? publicPath : publicPath + '/';
  const normalizedAsset = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
  return normalizedPublic + normalizedAsset;
}
