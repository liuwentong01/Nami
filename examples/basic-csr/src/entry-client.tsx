/** CSR 客户端入口：NamiApp 负责路由，wrapApp 提供示例应用外壳。 */
import { initNamiClient } from '@nami/client';
import { resolveNamiConfig, type NamiPlugin } from '@nami/shared';
import { createRuntimeConfig } from './runtime-config';
import './global.css';

const config = resolveNamiConfig(createRuntimeConfig());

const clientPlugins = config.plugins.filter(
  (plugin): plugin is NamiPlugin => typeof plugin !== 'string',
);

void initNamiClient({
  routes: config.routes,
  plugins: clientPlugins,
  config,
  containerId: 'nami-root',
});
