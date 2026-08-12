/**
 * ISR 缓存只保存可以安全重放的端到端响应头。
 *
 * hop-by-hop 头只属于某一次网络连接；Content-Length / Content-Encoding 则可能
 * 对应压缩前后的另一份字节流；Set-Cookie 绝不能从一个缓存条目重放给其他请求。
 * Cache-Control、ETag 与缓存命中状态由 ISR 层按当前条目重新生成。
 */
const EXCLUDED_CACHED_RESPONSE_HEADERS = new Set([
  'age',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'etag',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-nami-cache',
  'x-nami-cache-age',
]);

export function sanitizeCachedResponseHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && !EXCLUDED_CACHED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      sanitized[name] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}
