/**
 * @nami/shared - 深度合并工具
 *
 * 用于合并框架配置。支持嵌套对象的递归合并，
 * 数组默认为覆盖而非合并（配置场景中数组通常是声明式的完整列表）。
 */

/**
 * 判断值是否为纯对象（非数组、非 null、非 Date 等特殊对象）
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 深度合并两个对象
 *
 * 合并规则：
 * - 纯对象：递归合并
 * - 数组：source 覆盖 target（配置场景中数组通常是完整列表）
 * - 基础类型：source 覆盖 target
 * - undefined：不覆盖（保留 target 的值）
 *
 * @param target - 目标对象（被合并的基础对象）
 * @param source - 源对象（覆盖值）
 * @returns 合并后的新对象（不修改原对象）
 *
 * @example
 * ```typescript
 * const base = { server: { port: 3000, host: '0.0.0.0' }, plugins: ['a'] };
 * const override = { server: { port: 8080 }, plugins: ['b'] };
 * const result = deepMerge(base, override);
 * // { server: { port: 8080, host: '0.0.0.0' }, plugins: ['b'] }
 * ```
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    // undefined 不覆盖
    if (sourceValue === undefined) continue;

    // 两边都是纯对象则递归合并
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      );
    } else {
      // 其他情况（数组、基础类型等）source 覆盖 target
      (result as Record<string, unknown>)[key as string] = sourceValue;
    }
  }

  return result;
}

/**
 * 多对象深度合并
 * 从左到右依次合并
 */
export function deepMergeAll<T extends Record<string, unknown>>(
  ...objects: Array<Partial<T>>
): T {
  if (objects.length === 0) return {} as T;
  return objects.reduce(
    (merged, current) => deepMerge(merged as T, current),
    {} as Partial<T>,
  ) as T;
}
