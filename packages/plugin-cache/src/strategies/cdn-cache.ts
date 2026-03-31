/**
 * @nami/plugin-cache - CDN 缓存管理器
 *
 * 负责生成符合 HTTP 规范的 Cache-Control 响应头，
 * 用于控制 CDN 和浏览器的缓存行为。
 *
 * HTTP 缓存指令说明：
 * - public:                  响应可被任何缓存存储（CDN、代理、浏览器）
 * - private:                 响应仅可被浏览器缓存，CDN/代理不可缓存
 * - no-cache:                每次使用前必须向源站验证（可缓存但需重验证）
 * - no-store:                完全不缓存，每次必须从源站获取
 * - max-age=N:               浏览器缓存有效期（秒）
 * - s-maxage=N:              共享缓存（CDN/代理）有效期（秒），覆盖 max-age
 * - stale-while-revalidate=N: 允许在过期后 N 秒内返回旧内容，同时后台重验证
 * - stale-if-error=N:        当源站返回错误时，允许使用过期缓存 N 秒
 * - must-revalidate:         过期后必须向源站重验证，不允许返回过期内容
 * - immutable:               内容永不变化（适用于带 hash 的静态资源）
 *
 * @see https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Headers/Cache-Control
 */

/**
 * CDN 缓存策略配置
 */
export interface CDNCacheConfig {
  /**
   * 缓存作用域
   * - 'public':  CDN 和浏览器都可缓存（默认）
   * - 'private': 仅浏览器可缓存
   * @default 'public'
   */
  scope?: 'public' | 'private';

  /**
   * 浏览器缓存有效期（秒）
   * 对应 max-age 指令
   * @default 0
   */
  maxAge?: number;

  /**
   * CDN/共享缓存有效期（秒）
   * 对应 s-maxage 指令，仅在 scope 为 'public' 时有效
   * 如果设置，会覆盖 CDN 层的 max-age
   */
  sMaxAge?: number;

  /**
   * 过期后允许返回旧内容的时间窗口（秒）
   * 对应 stale-while-revalidate 指令
   * 在此期间 CDN 会返回旧内容，同时后台触发重验证
   */
  staleWhileRevalidate?: number;

  /**
   * 源站出错时允许使用过期缓存的时间窗口（秒）
   * 对应 stale-if-error 指令
   */
  staleIfError?: number;

  /**
   * 是否禁止缓存
   * true 时生成 'no-store' 指令
   * @default false
   */
  noStore?: boolean;

  /**
   * 是否要求每次重验证
   * true 时生成 'no-cache' 指令（可缓存但每次需验证）
   * @default false
   */
  noCache?: boolean;

  /**
   * 过期后是否必须重验证
   * true 时生成 'must-revalidate' 指令
   * @default false
   */
  mustRevalidate?: boolean;

  /**
   * 是否标记为不可变
   * true 时生成 'immutable' 指令
   * 适用于带有内容哈希的静态资源 URL
   * @default false
   */
  immutable?: boolean;
}

/**
 * 预设的缓存策略名称
 */
export type CDNCachePreset =
  | 'no-cache'       // 不缓存
  | 'short'          // 短期缓存（5 分钟）
  | 'medium'         // 中等缓存（1 小时）
  | 'long'           // 长期缓存（1 天）
  | 'immutable'      // 永久缓存（带 hash 的静态资源）
  | 'isr';           // ISR 模式（stale-while-revalidate）

/**
 * CDN 缓存管理器
 *
 * 提供 Cache-Control 响应头的生成能力。
 * 支持自定义配置和预设策略两种方式。
 *
 * @example
 * ```typescript
 * const manager = new CDNCacheManager();
 *
 * // 使用预设策略
 * const header = manager.getPresetHeader('isr');
 * // => "public, max-age=0, s-maxage=60, stale-while-revalidate=86400"
 *
 * // 使用自定义配置
 * const custom = manager.generateHeader({
 *   scope: 'public',
 *   maxAge: 60,
 *   sMaxAge: 3600,
 *   staleWhileRevalidate: 86400,
 * });
 * // => "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400"
 * ```
 */
export class CDNCacheManager {
  /**
   * 预设缓存策略定义
   * 提供常见场景的开箱即用配置
   */
  private static readonly PRESETS: Record<CDNCachePreset, CDNCacheConfig> = {
    /**
     * 不缓存策略
     * 适用于：用户个性化页面、包含敏感数据的页面
     */
    'no-cache': {
      noStore: true,
    },

    /**
     * 短期缓存（5 分钟）
     * 适用于：频繁更新的首页、列表页
     */
    'short': {
      scope: 'public',
      maxAge: 60,           // 浏览器缓存 1 分钟
      sMaxAge: 300,         // CDN 缓存 5 分钟
      staleWhileRevalidate: 60,
    },

    /**
     * 中等缓存（1 小时）
     * 适用于：商品详情页、文章详情页
     */
    'medium': {
      scope: 'public',
      maxAge: 300,          // 浏览器缓存 5 分钟
      sMaxAge: 3600,        // CDN 缓存 1 小时
      staleWhileRevalidate: 3600,
      staleIfError: 86400,  // 源站出错时可用旧缓存 1 天
    },

    /**
     * 长期缓存（1 天）
     * 适用于：变化不频繁的内容页
     */
    'long': {
      scope: 'public',
      maxAge: 3600,         // 浏览器缓存 1 小时
      sMaxAge: 86400,       // CDN 缓存 1 天
      staleWhileRevalidate: 86400,
      staleIfError: 259200, // 源站出错时可用旧缓存 3 天
    },

    /**
     * 永久缓存（适用于带 hash 的静态资源）
     * 文件名中包含内容 hash，内容永不变化
     */
    'immutable': {
      scope: 'public',
      maxAge: 31536000,     // 1 年
      immutable: true,
    },

    /**
     * ISR 模式
     * 浏览器不缓存，CDN 缓存并支持 stale-while-revalidate
     */
    'isr': {
      scope: 'public',
      maxAge: 0,            // 浏览器不缓存
      sMaxAge: 60,          // CDN 缓存 1 分钟
      staleWhileRevalidate: 86400, // 过期后允许返回旧内容最多 1 天
      staleIfError: 86400,  // 源站出错时可用旧缓存 1 天
    },
  };

  /**
   * 根据配置生成 Cache-Control 响应头字符串
   *
   * 按照 HTTP 规范的推荐顺序拼装指令。
   *
   * @param config - CDN 缓存配置
   * @returns Cache-Control 头字符串
   */
  generateHeader(config: CDNCacheConfig): string {
    const directives: string[] = [];

    // 1. no-store 优先级最高，设置后其他指令无意义
    if (config.noStore) {
      return 'no-store';
    }

    // 2. no-cache 表示可缓存但每次必须重验证
    if (config.noCache) {
      directives.push('no-cache');
    }

    // 3. 缓存作用域
    if (config.scope === 'private') {
      directives.push('private');
    } else {
      // 默认为 public
      directives.push('public');
    }

    // 4. max-age（浏览器缓存时间）
    if (config.maxAge !== undefined && config.maxAge >= 0) {
      directives.push(`max-age=${config.maxAge}`);
    }

    // 5. s-maxage（CDN/共享缓存时间）
    // 仅在 public 作用域下有意义
    if (config.sMaxAge !== undefined && config.sMaxAge >= 0 && config.scope !== 'private') {
      directives.push(`s-maxage=${config.sMaxAge}`);
    }

    // 6. stale-while-revalidate（过期后允许返回旧内容的窗口）
    if (config.staleWhileRevalidate !== undefined && config.staleWhileRevalidate > 0) {
      directives.push(`stale-while-revalidate=${config.staleWhileRevalidate}`);
    }

    // 7. stale-if-error（源站出错时允许使用过期缓存的窗口）
    if (config.staleIfError !== undefined && config.staleIfError > 0) {
      directives.push(`stale-if-error=${config.staleIfError}`);
    }

    // 8. must-revalidate
    if (config.mustRevalidate) {
      directives.push('must-revalidate');
    }

    // 9. immutable（内容永不变化）
    if (config.immutable) {
      directives.push('immutable');
    }

    return directives.join(', ');
  }

  /**
   * 获取预设策略的 Cache-Control 头
   *
   * @param preset - 预设策略名称
   * @returns Cache-Control 头字符串
   */
  getPresetHeader(preset: CDNCachePreset): string {
    const config = CDNCacheManager.PRESETS[preset];
    if (!config) {
      throw new Error(`[CDNCacheManager] 未知的预设策略: ${preset}`);
    }
    return this.generateHeader(config);
  }

  /**
   * 获取预设策略的原始配置
   *
   * @param preset - 预设策略名称
   * @returns CDN 缓存配置
   */
  getPresetConfig(preset: CDNCachePreset): CDNCacheConfig {
    const config = CDNCacheManager.PRESETS[preset];
    if (!config) {
      throw new Error(`[CDNCacheManager] 未知的预设策略: ${preset}`);
    }
    // 返回副本，防止外部修改预设配置
    return { ...config };
  }

  /**
   * 根据 ISR revalidate 配置动态生成 Cache-Control 头
   *
   * 这是专为 ISR 模式设计的便捷方法：
   * - 浏览器不缓存（max-age=0），确保用户总是发起请求
   * - CDN 缓存指定时间（s-maxage），减少源站压力
   * - 过期后允许返回旧内容（stale-while-revalidate），实现无缝更新
   *
   * @param revalidate - ISR 重验证间隔（秒）
   * @param staleWindow - stale-while-revalidate 窗口（秒），默认 24 小时
   * @returns Cache-Control 头字符串
   */
  generateISRHeader(revalidate: number, staleWindow: number = 86400): string {
    return this.generateHeader({
      scope: 'public',
      maxAge: 0,
      sMaxAge: revalidate,
      staleWhileRevalidate: staleWindow,
      staleIfError: staleWindow,
    });
  }

  /**
   * 解析 Cache-Control 头字符串为配置对象
   *
   * 将已有的 Cache-Control 头反解析为 CDNCacheConfig，
   * 便于在已有基础上修改配置。
   *
   * @param header - Cache-Control 头字符串
   * @returns 解析后的配置对象
   */
  parseHeader(header: string): CDNCacheConfig {
    const config: CDNCacheConfig = {};
    const directives = header.split(',').map((d) => d.trim().toLowerCase());

    for (const directive of directives) {
      // 处理带值的指令
      if (directive.includes('=')) {
        const [key, value] = directive.split('=');
        const trimmedKey = key?.trim();
        const numValue = parseInt(value?.trim() ?? '0', 10);

        switch (trimmedKey) {
          case 'max-age':
            config.maxAge = numValue;
            break;
          case 's-maxage':
            config.sMaxAge = numValue;
            break;
          case 'stale-while-revalidate':
            config.staleWhileRevalidate = numValue;
            break;
          case 'stale-if-error':
            config.staleIfError = numValue;
            break;
        }
      } else {
        // 处理无值的指令
        switch (directive) {
          case 'public':
            config.scope = 'public';
            break;
          case 'private':
            config.scope = 'private';
            break;
          case 'no-cache':
            config.noCache = true;
            break;
          case 'no-store':
            config.noStore = true;
            break;
          case 'must-revalidate':
            config.mustRevalidate = true;
            break;
          case 'immutable':
            config.immutable = true;
            break;
        }
      }
    }

    return config;
  }
}
