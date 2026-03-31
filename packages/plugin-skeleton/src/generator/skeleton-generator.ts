/**
 * @nami/plugin-skeleton - 骨架屏生成器
 *
 * 自动从页面 DOM 结构分析并生成骨架屏表示。
 *
 * 工作原理：
 * 1. 遍历目标 DOM 节点树
 * 2. 识别各类可见元素（文本、图片、按钮、输入框等）
 * 3. 提取元素的位置和尺寸信息
 * 4. 生成对应的骨架屏描述数据结构
 * 5. 可在构建时（通过 Puppeteer 等）或运行时使用
 *
 * 支持的节点类型自动映射：
 * - 文本节点 / <p> / <h1-h6> / <span> → SkeletonText
 * - <img> / 含背景图的元素 → SkeletonImage
 * - <button> / <a class="btn"> → SkeletonButton
 * - <input> / <textarea> → SkeletonText（输入框样式）
 * - 列表容器 → 重复的列表项骨架
 */

/**
 * 骨架节点类型
 */
export type SkeletonNodeType = 'text' | 'image' | 'avatar' | 'button' | 'container' | 'divider';

/**
 * 骨架节点描述
 *
 * 描述单个骨架屏元素的类型、位置和尺寸。
 */
export interface SkeletonNode {
  /** 节点类型 */
  type: SkeletonNodeType;
  /** 距左偏移（px） */
  x: number;
  /** 距顶偏移（px） */
  y: number;
  /** 宽度（px） */
  width: number;
  /** 高度（px） */
  height: number;
  /** 圆角（px） */
  borderRadius: number;
  /** 文本行数（仅 text 类型有效） */
  lines?: number;
  /** 子节点 */
  children?: SkeletonNode[];
}

/**
 * 骨架屏描述
 *
 * 完整的骨架屏数据结构，包含页面尺寸和所有骨架节点。
 */
export interface SkeletonDescriptor {
  /** 页面宽度 */
  width: number;
  /** 页面高度 */
  height: number;
  /** 背景色 */
  backgroundColor: string;
  /** 骨架节点列表 */
  nodes: SkeletonNode[];
  /** 生成时间戳 */
  generatedAt: number;
  /** 来源路由路径 */
  routePath?: string;
}

/**
 * 骨架屏生成器配置
 */
export interface SkeletonGeneratorOptions {
  /**
   * 要分析的根元素选择器
   * @default '#root'
   */
  rootSelector?: string;

  /**
   * 需要忽略的元素选择器列表
   * 匹配的元素及其子树将被跳过
   */
  ignoreSelectors?: string[];

  /**
   * 最小可见元素尺寸（px）
   * 小于此尺寸的元素将被忽略
   * @default 8
   */
  minSize?: number;

  /**
   * 最大遍历深度
   * 防止在极深的 DOM 树上消耗过多资源
   * @default 20
   */
  maxDepth?: number;

  /**
   * 文本元素行高估算值（px）
   * 用于从总高度推算文本行数
   * @default 20
   */
  estimatedLineHeight?: number;

  /**
   * 是否将圆形元素自动识别为头像
   * 判断条件：宽高相等且 borderRadius >= 50%
   * @default true
   */
  detectAvatar?: boolean;

  /**
   * 自定义节点类型映射
   * 可根据元素的类名或属性指定骨架类型
   */
  customMappings?: Array<{
    selector: string;
    type: SkeletonNodeType;
  }>;
}

/**
 * 骨架屏生成器
 *
 * 分析 DOM 结构并生成骨架屏描述数据。
 *
 * @example
 * ```typescript
 * // 运行时使用（浏览器环境）
 * const generator = new SkeletonGenerator({
 *   rootSelector: '#app',
 *   ignoreSelectors: ['.hidden', '[data-skeleton-ignore]'],
 * });
 *
 * const descriptor = generator.generate();
 * console.log(`生成了 ${descriptor.nodes.length} 个骨架节点`);
 *
 * // 构建时使用（通过 Puppeteer）
 * const html = generator.generateHTML(descriptor);
 * ```
 */
export class SkeletonGenerator {
  /** 生成器配置 */
  private readonly options: Required<
    Pick<SkeletonGeneratorOptions, 'rootSelector' | 'minSize' | 'maxDepth' | 'estimatedLineHeight' | 'detectAvatar'>
  > & SkeletonGeneratorOptions;

  constructor(options: SkeletonGeneratorOptions = {}) {
    this.options = {
      ...options,
      rootSelector: options.rootSelector ?? '#root',
      minSize: options.minSize ?? 8,
      maxDepth: options.maxDepth ?? 20,
      estimatedLineHeight: options.estimatedLineHeight ?? 20,
      detectAvatar: options.detectAvatar ?? true,
    };
  }

  /**
   * 从当前页面 DOM 生成骨架屏描述
   *
   * 仅在浏览器环境下可用。遍历根元素下的所有可见元素，
   * 分析其类型和几何信息，生成骨架屏描述数据。
   *
   * @param routePath - 可选的路由路径标识
   * @returns 骨架屏描述数据
   */
  generate(routePath?: string): SkeletonDescriptor {
    if (typeof document === 'undefined') {
      throw new Error('[SkeletonGenerator] 仅支持在浏览器环境下调用 generate()');
    }

    const rootElement = document.querySelector(this.options.rootSelector);
    if (!rootElement) {
      throw new Error(`[SkeletonGenerator] 未找到根元素: ${this.options.rootSelector}`);
    }

    const rootRect = rootElement.getBoundingClientRect();
    const nodes = this.analyzeElement(rootElement as HTMLElement, rootRect, 0);

    return {
      width: rootRect.width,
      height: rootRect.height,
      backgroundColor: this.getBackgroundColor(rootElement as HTMLElement),
      nodes,
      generatedAt: Date.now(),
      routePath,
    };
  }

  /**
   * 将骨架屏描述数据转换为内联 HTML 字符串
   *
   * 生成的 HTML 可直接嵌入 SSR 输出中，作为首屏加载占位。
   * 不依赖任何外部 CSS 或 JS，完全自包含。
   *
   * @param descriptor - 骨架屏描述
   * @returns HTML 字符串
   */
  generateHTML(descriptor: SkeletonDescriptor): string {
    const nodesHTML = descriptor.nodes.map((node) => this.nodeToHTML(node)).join('\n');

    return `
<div
  data-nami-skeleton="generated"
  style="position:relative;width:${descriptor.width}px;height:${descriptor.height}px;background:${descriptor.backgroundColor};overflow:hidden"
  role="presentation"
  aria-label="页面加载中"
>
  <style>
    @keyframes nami-skeleton-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  </style>
  ${nodesHTML}
</div>`.trim();
  }

  /**
   * 从描述数据生成 JSON 字符串
   *
   * 可用于构建时序列化存储，运行时反序列化渲染。
   *
   * @param descriptor - 骨架屏描述
   * @returns JSON 字符串
   */
  serialize(descriptor: SkeletonDescriptor): string {
    return JSON.stringify(descriptor);
  }

  /**
   * 从 JSON 字符串反序列化骨架屏描述
   *
   * @param json - JSON 字符串
   * @returns 骨架屏描述
   */
  deserialize(json: string): SkeletonDescriptor {
    return JSON.parse(json) as SkeletonDescriptor;
  }

  /**
   * 分析单个 DOM 元素
   *
   * 递归遍历元素树，对每个可见元素判断其骨架类型并提取几何信息。
   */
  private analyzeElement(
    element: HTMLElement,
    rootRect: DOMRect,
    depth: number,
  ): SkeletonNode[] {
    // 超过最大深度，停止遍历
    if (depth > this.options.maxDepth) return [];

    const nodes: SkeletonNode[] = [];

    const children = element.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      if (!child) continue;

      // 检查是否需要忽略
      if (this.shouldIgnore(child)) continue;

      // 检查元素是否可见
      if (!this.isVisible(child)) continue;

      const rect = child.getBoundingClientRect();

      // 过滤太小的元素
      if (rect.width < this.options.minSize || rect.height < this.options.minSize) continue;

      // 检查自定义映射
      const customType = this.getCustomType(child);
      if (customType) {
        nodes.push(this.createNode(customType, rect, rootRect, child));
        continue;
      }

      // 判断元素类型
      const nodeType = this.detectNodeType(child, rect);

      if (nodeType) {
        const node = this.createNode(nodeType, rect, rootRect, child);

        // 文本类型需要推算行数
        if (nodeType === 'text') {
          node.lines = Math.max(1, Math.round(rect.height / this.options.estimatedLineHeight));
        }

        nodes.push(node);
      } else {
        // 非叶子节点，继续递归分析子元素
        const childNodes = this.analyzeElement(child, rootRect, depth + 1);
        nodes.push(...childNodes);
      }
    }

    return nodes;
  }

  /**
   * 检测元素的骨架节点类型
   */
  private detectNodeType(element: HTMLElement, rect: DOMRect): SkeletonNodeType | null {
    const tagName = element.tagName.toLowerCase();
    const computedStyle = window.getComputedStyle(element);

    // 图片元素
    if (tagName === 'img' || tagName === 'video' || tagName === 'canvas') {
      return 'image';
    }

    // 带背景图的元素
    const bgImage = computedStyle.backgroundImage;
    if (bgImage && bgImage !== 'none' && bgImage !== 'initial') {
      return 'image';
    }

    // SVG 元素
    if (tagName === 'svg') {
      return 'image';
    }

    // 按钮元素
    if (
      tagName === 'button' ||
      element.getAttribute('role') === 'button' ||
      (tagName === 'a' && element.classList.contains('btn'))
    ) {
      return 'button';
    }

    // 输入框
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
      return 'text';
    }

    // 分割线
    if (tagName === 'hr') {
      return 'divider';
    }

    // 头像检测（宽高相等且为圆形）
    if (this.options.detectAvatar) {
      const isSquare = Math.abs(rect.width - rect.height) < 4;
      const borderRadius = parseFloat(computedStyle.borderRadius);
      const isCircle = borderRadius >= Math.min(rect.width, rect.height) / 2;
      if (isSquare && isCircle && rect.width >= 20 && rect.width <= 100) {
        return 'avatar';
      }
    }

    // 文本元素（叶子节点包含文本内容）
    if (this.isTextElement(element)) {
      return 'text';
    }

    // 非叶子节点返回 null，继续遍历子元素
    return null;
  }

  /**
   * 判断是否为文本元素
   */
  private isTextElement(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    const textTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'li', 'td', 'th', 'dt', 'dd'];

    if (textTags.includes(tagName)) {
      return true;
    }

    // 检查是否为叶子节点（没有子元素但有文本内容）
    if (element.children.length === 0 && element.textContent && element.textContent.trim().length > 0) {
      return true;
    }

    return false;
  }

  /**
   * 创建骨架节点
   */
  private createNode(
    type: SkeletonNodeType,
    rect: DOMRect,
    rootRect: DOMRect,
    element: HTMLElement,
  ): SkeletonNode {
    const computedStyle = window.getComputedStyle(element);
    const borderRadius = parseFloat(computedStyle.borderRadius) || 0;

    return {
      type,
      x: Math.round(rect.left - rootRect.left),
      y: Math.round(rect.top - rootRect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      borderRadius: Math.round(borderRadius),
    };
  }

  /**
   * 检查元素是否应被忽略
   */
  private shouldIgnore(element: HTMLElement): boolean {
    // 检查 data 属性
    if (element.hasAttribute('data-skeleton-ignore')) return true;

    // 检查自定义忽略选择器
    if (this.options.ignoreSelectors) {
      for (const selector of this.options.ignoreSelectors) {
        if (element.matches(selector)) return true;
      }
    }

    return false;
  }

  /**
   * 检查元素是否可见
   */
  private isVisible(element: HTMLElement): boolean {
    const computedStyle = window.getComputedStyle(element);

    if (computedStyle.display === 'none') return false;
    if (computedStyle.visibility === 'hidden') return false;
    if (computedStyle.opacity === '0') return false;

    // 检查元素是否有实际尺寸
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    return true;
  }

  /**
   * 获取自定义类型映射
   */
  private getCustomType(element: HTMLElement): SkeletonNodeType | null {
    if (!this.options.customMappings) return null;

    for (const mapping of this.options.customMappings) {
      if (element.matches(mapping.selector)) {
        return mapping.type;
      }
    }

    return null;
  }

  /**
   * 获取元素背景色
   */
  private getBackgroundColor(element: HTMLElement): string {
    const computedStyle = window.getComputedStyle(element);
    const bgColor = computedStyle.backgroundColor;

    // 如果是透明的，取 body 的背景色
    if (bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') {
      if (typeof document !== 'undefined') {
        return window.getComputedStyle(document.body).backgroundColor || '#ffffff';
      }
      return '#ffffff';
    }

    return bgColor;
  }

  /**
   * 将骨架节点转换为 HTML
   */
  private nodeToHTML(node: SkeletonNode): string {
    const bgColor = '#e0e0e0';
    const style = [
      'position:absolute',
      `left:${node.x}px`,
      `top:${node.y}px`,
      `width:${node.width}px`,
      `height:${node.height}px`,
      `background:${bgColor}`,
      `border-radius:${node.borderRadius}px`,
      'animation:nami-skeleton-pulse 1.5s ease-in-out infinite',
    ].join(';');

    return `<div style="${style}"></div>`;
  }
}
