/**
 * @nami/shared - 哈希工具
 *
 * 提供内容哈希生成能力，用于：
 * - 缓存键生成
 * - 资源指纹
 * - ETag 计算
 */

import { createHash } from 'crypto';

/**
 * 生成内容的 MD5 哈希（短格式，取前 8 位）
 *
 * @param content - 要哈希的内容
 * @returns 8 位十六进制哈希字符串
 */
export function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 8);
}

/**
 * 生成内容的完整 SHA256 哈希
 *
 * @param content - 要哈希的内容
 * @returns 完整的 SHA256 十六进制哈希字符串
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 生成 ETag 值
 * 格式: W/"长度-哈希" （弱验证 ETag）
 *
 * @param content - 响应内容
 * @returns ETag 字符串
 */
export function generateETag(content: string): string {
  const hash = contentHash(content);
  const length = Buffer.byteLength(content, 'utf-8');
  return `W/"${length}-${hash}"`;
}

/**
 * 生成缓存键
 * 将 URL 和可选的变体因素组合成唯一缓存键
 *
 * @param url - 请求 URL
 * @param vary - 影响缓存变体的因素（如 Accept-Language）
 * @returns 缓存键字符串
 */
export function generateCacheKey(url: string, vary?: Record<string, string>): string {
  let key = url;
  if (vary && Object.keys(vary).length > 0) {
    const sortedVary = Object.keys(vary)
      .sort()
      .map((k) => `${k}=${vary[k]}`)
      .join('&');
    key = `${url}?__vary=${sortedVary}`;
  }
  return contentHash(key);
}
