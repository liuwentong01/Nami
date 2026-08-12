import type { GetStaticPropsResult } from '@nami/shared';

/** 可以携带 Location 并表示页面跳转的 HTTP 状态码。 */
const STATIC_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * 校验 getStaticProps 的运行时返回值。
 *
 * TypeScript 类型无法约束 JavaScript 页面模块，也无法防止业务代码通过 any
 * 返回互相冲突的控制字段，因此渲染前需要做一次轻量运行时校验。
 */
export function assertValidStaticPropsResult(result: GetStaticPropsResult): void {
  if (!result || typeof result !== 'object') {
    throw new TypeError('getStaticProps 必须返回一个对象');
  }

  if (result.redirect && result.notFound) {
    throw new TypeError('getStaticProps 不能同时返回 redirect 与 notFound');
  }

  if (result.redirect) {
    if (
      typeof result.redirect.destination !== 'string' ||
      result.redirect.destination.trim().length === 0
    ) {
      throw new TypeError('getStaticProps.redirect.destination 必须是非空字符串');
    }

    if (
      result.redirect.statusCode !== undefined &&
      (!Number.isInteger(result.redirect.statusCode) ||
        !STATIC_REDIRECT_STATUS_CODES.has(result.redirect.statusCode))
    ) {
      throw new TypeError('getStaticProps.redirect.statusCode 仅支持 301、302、303、307 或 308');
    }
  }

  if (
    result.revalidate !== undefined &&
    (!Number.isFinite(result.revalidate) ||
      !Number.isInteger(result.revalidate) ||
      result.revalidate < 0)
  ) {
    throw new TypeError('getStaticProps.revalidate 的单位为秒，必须是非负有限整数');
  }
}

/** 按显式 statusCode、permanent、临时重定向的顺序解析 HTTP 状态码。 */
export function resolveStaticRedirectStatus(
  redirect: NonNullable<GetStaticPropsResult['redirect']>,
): number {
  return redirect.statusCode ?? (redirect.permanent ? 308 : 307);
}

/** 页面动态值优先于路由默认值，并保留合法的 0 秒语义。 */
export function resolveStaticRevalidate(
  dynamicValue: number | undefined,
  routeDefault: number,
): number {
  return dynamicValue ?? routeDefault;
}
