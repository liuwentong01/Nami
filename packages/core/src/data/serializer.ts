/**
 * @nami/core - 数据序列化器
 *
 * DataSerializer 负责服务端数据与 HTML 之间的序列化/反序列化。
 *
 * SSR 数据传递流程：
 * 1. 服务端预取数据 → DataSerializer.serialize() 生成 <script> 标签
 * 2. <script> 标签嵌入 HTML 文档 → 浏览器解析时执行，写入 window.__NAMI_DATA__
 * 3. 客户端 hydrate → DataSerializer.deserialize() 从 window 读取数据
 *
 * 安全措施：
 * - 使用 safeStringify 转义 HTML 特殊字符，防止 XSS 注入
 * - 序列化时过滤 undefined 和 function 类型的值
 */

import {
  safeStringify,
  generateDataScript,
  hydrateData,
  NAMI_DATA_VARIABLE,
  createLogger,
  isServer,
} from '@nami/shared';

/** 序列化器内部日志 */
const logger = createLogger('@nami/core:serializer');

/**
 * 数据序列化器
 *
 * 提供服务端数据的序列化（注入 HTML）和反序列化（客户端读取）能力。
 *
 * @example
 * ```typescript
 * const serializer = new DataSerializer();
 *
 * // 服务端：生成 script 标签嵌入 HTML
 * const scriptTag = serializer.serialize({ user: { name: '张三' } });
 * // 输出: <script>window.__NAMI_DATA__={"user":{"name":"张三"}}</script>
 *
 * // 客户端：从 window 读取数据
 * const data = serializer.deserialize();
 * // data = { user: { name: '张三' } }
 * ```
 */
export class DataSerializer {
  /** 注入到 window 上的全局变量名 */
  private readonly variableName: string;

  /**
   * 构造函数
   *
   * @param variableName - window 上的变量名，默认 '__NAMI_DATA__'
   */
  constructor(variableName: string = NAMI_DATA_VARIABLE) {
    this.variableName = variableName;
  }

  /**
   * 将数据序列化为安全的 <script> 标签
   *
   * 生成的标签可以直接嵌入 HTML 文档的 <body> 中。
   * 内部使用 @nami/shared 的 safeStringify 进行 XSS 防护。
   *
   * @param data - 要序列化的数据对象
   * @returns 包含数据的 <script> 标签 HTML 字符串
   *
   * @example
   * ```typescript
   * const tag = serializer.serialize({ title: 'Hello <World>' });
   * // <script>window.__NAMI_DATA__={"title":"Hello \\u003CWorld\\u003E"}</script>
   * ```
   */
  serialize(data: Record<string, unknown>): string {
    try {
      // 使用 @nami/shared 提供的安全序列化工具生成 script 标签
      const scriptTag = generateDataScript(data, this.variableName);

      logger.debug('数据序列化完成', {
        variableName: this.variableName,
        dataKeys: Object.keys(data),
        size: scriptTag.length,
      });

      return scriptTag;
    } catch (error) {
      // 序列化失败时返回空数据的 script 标签，避免阻断渲染
      const message = error instanceof Error ? error.message : String(error);
      logger.error('数据序列化失败，将注入空数据', { error: message });

      return `<script>window.${this.variableName}={}</script>`;
    }
  }

  /**
   * 将数据序列化为 JSON 字符串（不包含 script 标签）
   *
   * 当需要单独获取安全 JSON 字符串时使用，
   * 例如用于自定义模板引擎或注入其他位置。
   *
   * @param data - 要序列化的数据对象
   * @returns 经过 XSS 防护处理的 JSON 字符串
   */
  serializeToJSON(data: Record<string, unknown>): string {
    return safeStringify(data, true);
  }

  /**
   * 从客户端 window 对象反序列化数据
   *
   * 在浏览器环境中从 window.__NAMI_DATA__ 读取服务端注入的数据。
   * 在服务端环境中调用会返回 null。
   *
   * @typeParam T - 期望的数据类型
   * @returns 反序列化后的数据，如果不在客户端环境或数据不存在则返回 null
   *
   * @example
   * ```typescript
   * // 客户端入口
   * const serializer = new DataSerializer();
   * const initialData = serializer.deserialize<{ user: User }>();
   *
   * if (initialData) {
   *   hydrateRoot(container, <App data={initialData} />);
   * }
   * ```
   */
  deserialize<T = Record<string, unknown>>(): T | null {
    // 服务端环境没有 window 对象
    if (isServer()) {
      logger.debug('在服务端环境调用 deserialize，返回 null');
      return null;
    }

    try {
      // 使用 @nami/shared 的 hydrateData 从 window 读取数据
      const data = hydrateData<T>(this.variableName);

      if (data === null) {
        logger.debug('window 上未找到初始数据', {
          variableName: this.variableName,
        });
      } else {
        logger.debug('成功从 window 读取初始数据', {
          variableName: this.variableName,
        });
      }

      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('数据反序列化失败', { error: message });
      return null;
    }
  }

  /**
   * 清理客户端 window 上的初始数据
   *
   * 在客户端数据读取完成后调用，避免全局变量持续占用内存。
   * 同时防止敏感数据在 DevTools 中被查看。
   */
  cleanup(): void {
    if (isServer()) return;

    try {
      // 删除 window 上的数据变量
      delete (window as Record<string, unknown>)[this.variableName];
      logger.debug('已清理 window 上的初始数据', {
        variableName: this.variableName,
      });
    } catch (error) {
      // 清理失败不影响业务流程
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('清理初始数据失败', { error: message });
    }
  }
}
