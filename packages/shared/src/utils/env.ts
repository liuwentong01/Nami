/**
 * @nami/shared - 环境检测工具
 *
 * 提供运行环境判断能力，用于同构代码中的环境分支。
 */

/**
 * 判断当前是否在服务端（Node.js）环境
 */
export function isServer(): boolean {
  return typeof window === 'undefined';
}

/**
 * 判断当前是否在客户端（浏览器）环境
 */
export function isClient(): boolean {
  return typeof window !== 'undefined';
}

/**
 * 判断当前是否为开发模式
 */
export function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * 判断当前是否为生产模式
 */
export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * 判断当前是否为测试模式
 */
export function isTest(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * 获取当前运行环境标识
 */
export function getEnv(): 'development' | 'production' | 'test' {
  const env = process.env.NODE_ENV;
  if (env === 'production') return 'production';
  if (env === 'test') return 'test';
  return 'development';
}
