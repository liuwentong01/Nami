/**
 * @nami/plugin-monitor - Beacon 数据上报器
 *
 * 负责将收集到的监控数据发送到远端上报接口。
 *
 * 上报策略：
 * - 客户端环境：优先使用 navigator.sendBeacon（页面卸载时也能发送）
 * - 服务端环境：使用 HTTP POST 请求
 * - 支持批量上报（将多条数据合并为一次请求）
 * - 支持失败重试（指数退避策略）
 * - 上报数据自动压缩（JSON 序列化）
 *
 * @see https://developer.mozilla.org/zh-CN/docs/Web/API/Navigator/sendBeacon
 */

/**
 * 上报器配置
 */
export interface BeaconReporterOptions {
  /**
   * 上报接口 URL
   * 必填，所有监控数据将发送到此地址
   */
  endpoint: string;

  /**
   * 批量上报的时间间隔（毫秒）
   * 收集器不会实时发送每条数据，而是每隔指定时间批量发送
   * @default 10000（10 秒）
   */
  flushInterval?: number;

  /**
   * 单次上报的最大数据条数
   * 超过此数量的数据将分多次发送
   * @default 50
   */
  maxBatchSize?: number;

  /**
   * 失败重试次数
   * @default 3
   */
  maxRetries?: number;

  /**
   * 自定义请求头
   * 可用于添加认证信息等
   */
  headers?: Record<string, string>;

  /**
   * 上报超时时间（毫秒）
   * 仅对服务端 HTTP 请求有效
   * @default 5000
   */
  timeout?: number;

  /**
   * 是否在开发环境禁用上报
   * @default true
   */
  disableInDev?: boolean;
}

/**
 * 上报数据的通用包装格式
 */
interface ReportPayload {
  /** 数据类型标识 */
  type: string;
  /** 上报时间戳 */
  timestamp: number;
  /** 实际数据数组 */
  data: unknown[];
  /** 附加的元信息（应用标识、环境等） */
  meta?: Record<string, unknown>;
}

/**
 * Beacon 上报器
 *
 * 支持客户端和服务端双环境的监控数据上报。
 *
 * @example
 * ```typescript
 * const reporter = new BeaconReporter({
 *   endpoint: 'https://monitor.example.com/api/report',
 *   flushInterval: 10000,
 *   maxBatchSize: 50,
 * });
 *
 * // 提交数据（不会立即发送，会攒批）
 * reporter.report('performance', [metrics1, metrics2]);
 *
 * // 立即刷新发送
 * await reporter.flush();
 *
 * // 销毁时清理
 * reporter.dispose();
 * ```
 */
export class BeaconReporter {
  /** 上报接口地址 */
  private readonly endpoint: string;

  /** 批量上报间隔（毫秒） */
  private readonly flushInterval: number;

  /** 单次最大批量大小 */
  private readonly maxBatchSize: number;

  /** 最大重试次数 */
  private readonly maxRetries: number;

  /** 自定义请求头 */
  private readonly headers: Record<string, string>;

  /** 上报超时（毫秒） */
  private readonly timeout: number;

  /** 待上报数据队列 */
  private queue: Map<string, unknown[]> = new Map();

  /** 定时刷新器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** 是否已销毁 */
  private disposed: boolean = false;

  /** 是否处于开发环境 */
  private readonly isDev: boolean;

  /** 是否禁用上报 */
  private readonly disabled: boolean;

  /** 附加元信息 */
  private meta: Record<string, unknown> = {};

  constructor(options: BeaconReporterOptions) {
    this.endpoint = options.endpoint;
    this.flushInterval = options.flushInterval ?? 10000;
    this.maxBatchSize = options.maxBatchSize ?? 50;
    this.maxRetries = options.maxRetries ?? 3;
    this.headers = options.headers ?? {};
    this.timeout = options.timeout ?? 5000;

    // 检测当前环境
    this.isDev = typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';
    this.disabled = this.isDev && (options.disableInDev ?? true);

    // 启动定时刷新
    if (!this.disabled) {
      this.startFlushTimer();
    }
  }

  /**
   * 设置附加元信息
   *
   * 元信息会附加到每次上报的数据中，通常包含应用标识、版本号等。
   *
   * @param meta - 元信息对象
   */
  setMeta(meta: Record<string, unknown>): void {
    this.meta = { ...this.meta, ...meta };
  }

  /**
   * 提交待上报的数据
   *
   * 数据不会立即发送，而是存入队列等待下次定时刷新或手动 flush。
   *
   * @param type - 数据类型标识（如 'performance'、'error'、'render'）
   * @param data - 数据数组
   */
  report(type: string, data: unknown[]): void {
    if (this.disposed || this.disabled) return;

    const existing = this.queue.get(type) ?? [];
    existing.push(...data);
    this.queue.set(type, existing);
  }

  /**
   * 立即刷新上报队列
   *
   * 将队列中的所有数据分批发送到上报接口。
   * 返回 Promise，上报完成后 resolve。
   */
  async flush(): Promise<void> {
    if (this.disposed || this.disabled) return;

    // 取出当前队列，立即清空（避免并发问题）
    const currentQueue = new Map(this.queue);
    this.queue = new Map();

    // 按数据类型逐一上报
    const promises: Promise<void>[] = [];
    for (const [type, items] of currentQueue.entries()) {
      if (items.length === 0) continue;

      // 分批处理
      const batches = this.splitIntoBatches(items);
      for (const batch of batches) {
        promises.push(this.sendBatch(type, batch));
      }
    }

    // 等待所有上报完成
    await Promise.allSettled(promises);
  }

  /**
   * 销毁上报器
   *
   * 停止定时刷新，尝试发送队列中剩余的数据。
   */
  async dispose(): Promise<void> {
    this.disposed = true;

    // 停止定时器
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 尝试发送剩余数据
    try {
      await this.flush();
    } catch {
      // 销毁时的发送失败不需要处理
    }
  }

  /**
   * 启动定时刷新定时器
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      // 异步刷新，不阻塞定时器
      this.flush().catch(() => {
        // 定时刷新的失败静默处理
      });
    }, this.flushInterval);

    // 确保定时器不阻止 Node.js 进程退出
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * 将数据分成多个批次
   */
  private splitIntoBatches(items: unknown[]): unknown[][] {
    const batches: unknown[][] = [];
    for (let i = 0; i < items.length; i += this.maxBatchSize) {
      batches.push(items.slice(i, i + this.maxBatchSize));
    }
    return batches;
  }

  /**
   * 发送单个批次的数据
   *
   * 根据运行环境选择发送方式：
   * - 浏览器环境：优先 sendBeacon，回退到 fetch
   * - Node.js 环境：使用 fetch（Node.js 18+ 内置）
   *
   * 发送失败时进行指数退避重试。
   *
   * @param type - 数据类型
   * @param batch - 数据批次
   */
  private async sendBatch(type: string, batch: unknown[]): Promise<void> {
    const payload: ReportPayload = {
      type,
      timestamp: Date.now(),
      data: batch,
      meta: Object.keys(this.meta).length > 0 ? this.meta : undefined,
    };

    const body = JSON.stringify(payload);

    // 尝试使用 sendBeacon（浏览器环境）
    if (this.trySendBeacon(body)) {
      return;
    }

    // 回退到 fetch，支持重试
    await this.sendWithRetry(body);
  }

  /**
   * 尝试使用 navigator.sendBeacon 发送数据
   *
   * sendBeacon 的优势：
   * - 异步发送，不阻塞页面卸载
   * - 浏览器保证在页面关闭前完成发送
   * - 适合页面卸载时的最后一次上报
   *
   * @param body - JSON 字符串
   * @returns 是否成功发送
   */
  private trySendBeacon(body: string): boolean {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        // sendBeacon 发送 JSON 数据需要包装为 Blob
        const blob = new Blob([body], { type: 'application/json' });
        return navigator.sendBeacon(this.endpoint, blob);
      } catch {
        // sendBeacon 可能因数据量过大而失败，回退到 fetch
        return false;
      }
    }
    return false;
  }

  /**
   * 使用 fetch 发送数据，支持重试
   *
   * 采用指数退避策略：第 N 次重试等待 2^N * 1000 毫秒。
   *
   * @param body - JSON 字符串
   */
  private async sendWithRetry(body: string): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // 使用 AbortController 实现超时控制
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...this.headers,
            },
            body,
            signal: controller.signal,
          });

          if (response.ok) {
            return; // 发送成功
          }

          // 服务端返回错误
          lastError = new Error(
            `[BeaconReporter] 上报失败: HTTP ${response.status} ${response.statusText}`
          );
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error
          ? error
          : new Error(String(error));
      }

      // 指数退避等待（最后一次重试后不需要等待）
      if (attempt < this.maxRetries) {
        const delay = Math.min(Math.pow(2, attempt) * 1000, 30000);
        await this.sleep(delay);
      }
    }

    // 所有重试都失败了
    // 在服务端环境记录警告（不抛异常，避免影响业务流程）
    if (typeof console !== 'undefined' && lastError) {
      console.warn(
        `[BeaconReporter] 上报失败，已重试 ${this.maxRetries} 次:`,
        lastError.message,
      );
    }
  }

  /**
   * 异步等待指定毫秒数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
