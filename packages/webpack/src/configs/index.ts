/**
 * @nami/webpack - 构建配置导出入口
 */

export { createBaseConfig } from './base.config';
export type { BaseConfigOptions } from './base.config';

export { createClientConfig } from './client.config';
export type { ClientConfigOptions } from './client.config';

export { createServerConfig } from './server.config';
export type { ServerConfigOptions } from './server.config';

export { createSSGConfig } from './ssg.config';
export type { SSGConfigOptions } from './ssg.config';

export { createDevClientConfig, createDevServerConfig } from './dev.config';
export type { DevConfigOptions } from './dev.config';
