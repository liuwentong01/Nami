/**
 * @nami/shared - 路由类型定义
 *
 * 定义框架的路由系统类型，支持：
 * - 静态路由与动态路由（参数化路由如 /user/:id）
 * - 路由级渲染模式配置
 * - 路由级数据预取函数声明
 * - 骨架屏、错误边界等扩展配置
 */

import type { RenderMode, ISRFallbackStrategy } from './render-mode';

/**
 * Nami 路由配置
 *
 * 每个路由条目定义一个页面的完整配置：
 * 包括路径、组件、渲染模式、数据预取、降级策略等
 */
export interface NamiRoute {
  /** 路由路径，支持动态参数如 /user/:id */
  path: string;

  /** 页面组件文件路径（相对于 srcDir） */
  component: string;

  /** 该路由使用的渲染模式，默认继承全局配置 */
  renderMode: RenderMode;

  /**
   * SSR 数据预取函数的导出名称
   * 框架会在服务端渲染前调用该函数获取数据
   * 函数签名: (context: GetServerSidePropsContext) => Promise<GetServerSidePropsResult>
   */
  getServerSideProps?: string;

  /**
   * SSG/ISR 数据预取函数的导出名称
   * 框架会在构建时或 ISR 重验证时调用
   * 函数签名: (context: GetStaticPropsContext) => Promise<GetStaticPropsResult>
   */
  getStaticProps?: string;

  /**
   * SSG 路径生成函数的导出名称
   * 仅对动态路由的 SSG/ISR 模式有效
   * 函数签名: () => Promise<GetStaticPathsResult>
   */
  getStaticPaths?: string;

  /** ISR 重验证间隔（秒），0 表示每次请求都重新验证 */
  revalidate?: number;

  /** ISR 降级策略 */
  fallback?: ISRFallbackStrategy;

  /** 骨架屏组件文件路径 */
  skeleton?: string;

  /** 自定义错误边界组件文件路径 */
  errorBoundary?: string;

  /** 路由元信息，可被插件读取和使用 */
  meta?: Record<string, unknown>;

  /** 子路由（嵌套路由支持） */
  children?: NamiRoute[];

  /**
   * 是否精确匹配
   * 默认 true，设为 false 时前缀匹配即可命中
   */
  exact?: boolean;
}

/**
 * SSR 数据预取上下文
 * 在每次 SSR 请求时传入 getServerSideProps 函数
 */
export interface GetServerSidePropsContext {
  /** 路由动态参数，如 { id: '123' } */
  params: Record<string, string>;
  /** URL 查询参数 */
  query: Record<string, string | string[]>;
  /** 请求头 */
  headers: Record<string, string | string[] | undefined>;
  /** 请求路径 */
  path: string;
  /** 完整 URL */
  url: string;
  /** Cookie 对象 */
  cookies: Record<string, string>;
  /** 本地化语言标识 */
  locale?: string;
  /**
   * 请求唯一标识（用于日志追踪）
   * 由 requestContext 中间件生成
   */
  requestId: string;
}

/**
 * SSR 数据预取结果
 */
export interface GetServerSidePropsResult<P = Record<string, unknown>> {
  /** 注入到页面组件的 props */
  props?: P;
  /** 重定向配置 */
  redirect?: {
    destination: string;
    permanent?: boolean;
    statusCode?: number;
  };
  /** 返回 404 */
  notFound?: boolean;
  /** 自定义响应头 */
  headers?: Record<string, string>;
  /** 缓存控制 */
  cache?: {
    /** 缓存最大时间（秒） */
    maxAge?: number;
    /** 过期后仍可使用的宽限期（秒） */
    staleWhileRevalidate?: number;
  };
}

/**
 * SSG/ISR 数据预取上下文
 * 在构建时或 ISR 重验证时传入 getStaticProps 函数
 */
export interface GetStaticPropsContext {
  /** 路由动态参数 */
  params: Record<string, string>;
  /** 本地化语言标识 */
  locale?: string;
  /** 预览模式数据（CMS 预览场景） */
  preview?: boolean;
  previewData?: unknown;
}

/**
 * SSG/ISR 数据预取结果
 */
export interface GetStaticPropsResult<P = Record<string, unknown>> {
  /** 注入到页面组件的 props */
  props?: P;
  /**
   * ISR 重验证间隔（秒）
   * - 正数: 过期后在后台重新生成
   * - 0: 每次请求都触发重验证
   * - undefined: 不启用 ISR（纯 SSG）
   */
  revalidate?: number;
  /** 重定向配置 */
  redirect?: {
    destination: string;
    permanent?: boolean;
  };
  /** 返回 404 */
  notFound?: boolean;
}

/**
 * SSG 路径生成结果
 * 用于动态路由的预生成路径列表
 */
export interface GetStaticPathsResult {
  /** 需要预生成的路径参数列表 */
  paths: Array<{
    params: Record<string, string>;
    locale?: string;
  }>;
  /**
   * 未预生成路径的处理策略
   * - false: 返回 404
   * - true: 先返回降级页面，后台生成后客户端更新
   * - 'blocking': 阻塞等待服务端渲染完成
   */
  fallback: ISRFallbackStrategy;
}

/**
 * 路由匹配结果
 * 路由匹配器返回的匹配信息
 */
export interface RouteMatchResult {
  /** 匹配到的路由配置 */
  route: NamiRoute;
  /** 解析出的动态参数 */
  params: Record<string, string>;
  /** 是否精确匹配 */
  isExact: boolean;
}
