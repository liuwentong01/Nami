/**
 * @nami/shared - 错误类型定义
 *
 * 框架内部使用统一的错误体系，便于错误分类、上报和降级决策。
 * 每个错误都携带错误码、严重等级和上下文信息。
 */

/**
 * 错误码枚举
 *
 * 按模块划分的错误码范围：
 * - 1000-1999: 渲染错误
 * - 2000-2999: 数据预取错误
 * - 3000-3999: 缓存错误
 * - 4000-4999: 路由错误
 * - 5000-5999: 插件错误
 * - 6000-6999: 构建错误
 * - 7000-7999: 服务端错误
 * - 8000-8999: 客户端错误
 * - 9000-9999: 配置错误
 */
export enum ErrorCode {
  // 渲染错误 1000-1999
  /** SSR 渲染失败 */
  RENDER_SSR_FAILED = 1001,
  /** SSR 渲染超时 */
  RENDER_SSR_TIMEOUT = 1002,
  /** CSR 渲染失败 */
  RENDER_CSR_FAILED = 1003,
  /** SSG 生成失败 */
  RENDER_SSG_FAILED = 1004,
  /** ISR 重验证失败 */
  RENDER_ISR_REVALIDATE_FAILED = 1005,
  /** Hydration 不匹配 */
  RENDER_HYDRATION_MISMATCH = 1006,
  /** 渲染降级触发 */
  RENDER_DEGRADED = 1007,

  // 数据预取错误 2000-2999
  /** 数据预取失败 */
  DATA_FETCH_FAILED = 2001,
  /** 数据预取超时 */
  DATA_FETCH_TIMEOUT = 2002,
  /** 数据序列化失败 */
  DATA_SERIALIZE_FAILED = 2003,
  /** getServerSideProps 执行失败 */
  DATA_GSSP_FAILED = 2004,
  /** getStaticProps 执行失败 */
  DATA_GSP_FAILED = 2005,

  // 缓存错误 3000-3999
  /** 缓存读取失败 */
  CACHE_READ_FAILED = 3001,
  /** 缓存写入失败 */
  CACHE_WRITE_FAILED = 3002,
  /** 缓存失效操作失败 */
  CACHE_INVALIDATE_FAILED = 3003,
  /** Redis 连接失败 */
  CACHE_REDIS_CONNECTION_FAILED = 3004,

  // 路由错误 4000-4999
  /** 路由未匹配 */
  ROUTE_NOT_FOUND = 4001,
  /** 路由配置无效 */
  ROUTE_INVALID_CONFIG = 4002,

  // 插件错误 5000-5999
  /** 插件加载失败 */
  PLUGIN_LOAD_FAILED = 5001,
  /** 插件初始化失败 */
  PLUGIN_SETUP_FAILED = 5002,
  /** 钩子执行失败 */
  PLUGIN_HOOK_FAILED = 5003,

  // 构建错误 6000-6999
  /** Webpack 编译失败 */
  BUILD_COMPILE_FAILED = 6001,
  /** 配置文件加载失败 */
  BUILD_CONFIG_LOAD_FAILED = 6002,

  // 服务端错误 7000-7999
  /** 服务启动失败 */
  SERVER_START_FAILED = 7001,
  /** 端口被占用 */
  SERVER_PORT_IN_USE = 7002,
  /** 中间件执行失败 */
  SERVER_MIDDLEWARE_FAILED = 7003,

  // 客户端错误 8000-8999
  /** 客户端初始化失败 */
  CLIENT_INIT_FAILED = 8001,
  /** 客户端路由失败 */
  CLIENT_ROUTING_FAILED = 8002,

  // 配置错误 9000-9999
  /** 配置校验失败 */
  CONFIG_VALIDATION_FAILED = 9001,
  /** 配置文件不存在 */
  CONFIG_NOT_FOUND = 9002,
}

/**
 * 错误严重等级
 */
export enum ErrorSeverity {
  /** 致命错误 — 导致服务不可用 */
  Fatal = 'fatal',
  /** 严重错误 — 影响核心功能 */
  Error = 'error',
  /** 警告 — 降级处理，功能部分可用 */
  Warning = 'warning',
  /** 信息 — 记录但不影响功能 */
  Info = 'info',
}

/**
 * 降级等级
 *
 * 框架按照从 Level0 到 Level5 的顺序依次尝试降级，
 * 直到找到一个可用的渲染结果。
 */
export enum DegradationLevel {
  /** 正常渲染 */
  None = 0,
  /** 重试后成功 */
  Retry = 1,
  /** 降级到 CSR */
  CSRFallback = 2,
  /** 返回骨架屏 */
  Skeleton = 3,
  /** 返回兜底静态 HTML */
  StaticHTML = 4,
  /** 返回 503 */
  ServiceUnavailable = 5,
}

/**
 * Nami 错误基类
 *
 * 框架内所有错误都继承此基类，携带统一的错误码、
 * 严重等级和上下文信息，便于统一处理和上报。
 */
export class NamiError extends Error {
  /** 错误码 */
  public readonly code: ErrorCode;

  /** 严重等级 */
  public readonly severity: ErrorSeverity;

  /** 错误上下文（附加调试信息） */
  public readonly context: Record<string, unknown>;

  /** 错误发生时间 */
  public readonly timestamp: number;

  constructor(
    message: string,
    code: ErrorCode,
    severity: ErrorSeverity = ErrorSeverity.Error,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'NamiError';
    this.code = code;
    this.severity = severity;
    this.context = context;
    this.timestamp = Date.now();

    // 确保 instanceof 检查正确工作
    Object.setPrototypeOf(this, NamiError.prototype);
  }

  /**
   * 序列化为可传输的纯对象
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      severity: this.severity,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

/**
 * 渲染错误
 */
export class RenderError extends NamiError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.RENDER_SSR_FAILED,
    context: Record<string, unknown> = {},
  ) {
    super(message, code, ErrorSeverity.Error, context);
    this.name = 'RenderError';
    Object.setPrototypeOf(this, RenderError.prototype);
  }
}

/**
 * 数据预取错误
 */
export class DataFetchError extends NamiError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.DATA_FETCH_FAILED,
    context: Record<string, unknown> = {},
  ) {
    super(message, code, ErrorSeverity.Warning, context);
    this.name = 'DataFetchError';
    Object.setPrototypeOf(this, DataFetchError.prototype);
  }
}

/**
 * 配置错误
 */
export class ConfigError extends NamiError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, ErrorCode.CONFIG_VALIDATION_FAILED, ErrorSeverity.Fatal, context);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}
