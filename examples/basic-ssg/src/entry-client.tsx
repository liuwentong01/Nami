/** SSG 客户端入口：读取构建期注水数据，并在静态 DOM 上执行 Hydration。 */
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
