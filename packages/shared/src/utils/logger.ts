/**
 * @nami/shared - 日志工具
 *
 * 提供统一的日志接口，支持：
 * - 多日志级别（debug/info/warn/error/fatal）
 * - requestId 关联（便于链路追踪）
 * - 结构化日志输出
 * - 可插拔的日志输出适配器
 */

/**
 * 日志级别枚举
 */
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Fatal = 4,
  Silent = 5,
}

/**
 * 日志级别名称映射
 */
const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO',
  [LogLevel.Warn]: 'WARN',
  [LogLevel.Error]: 'ERROR',
  [LogLevel.Fatal]: 'FATAL',
  [LogLevel.Silent]: 'SILENT',
};

/**
 * 日志级别颜色（ANSI 转义码）
 */
const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.Debug]: '\x1b[36m',   // 青色
  [LogLevel.Info]: '\x1b[32m',    // 绿色
  [LogLevel.Warn]: '\x1b[33m',    // 黄色
  [LogLevel.Error]: '\x1b[31m',   // 红色
  [LogLevel.Fatal]: '\x1b[35m',   // 紫色
  [LogLevel.Silent]: '',
};

/** ANSI 重置码 */
const RESET = '\x1b[0m';

/**
 * 日志输出适配器接口
 */
export interface LogAdapter {
  write(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}

/**
 * 默认控制台日志适配器
 */
class ConsoleAdapter implements LogAdapter {
  write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const color = LOG_LEVEL_COLORS[level];
    const levelName = LOG_LEVEL_NAMES[level];
    const timestamp = new Date().toISOString();
    const prefix = `${color}[${timestamp}] [${levelName}]${RESET}`;

    const metaStr = meta && Object.keys(meta).length > 0
      ? ` ${JSON.stringify(meta)}`
      : '';

    switch (level) {
      case LogLevel.Debug:
        console.debug(`${prefix} ${message}${metaStr}`);
        break;
      case LogLevel.Info:
        console.info(`${prefix} ${message}${metaStr}`);
        break;
      case LogLevel.Warn:
        console.warn(`${prefix} ${message}${metaStr}`);
        break;
      case LogLevel.Error:
      case LogLevel.Fatal:
        console.error(`${prefix} ${message}${metaStr}`);
        break;
    }
  }
}

/**
 * Logger 日志类
 *
 * @example
 * ```typescript
 * const logger = new Logger({ prefix: '@nami/server', level: LogLevel.Info });
 * logger.info('服务启动', { port: 3000 });
 * logger.error('渲染失败', { url: '/page', error: err.message });
 *
 * // 带 requestId 的子 logger
 * const reqLogger = logger.child({ requestId: 'req-123' });
 * reqLogger.info('处理请求'); // 自动携带 requestId
 * ```
 */
export class Logger {
  private level: LogLevel;
  private prefix: string;
  private adapter: LogAdapter;
  private defaultMeta: Record<string, unknown>;

  constructor(options: {
    prefix?: string;
    level?: LogLevel;
    adapter?: LogAdapter;
    meta?: Record<string, unknown>;
  } = {}) {
    this.prefix = options.prefix || 'nami';
    this.level = options.level ?? (process.env.NODE_ENV === 'production' ? LogLevel.Info : LogLevel.Debug);
    this.adapter = options.adapter || new ConsoleAdapter();
    this.defaultMeta = options.meta || {};
  }

  /**
   * 创建子 Logger
   * 继承父级配置，可追加前缀和元信息
   */
  child(meta: Record<string, unknown>): Logger {
    return new Logger({
      prefix: this.prefix,
      level: this.level,
      adapter: this.adapter,
      meta: { ...this.defaultMeta, ...meta },
    });
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.Debug, message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.Info, message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.Warn, message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.Error, message, meta);
  }

  fatal(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.Fatal, message, meta);
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (level < this.level) return;

    const fullMessage = `[${this.prefix}] ${message}`;
    const fullMeta = { ...this.defaultMeta, ...meta };

    this.adapter.write(level, fullMessage, fullMeta);
  }
}

/**
 * 创建全局默认 Logger
 */
export function createLogger(prefix?: string, level?: LogLevel): Logger {
  return new Logger({ prefix, level });
}
