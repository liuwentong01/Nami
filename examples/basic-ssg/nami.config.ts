/**
 * Nami 框架配置文件 — SSG（静态站点生成）模式
 *
 * SSG 模式说明：
 * - 在构建阶段（nami build / nami generate）预渲染所有页面为静态 HTML 文件
 * - 构建完成后，产物是纯静态文件（HTML + CSS + JS），可部署到任意静态托管服务
 * - getStaticProps 在构建时执行，获取页面数据并注入到 HTML 中
 * - getStaticPaths 为动态路由生成所有需要预渲染的路径列表
 * - 优点：响应速度极快（直接返回静态文件）、可使用 CDN 加速、服务端零压力
 * - 缺点：内容更新需要重新构建、不适合频繁变动的数据
 *
 * 适用场景：博客、文档站、营销着陆页、公司官网等内容相对稳定的站点。
 *
 * @see https://nami.dev/docs/config
 */
import { defineConfig } from '@nami/core';
import { createRuntimeConfig } from './src/runtime-config';

/** CLI/构建端入口；浏览器只读取 client-safe 的 runtime-config。 */
export default defineConfig(createRuntimeConfig());
