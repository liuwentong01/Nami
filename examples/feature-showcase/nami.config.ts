import { defineConfig } from '@nami/core';
import { createRuntimeConfig } from './src/runtime-config';
import { createServerPlugins } from './src/plugins/showcase-plugins';

/**
 * CLI、Webpack 和服务端运行时使用的完整配置。
 *
 * 客户端不会直接复用这个实例，而是重新创建一组 client-safe 插件，
 * 避免把服务端插件状态或未解析的字符串配置带进浏览器。
 */
const config = createRuntimeConfig(createServerPlugins());

export default defineConfig(config);
