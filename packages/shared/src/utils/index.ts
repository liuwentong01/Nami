/**
 * @nami/shared - 工具函数导出入口
 */

export { Logger, LogLevel, createLogger } from './logger';
export type { LogAdapter } from './logger';

export { isServer, isClient, isDev, isProd, isTest, getEnv } from './env';

export { contentHash, sha256, generateETag, generateCacheKey } from './hash';

export {
  normalizePath,
  resolveAbsolute,
  extractPathname,
  componentPathToKey,
  withPublicPath,
} from './path';

export { safeStringify, generateDataScript, hydrateData } from './serialize';

export { Timer, createTimer, measureAsync } from './timer';

export { deepMerge, deepMergeAll } from './deep-merge';
