/**
 * @nami/shared - 渲染上下文类型定义
 *
 * RenderContext 是贯穿整个渲染流程的核心数据结构，
 * 从请求到达到响应返回，所有中间件和钩子都可以访问和修改它。
 */

import type { RenderMode } from './render-mode';
import type { NamiRoute } from './route';

/**
 * Koa 上下文安全子集
 *
 * 仅暴露 Koa Context 中安全的、不影响服务稳定性的属性。
 * 防止插件或业务代码通过渲染上下文直接操作底层 HTTP 对象。
 */
export interface KoaContextSubset {
  /** 请求方法 */
  method: string;
  /** 请求路径 */
  path: string;
  /** 完整 URL */
  url: string;
  /** 查询字符串（不含 ?） */
  querystring: string;
  /** 请求协议 */
  protocol: string;
  /** 客户端 IP */
  ip: string;
  /** 请求来源 */
  origin: string;
  /** 主机名 */
  hostname: string;
  /** 是否 HTTPS */
  secure: boolean;
  /** Cookie 对象 */
  cookies: Record<string, string>;
}

/**
 * 渲染性能计时
 * 记录渲染流程中各阶段的耗时，用于性能监控
 */
export interface RenderTiming {
  /** 渲染开始时间戳（毫秒） */
  startTime: number;
  /** 数据预取开始时间 */
  dataFetchStart?: number;
  /** 数据预取结束时间 */
  dataFetchEnd?: number;
  /** React 渲染开始时间 */
  renderStart?: number;
  /** React 渲染结束时间 */
  renderEnd?: number;
  /** HTML 组装结束时间 */
  htmlEnd?: number;
  /** 总耗时（毫秒） */
  duration?: number;
}

/**
 * 渲染上下文
 *
 * 贯穿整个渲染流程的核心数据结构，包含：
 * - 请求信息（URL、路径、查询参数、请求头）
 * - 路由信息（匹配到的路由配置、动态参数）
 * - 数据（服务端预取数据）
 * - Koa 上下文子集（仅 SSR 模式下可用）
 * - 性能计时信息
 */
export interface RenderContext {
  /** 完整请求 URL */
  url: string;

  /** 请求路径（不含查询参数） */
  path: string;

  /** 查询参数 */
  query: Record<string, string | string[]>;

  /** 请求头（小写键名） */
  headers: Record<string, string | string[] | undefined>;

  /** 匹配到的路由配置 */
  route: NamiRoute;

  /** 路由动态参数 */
  params: Record<string, string>;

  /**
   * Koa 上下文安全子集
   * 仅在 SSR 模式下可用，CSR/SSG 时为 undefined
   */
  koaContext?: KoaContextSubset;

  /**
   * 服务端预取数据
   * 由 getServerSideProps / getStaticProps 返回的数据
   * 将被序列化注入到 HTML 中，客户端通过 window.__NAMI_DATA__ 访问
   */
  initialData?: Record<string, unknown>;

  /** 渲染性能计时 */
  timing: RenderTiming;

  /** 请求唯一标识（用于日志追踪和链路跟踪） */
  requestId: string;

  /** 用户自定义扩展数据（插件可自由写入） */
  extra: Record<string, unknown>;
}

/**
 * 渲染结果
 *
 * 所有渲染器（CSR/SSR/SSG/ISR）的统一输出格式。
 * 包含渲染产出的 HTML、HTTP 状态码、响应头、缓存控制和渲染元信息。
 */
export interface RenderResult {
  /** 渲染产出的 HTML 字符串 */
  html: string;

  /** HTTP 响应状态码 */
  statusCode: number;

  /** 自定义 HTTP 响应头 */
  headers: Record<string, string>;

  /**
   * 缓存控制（ISR 模式下由 ISRManager 使用）
   */
  cacheControl?: {
    /** 重验证间隔（秒） */
    revalidate: number;
    /** 过期后仍可返回旧内容的宽限期（秒） */
    staleWhileRevalidate?: number;
    /** 缓存标签（用于按标签批量失效） */
    tags?: string[];
  };

  /**
   * 渲染元信息
   * 用于监控、日志和调试
   */
  meta: RenderMeta;
}

/**
 * 渲染元信息
 */
export interface RenderMeta {
  /** 实际使用的渲染模式 */
  renderMode: RenderMode;
  /** 渲染总耗时（毫秒） */
  duration: number;
  /** 是否经历了降级处理 */
  degraded: boolean;
  /** 降级原因（如果发生了降级） */
  degradeReason?: string;
  /** 数据预取耗时（毫秒） */
  dataFetchDuration: number;
  /** React 渲染耗时（毫秒） */
  renderDuration?: number;
  /** 是否命中缓存（ISR） */
  cacheHit?: boolean;
  /** 缓存是否过期（ISR stale-while-revalidate） */
  cacheStale?: boolean;
}

/**
 * 客户端初始化选项
 * 客户端入口 initNamiClient 的参数
 */
export interface ClientOptions {
  /** 路由配置列表 */
  routes: NamiRoute[];
  /** 插件列表 */
  plugins: Array<import('./plugin').NamiPlugin>;
  /** 框架配置 */
  config: import('./config').NamiConfig;
  /** 挂载容器元素 ID */
  containerId?: string;
}
