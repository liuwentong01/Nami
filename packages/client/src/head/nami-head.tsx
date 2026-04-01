/**
 * @nami/client - NamiHead 文档头管理组件
 *
 * NamiHead 用于在客户端动态管理 document.head 中的内容，
 * 包括 <title>、<meta>、<link>、<script> 等标签。
 *
 * 设计原理：
 * 1. 声明式 API — 开发者通过 JSX 声明需要的 head 标签
 * 2. CSR 模式 — 组件在 useEffect 中直接操作 document.head DOM
 * 3. SSR 模式 — 通过 HeadManagerContext 收集所有标签，渲染完成后统一输出 HTML
 * 4. 去重机制 — 通过 key/name/property 属性防止重复标签
 * 5. 嵌套合并 — 多个 NamiHead 嵌套时，深层覆盖浅层（title 取最后一个）
 * 6. 自动清理 — 组件卸载时移除其添加的所有标签
 *
 * 与 SSR 的配合：
 * - SSR 阶段：通过 HeadManagerContext.Provider 注入收集器，
 *   所有 NamiHead 组件在渲染时将 head 标签注册到收集器中
 * - 渲染完成后：调用 createSSRHeadManager().getCollectedTags() 获取去重后的标签
 * - 最后通过 renderHeadToString() 生成 <head> 内的 HTML 字符串
 *
 * 为什么不用 react-helmet？
 * - 减少依赖体积
 * - 更精确的控制（去重、清理逻辑）
 * - 与 Nami 框架的 SSR 渲染管线深度集成
 *
 * @module
 */

import React, { createContext, useContext, useEffect, useRef } from 'react';
import { createLogger } from '@nami/shared';

// ==================== 类型定义 ====================

/**
 * Meta 标签配置
 */
export interface MetaTag {
  /** 去重键 — 同一 key 的 meta 标签只保留最后一个 */
  key?: string;
  /** name 属性（如 'description'、'keywords'） */
  name?: string;
  /** property 属性（如 'og:title'、'og:description'） */
  property?: string;
  /** http-equiv 属性（如 'content-type'） */
  httpEquiv?: string;
  /** content 属性值 */
  content: string;
  /** charset 属性 */
  charset?: string;
}

/**
 * Link 标签配置
 */
export interface LinkTag {
  /** 去重键 */
  key?: string;
  /** 关系类型（如 'stylesheet'、'icon'、'preload'） */
  rel: string;
  /** 资源 URL */
  href: string;
  /** 资源类型 */
  type?: string;
  /** 媒体查询 */
  media?: string;
  /** 跨域设置 */
  crossOrigin?: string;
  /** 资源预加载的 as 属性 */
  as?: string;
  /** 图标尺寸 */
  sizes?: string;
}

/**
 * Script 标签配置
 */
export interface ScriptTag {
  /** 去重键 */
  key?: string;
  /** 脚本 URL（外部脚本） */
  src?: string;
  /** 内联脚本内容 */
  innerHTML?: string;
  /** 脚本类型 */
  type?: string;
  /** 是否异步加载 */
  async?: boolean;
  /** 是否延迟执行 */
  defer?: boolean;
  /** 跨域设置 */
  crossOrigin?: string;
}

/**
 * NamiHead 组件 Props
 */
export interface NamiHeadProps {
  /** 页面标题 */
  title?: string;

  /** Meta 标签列表 */
  meta?: MetaTag[];

  /** Link 标签列表 */
  link?: LinkTag[];

  /** Script 标签列表 */
  script?: ScriptTag[];

  /**
   * 标题模板
   *
   * 支持 %s 占位符，用于在标题前后添加统一的前后缀。
   * @example '%s | My App' — 传入 title='首页' → '首页 | My App'
   */
  titleTemplate?: string;

  /**
   * 默认标题
   *
   * 当 title 未传入时使用此默认值。
   */
  defaultTitle?: string;
}

/**
 * 收集到的 head 标签集合
 *
 * SSR 模式下 NamiHead 将标签数据注册到 HeadManagerContext 中，
 * 渲染完成后从收集器中获取此结构。
 */
export interface CollectedHeadTags {
  /** 页面标题（去重后取最后一个） */
  title?: string;
  /** meta 标签列表（按 key 去重） */
  meta?: MetaTag[];
  /** link 标签列表（按 key 去重） */
  link?: LinkTag[];
  /** script 标签列表（按 key 去重） */
  script?: ScriptTag[];
}

/**
 * HeadManager 上下文接口
 *
 * 用于 SSR 阶段收集所有 NamiHead 组件声明的 head 标签。
 * CSR 阶段则直接操作 DOM，不需要通过上下文收集。
 */
export interface HeadManagerContextValue {
  /** 收集 head 标签（SSR 模式使用） */
  collectTags: (tags: CollectedHeadTags) => void;
  /** 是否处于 SSR 模式 */
  isSSR: boolean;
}

// ==================== 上下文 ====================

/**
 * HeadManager Context
 *
 * 在 SSR 阶段，服务端渲染器通过 Provider 注入一个收集器，
 * NamiHead 组件通过此上下文向收集器注册 head 标签。
 * 渲染完成后，服务端从收集器中读取所有标签生成 <head> HTML。
 *
 * CSR 阶段使用默认值（isSSR=false），NamiHead 直接操作 DOM。
 */
export const HeadManagerContext = createContext<HeadManagerContextValue>({
  collectTags: () => {
    /* 默认空操作 — CSR 模式下通过 DOM 操作管理 head */
  },
  isSSR: false,
});

HeadManagerContext.displayName = 'HeadManagerContext';

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:nami-head');

/** Nami Head 管理的 DOM 元素标记属性 — 用于清理时识别 */
const NAMI_HEAD_ATTR = 'data-nami-head';

/**
 * 全局去重映射
 *
 * key → DOM 元素的映射，确保同一 key 只存在一个标签。
 * 当新组件使用相同 key 注入标签时，旧标签会被替换。
 */
const dedupeMap = new Map<string, HTMLElement>();

/**
 * 获取 meta 标签的去重键
 */
function getMetaDedupeKey(tag: MetaTag): string {
  return tag.key || tag.name || tag.property || tag.httpEquiv || `meta:${tag.content}`;
}

/**
 * 获取 link 标签的去重键
 */
function getLinkDedupeKey(tag: LinkTag): string {
  return tag.key || `${tag.rel}:${tag.href}`;
}

/**
 * 获取 script 标签的去重键
 */
function getScriptDedupeKey(tag: ScriptTag): string {
  return tag.key || tag.src || `inline:${(tag.innerHTML || '').slice(0, 50)}`;
}

/**
 * 创建并配置 meta 标签
 */
function createMetaElement(tag: MetaTag): HTMLMetaElement {
  const meta = document.createElement('meta');
  if (tag.name) meta.name = tag.name;
  if (tag.property) meta.setAttribute('property', tag.property);
  if (tag.httpEquiv) meta.httpEquiv = tag.httpEquiv;
  if (tag.content) meta.content = tag.content;
  if (tag.charset) meta.setAttribute('charset', tag.charset);
  meta.setAttribute(NAMI_HEAD_ATTR, 'true');
  return meta;
}

/**
 * 创建并配置 link 标签
 */
function createLinkElement(tag: LinkTag): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = tag.rel;
  link.href = tag.href;
  if (tag.type) link.type = tag.type;
  if (tag.media) link.media = tag.media;
  if (tag.crossOrigin) link.crossOrigin = tag.crossOrigin;
  if (tag.as) link.setAttribute('as', tag.as);
  if (tag.sizes) link.setAttribute('sizes', tag.sizes);
  link.setAttribute(NAMI_HEAD_ATTR, 'true');
  return link;
}

/**
 * 创建并配置 script 标签
 */
function createScriptElement(tag: ScriptTag): HTMLScriptElement {
  const script = document.createElement('script');
  if (tag.src) script.src = tag.src;
  if (tag.innerHTML) script.innerHTML = tag.innerHTML;
  if (tag.type) script.type = tag.type;
  if (tag.async !== undefined) script.async = tag.async;
  if (tag.defer !== undefined) script.defer = tag.defer;
  if (tag.crossOrigin) script.crossOrigin = tag.crossOrigin;
  script.setAttribute(NAMI_HEAD_ATTR, 'true');
  return script;
}

/**
 * 插入或替换 head 中的元素
 *
 * 如果存在相同 key 的旧元素，先移除旧元素再插入新元素。
 *
 * @param element - 要插入的 DOM 元素
 * @param key     - 去重键（可选）
 * @returns 插入后的 DOM 元素
 */
function insertOrReplace(element: HTMLElement, key?: string): HTMLElement {
  if (key) {
    // 去重：移除已有的同 key 元素
    const existing = dedupeMap.get(key);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    dedupeMap.set(key, element);
  }

  document.head.appendChild(element);
  return element;
}

/**
 * 基础 HTML 转义
 * 防止属性值中的特殊字符引起 HTML 注入
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==================== 组件实现 ====================

/**
 * Nami 文档头管理组件
 *
 * 在 React 组件树中声明式地管理 document.head 的内容。
 * 支持两种工作模式：
 *
 * 1. CSR 模式（默认）：组件挂载时通过 DOM API 注入标签，卸载时自动清理
 * 2. SSR 模式：通过 HeadManagerContext 收集标签信息，不执行 DOM 操作
 *
 * 去重规则：
 * - title: 嵌套的 NamiHead 中，最后渲染的 title 生效
 * - meta:  按 key/name/property 去重，后者覆盖前者
 * - link:  按 key 或 rel+href 组合去重
 * - script: 按 key 或 src 去重
 *
 * @example
 * ```tsx
 * // 基础用法 — 设置标题和 meta
 * function HomePage() {
 *   return (
 *     <>
 *       <NamiHead
 *         title="首页"
 *         titleTemplate="%s | Nami App"
 *         meta={[
 *           { key: 'description', name: 'description', content: '这是首页' },
 *           { key: 'og-title', property: 'og:title', content: '首页' },
 *         ]}
 *       />
 *       <div>页面内容</div>
 *     </>
 *   );
 * }
 *
 * // 预加载资源
 * function ArticlePage() {
 *   return (
 *     <>
 *       <NamiHead
 *         title="文章详情"
 *         link={[
 *           { key: 'font', rel: 'preload', href: '/fonts/main.woff2', as: 'font' },
 *         ]}
 *         script={[
 *           { key: 'analytics', src: '/js/analytics.js', async: true },
 *         ]}
 *       />
 *       <article>...</article>
 *     </>
 *   );
 * }
 * ```
 */
export const NamiHead: React.FC<NamiHeadProps> = ({
  title,
  meta,
  link,
  script,
  titleTemplate,
  defaultTitle,
}) => {
  /** 从上下文获取 SSR 收集器 */
  const { collectTags, isSSR } = useContext(HeadManagerContext);

  /**
   * 记录当前组件实例插入的所有 DOM 元素
   * 用于组件卸载时精确清理
   */
  const managedElementsRef = useRef<HTMLElement[]>([]);

  /**
   * 保存上一次的 document.title
   * 组件卸载时恢复
   */
  const previousTitleRef = useRef<string>(
    typeof document !== 'undefined' ? document.title : '',
  );

  /**
   * 计算最终标题值
   * 应用标题模板（如果配置了的话）
   */
  const resolvedTitle = (() => {
    const rawTitle = title || defaultTitle;
    if (!rawTitle) return undefined;
    if (titleTemplate && title) {
      return titleTemplate.replace('%s', title);
    }
    return rawTitle;
  })();

  // ==================== SSR 模式处理 ====================

  /**
   * SSR 模式下：通过上下文收集标签数据，不执行 DOM 操作。
   * 注意：这里不能 early return，否则下面的 useEffect 会被条件跳过，
   * 违反 React Hooks 规则（hooks 调用次数必须在每次渲染中一致）。
   */
  if (isSSR) {
    collectTags({
      title: resolvedTitle,
      meta: meta || [],
      link: link || [],
      script: script || [],
    });

    logger.debug('SSR 模式：收集 head 标签', {
      title: resolvedTitle,
      metaCount: meta?.length ?? 0,
      linkCount: link?.length ?? 0,
      scriptCount: script?.length ?? 0,
    });
  }

  // ==================== CSR 模式处理 ====================

  useEffect(() => {
    // SSR 模式或服务端环境下不执行 DOM 操作
    if (isSSR || typeof document === 'undefined') return;

    const elements: HTMLElement[] = [];

    if (resolvedTitle !== undefined) {
      document.title = resolvedTitle;
      logger.debug('设置页面标题', { title: resolvedTitle });
    }

    if (meta) {
      for (const tag of meta) {
        const metaEl = createMetaElement(tag);
        const key = getMetaDedupeKey(tag);
        insertOrReplace(metaEl, key);
        elements.push(metaEl);
      }
    }

    if (link) {
      for (const tag of link) {
        const linkEl = createLinkElement(tag);
        const key = getLinkDedupeKey(tag);
        insertOrReplace(linkEl, key);
        elements.push(linkEl);
      }
    }

    if (script) {
      for (const tag of script) {
        const scriptEl = createScriptElement(tag);
        const key = getScriptDedupeKey(tag);
        insertOrReplace(scriptEl, key);
        elements.push(scriptEl);
      }
    }

    managedElementsRef.current = elements;

    logger.debug('NamiHead 已更新', {
      metaCount: meta?.length ?? 0,
      linkCount: link?.length ?? 0,
      scriptCount: script?.length ?? 0,
    });

    return () => {
      if (resolvedTitle !== undefined) {
        document.title = previousTitleRef.current;
      }

      for (const element of managedElementsRef.current) {
        if (element.parentNode) {
          element.parentNode.removeChild(element);
        }
      }
      managedElementsRef.current = [];
      logger.debug('NamiHead 已清理');
    };
  }, [isSSR, resolvedTitle, meta, link, script]);

  return null;
};

NamiHead.displayName = 'NamiHead';

// ==================== SSR 工具函数 ====================

/**
 * 创建 SSR 用的 HeadManager 收集器
 *
 * 在服务端渲染时创建一个收集器实例，用于收集渲染过程中所有 NamiHead 组件
 * 声明的 head 标签。渲染完成后调用 getCollectedTags() 获取最终结果。
 *
 * 去重逻辑：
 * - title：后收集的覆盖先收集的（最后一个 NamiHead 的 title 生效）
 * - meta/link/script：按去重键覆盖，后出现的覆盖先出现的
 *
 * @returns HeadManager 实例，包含 Provider value 和获取结果的方法
 *
 * @example
 * ```typescript
 * // 服务端渲染流程
 * const headManager = createSSRHeadManager();
 *
 * const html = renderToString(
 *   <HeadManagerContext.Provider value={headManager.contextValue}>
 *     <App />
 *   </HeadManagerContext.Provider>
 * );
 *
 * const headTags = headManager.getCollectedTags();
 * const headHTML = renderHeadToString(headTags);
 * // 将 headHTML 注入到 HTML 模板的 <head> 区域
 * ```
 */
export function createSSRHeadManager(): {
  contextValue: HeadManagerContextValue;
  getCollectedTags: () => CollectedHeadTags;
} {
  /** 收集到的所有标签（可能有重复） */
  const allTags: CollectedHeadTags[] = [];

  const contextValue: HeadManagerContextValue = {
    collectTags: (tags: CollectedHeadTags) => {
      allTags.push(tags);
    },
    isSSR: true,
  };

  /**
   * 获取去重后的最终 head 标签集合
   *
   * 遍历所有收集到的标签，按去重键进行合并。
   * 同一个 key 的标签保留最后一个（后者覆盖前者）。
   */
  function getCollectedTags(): CollectedHeadTags {
    let finalTitle: string | undefined;
    const metaMap = new Map<string, MetaTag>();
    const linkMap = new Map<string, LinkTag>();
    const scriptMap = new Map<string, ScriptTag>();

    for (const tags of allTags) {
      // title — 后者覆盖前者（嵌套组件中最深层的 NamiHead title 生效）
      if (tags.title !== undefined) {
        finalTitle = tags.title;
      }

      // meta — 按去重键覆盖
      if (tags.meta) {
        for (const m of tags.meta) {
          metaMap.set(getMetaDedupeKey(m), m);
        }
      }

      // link — 按去重键覆盖
      if (tags.link) {
        for (const l of tags.link) {
          linkMap.set(getLinkDedupeKey(l), l);
        }
      }

      // script — 按去重键覆盖
      if (tags.script) {
        for (const s of tags.script) {
          scriptMap.set(getScriptDedupeKey(s), s);
        }
      }
    }

    return {
      title: finalTitle,
      meta: Array.from(metaMap.values()),
      link: Array.from(linkMap.values()),
      script: Array.from(scriptMap.values()),
    };
  }

  return { contextValue, getCollectedTags };
}

/**
 * 将收集到的 head 标签渲染为 HTML 字符串
 *
 * 供服务端渲染使用，将 CollectedHeadTags 对象转换为可直接插入 <head> 的 HTML。
 * 所有属性值都经过 HTML 转义处理，防止 XSS 注入。
 *
 * @param tags - 收集到的 head 标签集合（通常由 createSSRHeadManager().getCollectedTags() 获得）
 * @returns HTML 字符串（可安全插入 <head> 标签内）
 *
 * @example
 * ```typescript
 * const headTags = headManager.getCollectedTags();
 * const headHTML = renderHeadToString(headTags);
 * // headHTML:
 * // <title>首页 | My App</title>
 * // <meta name="description" content="这是首页" />
 * // <link rel="stylesheet" href="/styles/global.css" />
 * ```
 */
export function renderHeadToString(tags: CollectedHeadTags): string {
  const parts: string[] = [];

  // title 标签
  if (tags.title) {
    parts.push(`<title>${escapeHtml(tags.title)}</title>`);
  }

  // meta 标签
  if (tags.meta) {
    for (const m of tags.meta) {
      const attrs: string[] = [];
      if (m.name) attrs.push(`name="${escapeHtml(m.name)}"`);
      if (m.property) attrs.push(`property="${escapeHtml(m.property)}"`);
      if (m.httpEquiv) attrs.push(`http-equiv="${escapeHtml(m.httpEquiv)}"`);
      if (m.content) attrs.push(`content="${escapeHtml(m.content)}"`);
      if (m.charset) attrs.push(`charset="${escapeHtml(m.charset)}"`);
      parts.push(`<meta ${attrs.join(' ')} />`);
    }
  }

  // link 标签
  if (tags.link) {
    for (const l of tags.link) {
      const attrs: string[] = [
        `rel="${escapeHtml(l.rel)}"`,
        `href="${escapeHtml(l.href)}"`,
      ];
      if (l.type) attrs.push(`type="${escapeHtml(l.type)}"`);
      if (l.media) attrs.push(`media="${escapeHtml(l.media)}"`);
      if (l.crossOrigin) attrs.push(`crossorigin="${escapeHtml(l.crossOrigin)}"`);
      if (l.sizes) attrs.push(`sizes="${escapeHtml(l.sizes)}"`);
      if (l.as) attrs.push(`as="${escapeHtml(l.as)}"`);
      parts.push(`<link ${attrs.join(' ')} />`);
    }
  }

  // script 标签
  if (tags.script) {
    for (const s of tags.script) {
      const attrs: string[] = [];
      if (s.src) attrs.push(`src="${escapeHtml(s.src)}"`);
      if (s.type) attrs.push(`type="${escapeHtml(s.type)}"`);
      if (s.async) attrs.push('async');
      if (s.defer) attrs.push('defer');
      if (s.crossOrigin) attrs.push(`crossorigin="${escapeHtml(s.crossOrigin)}"`);

      const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
      if (s.innerHTML) {
        parts.push(`<script${attrStr}>${s.innerHTML}</script>`);
      } else {
        parts.push(`<script${attrStr}></script>`);
      }
    }
  }

  return parts.join('\n');
}
