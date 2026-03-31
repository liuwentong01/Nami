/**
 * @nami/shared - 数据预取类型定义
 *
 * 定义数据预取流程中的所有相关类型，
 * 包括预取结果、预取选项、缓存配置等。
 */

/**
 * 数据预取结果
 *
 * PrefetchManager 执行预取后返回的统一结果格式。
 * 无论数据获取成功还是失败，都会返回此结构。
 */
export interface PrefetchResult<T = Record<string, unknown>> {
  /** 预取到的数据 */
  data: T;

  /**
   * 预取过程中产生的错误列表
   * 部分数据源失败不会阻止整体渲染
   */
  errors: Error[];

  /** 是否发生了降级（如超时导致部分数据缺失） */
  degraded: boolean;

  /** 预取耗时（毫秒） */
  duration: number;

  /** 各数据源的预取详情 */
  details?: PrefetchDetail[];
}

/**
 * 单个数据源的预取详情
 */
export interface PrefetchDetail {
  /** 数据源标识 */
  key: string;
  /** 是否成功 */
  success: boolean;
  /** 耗时（毫秒） */
  duration: number;
  /** 错误信息（如果失败） */
  error?: string;
  /** 是否来自缓存 */
  cached?: boolean;
}

/**
 * 数据预取选项
 */
export interface PrefetchOptions {
  /**
   * 超时时间（毫秒）
   * 超时后中断预取，返回已获取的部分数据
   */
  timeout?: number;

  /**
   * 是否允许部分失败
   * 默认 true，某个数据源失败不影响其他数据源
   */
  allowPartialFailure?: boolean;

  /**
   * 重试配置
   */
  retry?: {
    /** 最大重试次数 */
    maxRetries: number;
    /** 重试延迟（毫秒） */
    delay: number;
  };
}

/**
 * 数据序列化选项
 * 控制服务端数据序列化到 HTML 的行为
 */
export interface SerializeOptions {
  /**
   * 是否启用 XSS 防护
   * 默认 true，会转义 </script> 等危险字符串
   */
  xssSafe?: boolean;

  /**
   * 注入到 window 上的变量名
   * 默认 '__NAMI_DATA__'
   */
  variableName?: string;

  /**
   * 是否压缩序列化输出
   * 生产环境默认 true
   */
  compress?: boolean;
}
