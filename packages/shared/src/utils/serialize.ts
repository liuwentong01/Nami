/**
 * @nami/shared - 序列化工具
 *
 * 负责将服务端数据安全地序列化到 HTML 中。
 * 核心关注点：防止 XSS 注入攻击。
 *
 * 当 JSON 数据作为 <script> 标签内容嵌入 HTML 时，
 * 以下字符序列可能被浏览器解析为特殊语义，必须转义：
 * - </script> → 结束 script 标签
 * - <!-- → 开启 HTML 注释
 * - <script → 嵌套 script 标签
 * - Unicode 行分隔符和段落分隔符
 */

import { NAMI_DATA_VARIABLE } from '../constants/defaults';

/**
 * 危险字符映射表
 */
const UNSAFE_CHARS: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * 转义 JSON 字符串中的危险字符
 * 防止嵌入 HTML <script> 标签时产生 XSS
 */
function escapeUnsafeChars(str: string): string {
  return str.replace(/[<>/\u2028\u2029]/g, (char) => UNSAFE_CHARS[char] || char);
}

/**
 * 安全地将数据序列化为 JSON 字符串
 *
 * @param data - 要序列化的数据
 * @param xssSafe - 是否启用 XSS 防护，默认 true
 * @returns 安全的 JSON 字符串
 */
export function safeStringify(data: unknown, xssSafe: boolean = true): string {
  const json = JSON.stringify(data);
  if (!xssSafe) return json;
  return escapeUnsafeChars(json);
}

/**
 * 生成数据注入的 <script> 标签
 *
 * 将服务端预取数据以 window.__NAMI_DATA__ 的形式注入到 HTML 中，
 * 客户端通过读取此变量恢复数据，避免重复请求。
 *
 * @param data - 要注入的数据对象
 * @param variableName - window 上的变量名
 * @returns HTML script 标签字符串
 *
 * @example
 * ```typescript
 * const scriptTag = generateDataScript({ user: { name: '张三' } });
 * // <script>window.__NAMI_DATA__={"user":{"name":"\u003C张三\u003E"}}</script>
 * ```
 */
export function generateDataScript(
  data: Record<string, unknown>,
  variableName: string = NAMI_DATA_VARIABLE,
): string {
  const serialized = safeStringify(data);
  return `<script>window.${variableName}=${serialized}</script>`;
}

/**
 * 从 HTML 中恢复注入的数据
 * 客户端使用，从 window 全局变量读取
 *
 * @param variableName - 变量名
 * @returns 恢复的数据对象
 */
export function hydrateData<T = Record<string, unknown>>(
  variableName: string = NAMI_DATA_VARIABLE,
): T | null {
  if (typeof window === 'undefined') return null;
  return (window as Record<string, unknown>)[variableName] as T | null;
}
