/**
 * Nami 框架配置文件 — CSR（客户端渲染）模式
 *
 * CSR 模式说明：
 * - 服务端返回带临时骨架的 CSR Shell，并继续注入客户端 JS/CSS
 * - 浏览器下载 JS 后，由 React 在客户端执行完整渲染并替换临时骨架
 * - 首屏真实内容仍需等待 JS 下载和执行，适合对 SEO 无要求的后台管理类系统
 * - 优点：部署简单、服务端压力小、交互响应快
 * - 缺点：真实内容首屏较慢、不利于 SEO
 *
 * @see https://nami.dev/docs/config
 */
import { defineConfig } from '@nami/core';
import { createRuntimeConfig } from './src/runtime-config';

/** CLI/构建端入口；浏览器只读取 client-safe 的 runtime-config。 */
export default defineConfig(createRuntimeConfig());
