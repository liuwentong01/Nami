/** ISR 客户端入口：HIT/STALE/MISS 返回的 HTML 均使用同一 App 外壳 Hydration。 */
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
