/**
 * Nami 框架配置文件 — ISR（增量静态再生）模式
 *
 * ISR 模式说明：
 * - 基于 SSG 的基础上增加了"按需重验证"能力
 * - 首次构建时预渲染页面为静态 HTML（同 SSG）
 * - 每个页面可配置 revalidate 间隔（秒），过期后：
 *   1. 当前请求仍返回旧的缓存页面（stale）
 *   2. 后台异步触发重新渲染（revalidate）
 *   3. 新页面生成后替换缓存，后续请求获取新内容
 * - 这就是 "stale-while-revalidate" 策略
 *
 * 优点：
 * - 兼具 SSG 的极速响应和 SSR 的内容时效性
 * - 无需全量重建即可更新单个页面
 * - 服务端压力远低于 SSR（大部分请求命中缓存）
 *
 * 缺点：
 * - 需要 Node.js 服务端运行时（不能纯静态部署）
 * - 过期窗口期内用户可能看到旧内容
 *
 * 适用场景：电商商品页、新闻资讯、内容平台等需要兼顾性能和时效性的场景。
 *
 * @see https://nami.dev/docs/config
 */
import { defineConfig } from '@nami/core';
import { createRuntimeConfig } from './src/runtime-config';

/** CLI/构建端入口；浏览器只读取 client-safe 的 runtime-config。 */
export default defineConfig(createRuntimeConfig());
