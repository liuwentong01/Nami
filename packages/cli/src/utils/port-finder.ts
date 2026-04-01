/**
 * @nami/cli - 端口检测工具
 *
 * 检测指定端口是否可用，如不可用则自动查找可用端口。
 *
 * 历史实现直接依赖 `detect-port`。但在部分沙箱/容器环境里，
 * 该库内部读取网卡信息时可能抛出系统级异常，导致 `nami dev/start`
 * 在端口其实可用时也无法启动。
 *
 * 因此这里改为使用 Node 原生 `net` 做本地端口探测：
 * - 不依赖网卡枚举
 * - 只验证当前进程是否能绑定该端口
 * - 行为更贴近 CLI 实际需要
 */

import net from 'net';

/**
 * 查找可用端口
 *
 * 如果指定端口被占用，自动查找下一个可用端口。
 *
 * @param preferredPort - 优先使用的端口
 * @returns 可用的端口号
 */
export async function findAvailablePort(preferredPort: number): Promise<number> {
  let currentPort = preferredPort;

  while (await isPortInUse(currentPort)) {
    currentPort += 1;
  }

  return currentPort;
}

/**
 * 检查端口是否被占用
 *
 * @param port - 要检查的端口
 * @returns 端口是否被占用
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();

    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(true);
        return;
      }
      reject(error);
    });

    server.once('listening', () => {
      server.close((closeError?: Error) => {
        cleanup();
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(false);
      });
    });

    server.listen(port, '127.0.0.1');
  });
}
