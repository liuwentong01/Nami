/**
 * @nami/shared - 渲染模式类型定义
 *
 * 定义框架支持的四种渲染模式及其相关类型。
 * 业务方可根据页面性能诉求灵活选择渲染策略。
 */

/**
 * 渲染模式枚举
 *
 * - CSR: 客户端渲染 — 服务端返回空壳 HTML，由浏览器执行 React 渲染
 * - SSR: 服务端渲染 — 每次请求在服务端执行 renderToString，返回完整 HTML
 * - SSG: 静态站点生成 — 构建时预渲染 HTML 文件，部署后直接返回静态文件
 * - ISR: 增量静态再生 — 基于 SSG + 按需重验证，兼顾性能与内容更新效率
 */
export enum RenderMode {
  /** 客户端渲染 */
  CSR = 'csr',
  /** 服务端渲染 */
  SSR = 'ssr',
  /** 静态站点生成 */
  SSG = 'ssg',
  /** 增量静态再生 */
  ISR = 'isr',
}

/**
 * ISR 降级策略
 *
 * 当 ISR 页面首次被请求且尚未生成时的处理方式：
 * - blocking: 阻塞等待渲染完成后返回（用户等待时间较长但保证看到完整内容）
 * - static:   返回预设的静态降级页面
 * - true:     先返回降级页面，客户端再异步获取完整内容
 * - false:    直接返回 404
 */
export type ISRFallbackStrategy = 'blocking' | 'static' | boolean;

/**
 * 渲染模式配置
 * 用于路由级别的渲染策略配置
 */
export interface RenderModeConfig {
  /** 渲染模式 */
  mode: RenderMode;
  /** ISR 重验证间隔（秒），仅 ISR 模式下有效 */
  revalidate?: number;
  /** ISR 降级策略 */
  fallback?: ISRFallbackStrategy;
}
