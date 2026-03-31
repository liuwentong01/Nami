/**
 * @nami/cli - 端口检测工具
 *
 * 检测指定端口是否可用，如不可用则自动查找可用端口。
 */

import detect from 'detect-port';

/**
 * 查找可用端口
 *
 * 如果指定端口被占用，自动查找下一个可用端口。
 *
 * @param preferredPort - 优先使用的端口
 * @returns 可用的端口号
 */
export async function findAvailablePort(preferredPort: number): Promise<number> {
  const availablePort = await detect(preferredPort);
  return availablePort;
}

/**
 * 检查端口是否被占用
 *
 * @param port - 要检查的端口
 * @returns 端口是否被占用
 */
export async function isPortInUse(port: number): Promise<boolean> {
  const availablePort = await detect(port);
  return availablePort !== port;
}
