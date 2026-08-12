/**
 * @nami/core - CSR Shell loading helper
 *
 * 该模块只负责生成可直接写入 HTML 的静态字符串，不依赖 React。正常 CSR、
 * SSR -> CSR 降级和构建期 index.html 共用同一份默认 loading 骨架，避免三条
 * 链路的首屏体验发生偏差。
 */

import { DEFAULT_CONTAINER_ID } from '@nami/shared';

/**
 * 允许出现在框架托管 fallback 中的被动 HTML 标签。
 *
 * 不允许 SVG、MathML、表单、媒体、frame/object/embed 等主动内容；自定义内容
 * 一旦超出这组能力就整体回退到框架内置页面，不尝试“修补”后继续输出。
 */
const PASSIVE_FALLBACK_TAGS = new Set([
  'a',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'small',
  'span',
  'strong',
  'style',
  'sub',
  'sup',
  'ul',
]);

const VOID_FALLBACK_TAGS = new Set(['br', 'hr', 'meta']);
const DOCUMENT_FALLBACK_TAGS = new Set(['html', 'head', 'body', 'title']);
const DOCUMENT_HEAD_TAGS = new Set(['meta', 'title', 'style']);

const GLOBAL_FALLBACK_ATTRIBUTES = new Set([
  'class',
  'dir',
  'hidden',
  'id',
  'lang',
  'role',
  'style',
  'tabindex',
  'title',
]);

const TAG_FALLBACK_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(['href']),
  meta: new Set(['charset', 'content', 'name']),
};

const MAX_FALLBACK_HTML_LENGTH = 128 * 1024;
const MAX_FALLBACK_TAGS = 2048;
const MAX_FALLBACK_DEPTH = 64;
const MAX_FALLBACK_ATTRIBUTES = 32;

/** CSR Shell loading 片段的稳定标记。 */
export const CSR_SHELL_LOADING_MARKER = 'data-nami-csr-shell="loading"';

/**
 * 内置 CSR loading 骨架。
 *
 * 样式全部内联，确保主 CSS 尚未下载时仍能立即显示；片段不包含脚本，客户端
 * React 首次 commit 后会自然替换整个根容器内容。
 */
export const DEFAULT_CSR_SHELL_SKELETON_HTML = [
  `<div ${CSR_SHELL_LOADING_MARKER} role="status" aria-live="polite" aria-busy="true" aria-label="页面加载中" style="padding:24px;max-width:1200px;margin:0 auto;box-sizing:border-box;">`,
  '  <div style="height:24px;width:60%;background:#f0f0f0;border-radius:4px;margin-bottom:16px;"></div>',
  '  <div style="height:16px;width:100%;background:#f0f0f0;border-radius:4px;margin-bottom:12px;"></div>',
  '  <div style="height:16px;width:80%;background:#f0f0f0;border-radius:4px;margin-bottom:12px;"></div>',
  '  <div style="height:16px;width:90%;background:#f0f0f0;border-radius:4px;"></div>',
  '</div>',
].join('\n');

/**
 * 自定义内容只能是放入根容器的 HTML 片段。
 *
 * 拒绝文档级标签来避免嵌套 document，拒绝 script 来避免把插件上下文中的
 * 字符串变成额外的可执行入口。未通过校验时调用方会安全回退到内置骨架。
 */
export function isSafeCSRShellSkeletonFragment(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }

  return validatePassiveHTML(value, {
    allowedTags: PASSIVE_FALLBACK_TAGS,
    requireSingleDocument: false,
  });
}

/** 解析自定义 CSR Shell 片段；无效时返回内置骨架。 */
export function resolveCSRShellSkeletonHTML(value?: unknown): string {
  return isSafeCSRShellSkeletonFragment(value) ? value.trim() : DEFAULT_CSR_SHELL_SKELETON_HTML;
}

/**
 * 生成包含 loading 骨架的 CSR 挂载容器。
 *
 * containerId 来源于框架常量或内部配置，不接受请求输入；这里只做最小属性转义，
 * 让 helper 也能安全供 Webpack 插件的公开 containerId 选项复用。
 */
export function createCSRRootContainer(
  skeletonHTML?: unknown,
  containerId = DEFAULT_CONTAINER_ID,
): string {
  const resolvedSkeletonHTML = resolveCSRShellSkeletonHTML(skeletonHTML);
  const markedSkeletonHTML = resolvedSkeletonHTML.includes(CSR_SHELL_LOADING_MARKER)
    ? resolvedSkeletonHTML
    : [`<div ${CSR_SHELL_LOADING_MARKER}>`, indentHTML(resolvedSkeletonHTML, 2), '</div>'].join(
        '\n',
      );

  return [
    `<div id="${escapeHTMLAttribute(containerId)}">`,
    indentHTML(markedSkeletonHTML, 2),
    '</div>',
  ].join('\n');
}

/**
 * 无业务运行时的静态应急页。
 *
 * 该页面供反向代理/CDN 在 Node 服务完全不可达时使用，因此不包含外链或内联
 * JavaScript；重新加载使用普通文档链接。
 */
export function createStaticEmergencyHTML(title = '服务暂时不可用'): string {
  const safeTitle = escapeHTMLText(title);

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${safeTitle}</title>`,
    '</head>',
    '<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:sans-serif;background:#fafafa;color:#4b5563;">',
    '  <main role="alert" style="padding:24px;text-align:center;">',
    `    <h1 style="margin:0 0 12px;font-size:28px;">${safeTitle}</h1>`,
    '    <p style="margin:0 0 18px;">服务暂时不可用，请稍后重试。</p>',
    '    <a href="" style="color:#2563eb;">重新加载</a>',
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * 选择构建期静态应急页。
 *
 * fallback.staticHTML 是首选内容，但 emergency.html 必须在业务运行时不可达时仍
 * 独立工作。只有严格的被动 HTML 子集会被接受；其余配置回退到内置页面，保证
 * 产物不携带业务 JavaScript 或可主动加载的外部内容。
 */
export function resolveStaticEmergencyHTML(staticHTML?: unknown, title?: string): string {
  if (typeof staticHTML !== 'string' || staticHTML.trim() === '') {
    return createStaticEmergencyHTML(title);
  }

  const isSafeDocument = validatePassiveHTML(staticHTML, {
    allowedTags: new Set([...PASSIVE_FALLBACK_TAGS, ...DOCUMENT_FALLBACK_TAGS, 'meta']),
    requireSingleDocument: true,
  });

  return isSafeDocument ? staticHTML.trim() : createStaticEmergencyHTML(title);
}

interface PassiveHTMLValidationOptions {
  allowedTags: ReadonlySet<string>;
  requireSingleDocument: boolean;
}

/**
 * 对框架会直接输出的自定义 HTML 做严格允许列表校验。
 *
 * 这里有意不做 HTML sanitizer：sanitizer 很容易在浏览器纠错解析、命名空间和
 * entity 解码上产生差异。任何不明确或不平衡的内容都返回 false，让调用方使用
 * 框架内置 fallback，避免输出半清洗的攻击载荷。
 */
function validatePassiveHTML(value: string, options: PassiveHTMLValidationOptions): boolean {
  const source = value.trim();
  if (
    !source ||
    source.length > MAX_FALLBACK_HTML_LENGTH ||
    /\0/.test(source) ||
    source.includes('<!--') !== source.includes('-->')
  ) {
    return false;
  }

  const tagStack: string[] = [];
  let htmlCount = 0;
  let headCount = 0;
  let bodyCount = 0;
  let topLevelElementCount = 0;
  let tagCount = 0;
  let documentPhase: 'before-html' | 'in-html' | 'after-html' = 'before-html';
  let htmlChildPhase: 'before-head' | 'after-head' | 'after-body' = 'before-head';
  let cursor = 0;
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<[^>]*>/g;

  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const tokenStart = match.index ?? 0;
    const textBeforeToken = source.slice(cursor, tokenStart);
    if (/[<>]/.test(textBeforeToken)) return false;
    if (options.requireSingleDocument) {
      const parentTag = tagStack[tagStack.length - 1];
      if (
        textBeforeToken.trim() !== '' &&
        (parentTag === undefined || parentTag === 'html' || parentTag === 'head')
      ) {
        return false;
      }
      if (parentTag === 'style' && !isSafeInlineStyle(textBeforeToken)) return false;
    } else if (tagStack[tagStack.length - 1] === 'style' && !isSafeInlineStyle(textBeforeToken)) {
      return false;
    }
    cursor = tokenStart + token.length;

    if (token.startsWith('<!--')) continue;

    if (/^<!doctype\s+html\s*>$/i.test(token)) {
      if (!options.requireSingleDocument || tagStack.length > 0 || tokenStart !== 0) return false;
      continue;
    }

    // 拒绝其他 declaration、CDATA、处理指令以及格式不完整的标签。
    if (/^<!|^<\?/.test(token)) return false;

    const closingMatch = token.match(/^<\s*\/\s*([a-z][a-z0-9-]*)\s*>$/i);
    if (closingMatch) {
      const closingTag = closingMatch[1]?.toLowerCase();
      if (!closingTag) return false;
      if (VOID_FALLBACK_TAGS.has(closingTag) || tagStack.pop() !== closingTag) return false;
      if (closingTag === 'head') htmlChildPhase = 'after-head';
      if (closingTag === 'body') htmlChildPhase = 'after-body';
      if (closingTag === 'html') documentPhase = 'after-html';
      continue;
    }

    const openingMatch = token.match(/^<\s*([a-z][a-z0-9-]*)([\s\S]*?)\s*(\/?)>$/i);
    if (!openingMatch) return false;

    const tagName = openingMatch[1]?.toLowerCase();
    const rawAttributes = openingMatch[2] ?? '';
    if (!tagName) return false;
    const isSelfClosing = openingMatch[3] === '/';
    if (!options.allowedTags.has(tagName)) return false;
    if (isSelfClosing && !VOID_FALLBACK_TAGS.has(tagName)) return false;
    tagCount += 1;
    if (tagCount > MAX_FALLBACK_TAGS) return false;

    if (tagStack.length === 0) topLevelElementCount += 1;
    if (tagName === 'html') htmlCount += 1;
    if (tagName === 'head') headCount += 1;
    if (tagName === 'body') bodyCount += 1;

    if (options.requireSingleDocument) {
      const parentTag = tagStack[tagStack.length - 1];
      if (tagName === 'html') {
        if (parentTag !== undefined || documentPhase !== 'before-html') return false;
        documentPhase = 'in-html';
      }
      if ((tagName === 'head' || tagName === 'body') && parentTag !== 'html') return false;
      if (tagName === 'head' && htmlChildPhase !== 'before-head') return false;
      if (tagName === 'body' && htmlChildPhase !== 'after-head') return false;
      if (
        DOCUMENT_HEAD_TAGS.has(tagName) &&
        parentTag !== 'head' &&
        !(tagName === 'style' && tagStack.includes('body'))
      ) {
        return false;
      }
      if (parentTag === 'head' && !DOCUMENT_HEAD_TAGS.has(tagName)) return false;
      if (parentTag === 'html' && tagName !== 'head' && tagName !== 'body') return false;
      if (
        parentTag !== undefined &&
        parentTag !== 'html' &&
        parentTag !== 'head' &&
        !tagStack.includes('body')
      ) {
        return false;
      }
    } else if (DOCUMENT_FALLBACK_TAGS.has(tagName) || tagName === 'meta') {
      return false;
    }

    if (!validatePassiveAttributes(tagName, rawAttributes)) return false;

    if (!isSelfClosing && !VOID_FALLBACK_TAGS.has(tagName)) {
      tagStack.push(tagName);
      if (tagStack.length > MAX_FALLBACK_DEPTH) return false;
    }
  }

  const remainingText = source.slice(cursor);
  if (
    /[<>]/.test(remainingText) ||
    tagStack.length > 0 ||
    (options.requireSingleDocument && remainingText.trim() !== '')
  ) {
    return false;
  }

  if (!options.requireSingleDocument) return topLevelElementCount > 0;

  return (
    htmlCount === 1 &&
    headCount === 1 &&
    bodyCount === 1 &&
    topLevelElementCount === 1 &&
    documentPhase === 'after-html' &&
    htmlChildPhase === 'after-body'
  );
}

function validatePassiveAttributes(tagName: string, source: string): boolean {
  let cursor = 0;
  let attributeCount = 0;
  const seenAttributes = new Set<string>();
  const attributePattern = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/gy;

  while (cursor < source.length) {
    attributePattern.lastIndex = cursor;
    const match = attributePattern.exec(source);
    if (!match) {
      return source.slice(cursor).trim() === '';
    }

    cursor = attributePattern.lastIndex;
    const attributeName = match[1]?.toLowerCase();
    if (!attributeName) return false;
    const attributeValue = decodeBasicHTMLEntities(match[2] ?? match[3] ?? '');
    if (attributeValue === undefined) return false;
    const tagAttributes = TAG_FALLBACK_ATTRIBUTES[tagName];

    attributeCount += 1;
    if (attributeCount > MAX_FALLBACK_ATTRIBUTES || seenAttributes.has(attributeName)) {
      return false;
    }
    seenAttributes.add(attributeName);

    if (
      !GLOBAL_FALLBACK_ATTRIBUTES.has(attributeName) &&
      !attributeName.startsWith('aria-') &&
      !attributeName.startsWith('data-') &&
      !tagAttributes?.has(attributeName)
    ) {
      return false;
    }

    if (/^on/i.test(attributeName) || attributeName === 'srcdoc') return false;
    if (attributeName === 'href' && !isSafeFallbackURL(attributeValue)) return false;
    if (attributeName === 'style' && !isSafeInlineStyle(attributeValue)) return false;
  }

  return true;
}

function isSafeFallbackURL(value: string): boolean {
  if (value.includes('\\')) return false;
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
  return (
    normalized === '' ||
    (normalized.startsWith('/') && !normalized.startsWith('//')) ||
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    normalized.startsWith('#') ||
    normalized.startsWith('?') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://')
  );
}

function isSafeInlineStyle(value: string): boolean {
  const normalized = value.toLowerCase();
  return !/[\\<>]|\/\*|url\(|image-set\(|@(?!(?:-webkit-)?keyframes(?:[^a-z-]|$))|expression\s*\(|(?:javascript|vbscript|data)\s*:|(?:behavior|-moz-binding)\s*:/i.test(
    normalized,
  );
}

function decodeBasicHTMLEntities(value: string): string | undefined {
  if (/&(?!(?:#x[0-9a-f]+|#[0-9]+|colon|tab|newline|amp);?)/i.test(value)) {
    return undefined;
  }

  try {
    return value
      .replace(/&#x([0-9a-f]+);?/gi, (_match, code: string) =>
        String.fromCodePoint(Number.parseInt(code, 16)),
      )
      .replace(/&#([0-9]+);?/g, (_match, code: string) =>
        String.fromCodePoint(Number.parseInt(code, 10)),
      )
      .replace(/&colon;?/gi, ':')
      .replace(/&tab;?/gi, '\t')
      .replace(/&newline;?/gi, '\n')
      .replace(/&amp;?/gi, '&');
  } catch {
    return undefined;
  }
}

function indentHTML(html: string, spaces: number): string {
  const indentation = ' '.repeat(spaces);
  return html
    .split('\n')
    .map((line) => `${indentation}${line}`)
    .join('\n');
}

function escapeHTMLAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHTMLText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
