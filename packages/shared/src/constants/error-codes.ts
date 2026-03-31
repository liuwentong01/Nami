/**
 * @nami/shared - 错误码常量
 *
 * 为错误码提供人类可读的消息模板。
 */

import { ErrorCode } from '../types/error';

/**
 * 错误码到消息的映射
 * 消息模板中可包含 {variable} 占位符
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  // 渲染错误
  [ErrorCode.RENDER_SSR_FAILED]: 'SSR 渲染失败: {message}',
  [ErrorCode.RENDER_SSR_TIMEOUT]: 'SSR 渲染超时，已超过 {timeout}ms 限制',
  [ErrorCode.RENDER_CSR_FAILED]: 'CSR 渲染失败: {message}',
  [ErrorCode.RENDER_SSG_FAILED]: 'SSG 静态生成失败: {message}',
  [ErrorCode.RENDER_ISR_REVALIDATE_FAILED]: 'ISR 重验证失败: {message}',
  [ErrorCode.RENDER_HYDRATION_MISMATCH]: 'Hydration 不匹配: 服务端与客户端渲染结果不一致',
  [ErrorCode.RENDER_DEGRADED]: '渲染已降级到 {level} 级别',

  // 数据预取错误
  [ErrorCode.DATA_FETCH_FAILED]: '数据预取失败: {message}',
  [ErrorCode.DATA_FETCH_TIMEOUT]: '数据预取超时，已超过 {timeout}ms 限制',
  [ErrorCode.DATA_SERIALIZE_FAILED]: '数据序列化失败: {message}',
  [ErrorCode.DATA_GSSP_FAILED]: 'getServerSideProps 执行失败: {message}',
  [ErrorCode.DATA_GSP_FAILED]: 'getStaticProps 执行失败: {message}',

  // 缓存错误
  [ErrorCode.CACHE_READ_FAILED]: '缓存读取失败: {message}',
  [ErrorCode.CACHE_WRITE_FAILED]: '缓存写入失败: {message}',
  [ErrorCode.CACHE_INVALIDATE_FAILED]: '缓存失效操作失败: {message}',
  [ErrorCode.CACHE_REDIS_CONNECTION_FAILED]: 'Redis 连接失败: {host}:{port}',

  // 路由错误
  [ErrorCode.ROUTE_NOT_FOUND]: '路由未匹配: {path}',
  [ErrorCode.ROUTE_INVALID_CONFIG]: '路由配置无效: {reason}',

  // 插件错误
  [ErrorCode.PLUGIN_LOAD_FAILED]: '插件 {name} 加载失败: {message}',
  [ErrorCode.PLUGIN_SETUP_FAILED]: '插件 {name} 初始化失败: {message}',
  [ErrorCode.PLUGIN_HOOK_FAILED]: '插件 {name} 的钩子 {hook} 执行失败: {message}',

  // 构建错误
  [ErrorCode.BUILD_COMPILE_FAILED]: 'Webpack 编译失败，共 {count} 个错误',
  [ErrorCode.BUILD_CONFIG_LOAD_FAILED]: '配置文件加载失败: {path}',

  // 服务端错误
  [ErrorCode.SERVER_START_FAILED]: '服务启动失败: {message}',
  [ErrorCode.SERVER_PORT_IN_USE]: '端口 {port} 已被占用',
  [ErrorCode.SERVER_MIDDLEWARE_FAILED]: '中间件 {name} 执行失败: {message}',

  // 客户端错误
  [ErrorCode.CLIENT_INIT_FAILED]: '客户端初始化失败: {message}',
  [ErrorCode.CLIENT_ROUTING_FAILED]: '客户端路由失败: {message}',

  // 配置错误
  [ErrorCode.CONFIG_VALIDATION_FAILED]: '配置校验失败: {reason}',
  [ErrorCode.CONFIG_NOT_FOUND]: '配置文件未找到: {path}',
};

/**
 * 格式化错误消息
 * 将消息模板中的占位符替换为实际值
 *
 * @param code - 错误码
 * @param params - 占位符参数
 * @returns 格式化后的错误消息
 */
export function formatErrorMessage(
  code: ErrorCode,
  params: Record<string, string | number> = {},
): string {
  let message = ERROR_MESSAGES[code] || `未知错误 (code: ${code})`;
  for (const [key, value] of Object.entries(params)) {
    message = message.replace(`{${key}}`, String(value));
  }
  return message;
}
