/**
 * @nami/plugin-monitor - 控制台上报器
 *
 * 开发环境专用的监控数据上报器，将采集到的指标以格式化表格的形式
 * 输出到浏览器/Node.js 控制台，方便开发者实时查看性能数据。
 *
 * 特性：
 * - 使用 console.table 输出结构化表格
 * - 按数据类型分组展示（性能/错误/渲染指标/Web Vitals）
 * - 支持颜色高亮超标指标
 * - 仅在开发环境启用，生产环境自动静默
 */

/**
 * 控制台上报器配置
 */
export interface ConsoleReporterOptions {
  /**
   * 是否启用控制台上报
   * @default true
   */
  enabled?: boolean;

  /**
   * 日志前缀
   * @default '[NamiMonitor]'
   */
  prefix?: string;

  /**
   * 是否使用 console.table 格式化输出
   * @default true
   */
  useTable?: boolean;

  /**
   * 是否展示详细的指标数据（如堆栈信息）
   * @default false
   */
  verbose?: boolean;

  /**
   * 性能指标超标阈值（毫秒）
   * 超标的指标将以警告样式输出
   */
  thresholds?: {
    /** 总渲染时间阈值 */
    totalDuration?: number;
    /** 数据预取时间阈值 */
    dataFetchDuration?: number;
    /** React 渲染时间阈值 */
    renderDuration?: number;
  };
}

/**
 * 上报数据条目
 */
interface ReportEntry {
  /** 数据类型标识 */
  type: string;
  /** 数据数组 */
  data: unknown[];
  /** 上报时间戳 */
  timestamp: number;
}

/**
 * 控制台上报器
 *
 * 开发环境使用，将监控数据以可读的格式输出到控制台。
 *
 * @example
 * ```typescript
 * const reporter = new ConsoleReporter({
 *   prefix: '[Monitor]',
 *   useTable: true,
 *   thresholds: { totalDuration: 3000 },
 * });
 *
 * reporter.report('performance', [{ url: '/page', totalDuration: 1200 }]);
 * reporter.flush(); // 立即输出到控制台
 * ```
 */
export class ConsoleReporter {
  /** 是否启用 */
  private readonly enabled: boolean;

  /** 日志前缀 */
  private readonly prefix: string;

  /** 是否使用表格格式 */
  private readonly useTable: boolean;

  /** 是否展示详细信息 */
  private readonly verbose: boolean;

  /** 超标阈值 */
  private readonly thresholds: Required<NonNullable<ConsoleReporterOptions['thresholds']>>;

  /** 待输出数据队列 */
  private queue: ReportEntry[] = [];

  /** 是否已销毁 */
  private disposed: boolean = false;

  constructor(options: ConsoleReporterOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.prefix = options.prefix ?? '[NamiMonitor]';
    this.useTable = options.useTable ?? true;
    this.verbose = options.verbose ?? false;
    this.thresholds = {
      totalDuration: options.thresholds?.totalDuration ?? 3000,
      dataFetchDuration: options.thresholds?.dataFetchDuration ?? 2000,
      renderDuration: options.thresholds?.renderDuration ?? 1000,
    };
  }

  /**
   * 提交待输出的数据
   *
   * @param type - 数据类型标识
   * @param data - 数据数组
   */
  report(type: string, data: unknown[]): void {
    if (!this.enabled || this.disposed) return;

    this.queue.push({
      type,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * 立即将队列中的数据输出到控制台
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.disposed) return;

    // 取出当前队列
    const entries = [...this.queue];
    this.queue = [];

    if (entries.length === 0) return;

    // 按数据类型分组输出
    const grouped = this.groupByType(entries);

    for (const [type, items] of Object.entries(grouped)) {
      this.printGroup(type, items);
    }
  }

  /**
   * 销毁上报器
   */
  async dispose(): Promise<void> {
    // 输出剩余数据
    await this.flush();
    this.disposed = true;
  }

  /**
   * 设置附加元信息（兼容 BeaconReporter 接口，控制台上报器不需要此功能）
   */
  setMeta(_meta: Record<string, unknown>): void {
    // 控制台上报器不需要元信息，仅保持接口兼容
  }

  /**
   * 按数据类型分组
   */
  private groupByType(entries: ReportEntry[]): Record<string, unknown[]> {
    const grouped: Record<string, unknown[]> = {};

    for (const entry of entries) {
      if (!grouped[entry.type]) {
        grouped[entry.type] = [];
      }
      grouped[entry.type]!.push(...entry.data);
    }

    return grouped;
  }

  /**
   * 输出一组数据到控制台
   */
  private printGroup(type: string, items: unknown[]): void {
    if (items.length === 0) return;

    const title = this.getGroupTitle(type);
    const icon = this.getGroupIcon(type);

    // 输出分组标题
    console.group(`${this.prefix} ${icon} ${title} (${items.length} 条)`);

    try {
      switch (type) {
        case 'performance':
          this.printPerformanceMetrics(items);
          break;
        case 'error':
          this.printErrorRecords(items);
          break;
        case 'render':
          this.printRenderMetrics(items);
          break;
        case 'web-vitals':
          this.printWebVitals(items);
          break;
        case 'summary':
          this.printSummary(items);
          break;
        default:
          this.printGenericData(items);
          break;
      }
    } finally {
      console.groupEnd();
    }
  }

  /**
   * 输出性能指标
   */
  private printPerformanceMetrics(items: unknown[]): void {
    const tableData = items.map((item) => {
      const metric = item as Record<string, unknown>;

      const totalDuration = metric['totalDuration'] as number | undefined;
      const dataFetchDuration = metric['dataFetchDuration'] as number | undefined;
      const renderDuration = metric['renderDuration'] as number | undefined;

      return {
        URL: metric['url'] ?? '-',
        '总耗时(ms)': totalDuration ?? '-',
        '数据预取(ms)': dataFetchDuration ?? '-',
        '渲染(ms)': renderDuration ?? '-',
        'HTML组装(ms)': metric['htmlAssemblyDuration'] ?? '-',
        '渲染模式': metric['renderMode'] ?? '-',
        '缓存命中': metric['cacheHit'] ? 'YES' : 'NO',
        '降级': metric['degraded'] ? 'YES' : 'NO',
        '状态': this.getPerformanceStatus(totalDuration, dataFetchDuration, renderDuration),
      };
    });

    if (this.useTable) {
      console.table(tableData);
    } else {
      for (const row of tableData) {
        const status = row['状态'];
        const logFn = status === 'SLOW' ? console.warn : console.log;
        logFn(`  ${row['URL']} - ${row['总耗时(ms)']}ms [${row['渲染模式']}]`);
      }
    }
  }

  /**
   * 输出错误记录
   */
  private printErrorRecords(items: unknown[]): void {
    const tableData = items.map((item) => {
      const record = item as Record<string, unknown>;

      return {
        '类型': record['type'] ?? '-',
        '严重等级': record['severity'] ?? '-',
        '消息': this.truncate(String(record['message'] ?? ''), 80),
        URL: record['url'] ?? '-',
        '请求ID': record['requestId'] ?? '-',
        '时间': record['timestamp']
          ? new Date(record['timestamp'] as number).toISOString()
          : '-',
      };
    });

    if (this.useTable) {
      console.table(tableData);
    } else {
      for (const row of tableData) {
        console.error(`  [${row['类型']}/${row['严重等级']}] ${row['消息']}`);
      }
    }

    // 详细模式下输出堆栈信息
    if (this.verbose) {
      for (const item of items) {
        const record = item as Record<string, unknown>;
        if (record['stack']) {
          console.debug(`  堆栈: ${record['stack']}`);
        }
      }
    }
  }

  /**
   * 输出渲染指标
   */
  private printRenderMetrics(items: unknown[]): void {
    const tableData = items.map((item) => {
      const metric = item as Record<string, unknown>;

      return {
        URL: metric['url'] ?? '-',
        '渲染模式': metric['renderMode'] ?? '-',
        '状态码': metric['statusCode'] ?? '-',
        '缓存命中': metric['cacheHit'] ? 'YES' : 'NO',
        '缓存过期': metric['cacheStale'] ? 'YES' : 'NO',
        '降级': metric['degraded'] ? 'YES' : 'NO',
        '降级原因': metric['degradeReason'] ?? '-',
      };
    });

    if (this.useTable) {
      console.table(tableData);
    } else {
      for (const row of tableData) {
        console.log(`  ${row['URL']} [${row['渲染模式']}] 状态码=${row['状态码']}`);
      }
    }
  }

  /**
   * 输出 Web Vitals 指标
   */
  private printWebVitals(items: unknown[]): void {
    const tableData = items.map((item) => {
      const metric = item as Record<string, unknown>;
      const name = metric['name'] as string | undefined;
      const value = metric['value'] as number | undefined;
      const rating = metric['rating'] as string | undefined;

      return {
        '指标': name ?? '-',
        '值': value !== undefined ? this.formatVitalValue(name ?? '', value) : '-',
        '评级': rating ?? '-',
        '状态': this.getVitalStatusLabel(rating),
      };
    });

    if (this.useTable) {
      console.table(tableData);
    } else {
      for (const row of tableData) {
        const logFn = row['评级'] === 'poor' ? console.warn : console.log;
        logFn(`  ${row['指标']}: ${row['值']} (${row['评级']})`);
      }
    }
  }

  /**
   * 输出聚合摘要
   */
  private printSummary(items: unknown[]): void {
    for (const item of items) {
      const summary = item as Record<string, unknown>;

      // 输出错误摘要
      const errors = summary['errors'] as Record<string, unknown> | undefined;
      if (errors) {
        console.log(`  错误总数: ${errors['total'] ?? 0}`);
        const byType = errors['byType'] as Record<string, number> | undefined;
        if (byType) {
          const nonZero = Object.entries(byType).filter(([, count]) => count > 0);
          if (nonZero.length > 0) {
            console.log(`  按类型: ${nonZero.map(([t, c]) => `${t}=${c}`).join(', ')}`);
          }
        }
      }

      // 输出渲染摘要
      const render = summary['render'] as Record<string, unknown> | undefined;
      if (render) {
        const totalRenders = render['totalRenders'] as number | undefined;
        const degradationRate = render['degradationRate'] as number | undefined;
        const cacheHitRate = render['cacheHitRate'] as number | undefined;
        const successRate = render['successRate'] as number | undefined;

        if (totalRenders !== undefined && totalRenders > 0) {
          console.log(`  总渲染: ${totalRenders}`);
          if (degradationRate !== undefined) {
            console.log(`  降级率: ${(degradationRate * 100).toFixed(1)}%`);
          }
          if (cacheHitRate !== undefined) {
            console.log(`  缓存命中率: ${(cacheHitRate * 100).toFixed(1)}%`);
          }
          if (successRate !== undefined) {
            console.log(`  成功率: ${(successRate * 100).toFixed(1)}%`);
          }
        }
      }
    }
  }

  /**
   * 输出通用数据
   */
  private printGenericData(items: unknown[]): void {
    if (this.useTable && items.length > 0 && typeof items[0] === 'object') {
      console.table(items);
    } else {
      for (const item of items) {
        console.log(`  ${JSON.stringify(item)}`);
      }
    }
  }

  /**
   * 获取分组标题
   */
  private getGroupTitle(type: string): string {
    const titles: Record<string, string> = {
      'performance': '性能指标',
      'error': '错误记录',
      'render': '渲染指标',
      'web-vitals': 'Web Vitals',
      'summary': '聚合摘要',
    };
    return titles[type] ?? `自定义指标(${type})`;
  }

  /**
   * 获取分组图标
   */
  private getGroupIcon(type: string): string {
    const icons: Record<string, string> = {
      'performance': '[PERF]',
      'error': '[ERR]',
      'render': '[RENDER]',
      'web-vitals': '[VITALS]',
      'summary': '[SUM]',
    };
    return icons[type] ?? '[DATA]';
  }

  /**
   * 获取性能状态标签
   */
  private getPerformanceStatus(
    totalDuration?: number,
    dataFetchDuration?: number,
    renderDuration?: number,
  ): string {
    if (
      (totalDuration !== undefined && totalDuration > this.thresholds.totalDuration) ||
      (dataFetchDuration !== undefined && dataFetchDuration > this.thresholds.dataFetchDuration) ||
      (renderDuration !== undefined && renderDuration > this.thresholds.renderDuration)
    ) {
      return 'SLOW';
    }
    return 'OK';
  }

  /**
   * 格式化 Web Vital 值
   */
  private formatVitalValue(name: string, value: number): string {
    switch (name) {
      case 'CLS':
        return value.toFixed(3);
      case 'LCP':
      case 'FID':
      case 'FCP':
      case 'TTFB':
      case 'INP':
        return `${Math.round(value)}ms`;
      default:
        return String(value);
    }
  }

  /**
   * 获取 Vital 状态标签
   */
  private getVitalStatusLabel(rating?: string): string {
    switch (rating) {
      case 'good':
        return 'GOOD';
      case 'needs-improvement':
        return 'WARN';
      case 'poor':
        return 'POOR';
      default:
        return '-';
    }
  }

  /**
   * 截断过长的字符串
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
  }
}
