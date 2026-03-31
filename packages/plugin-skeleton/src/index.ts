/**
 * @nami/plugin-skeleton - 骨架屏插件
 *
 * Nami 框架官方骨架屏插件，提供页面加载占位与降级能力：
 * - 基础骨架组件（SkeletonText、SkeletonImage、SkeletonAvatar、SkeletonButton、SkeletonCard）
 * - 页面级骨架布局（列表、详情、仪表盘）
 * - DOM 结构自动生成骨架屏
 * - Suspense fallback 自动包裹
 * - SSR 渲染错误时的骨架屏降级
 *
 * @example
 * ```typescript
 * import { NamiSkeletonPlugin } from '@nami/plugin-skeleton';
 *
 * export default {
 *   plugins: [
 *     new NamiSkeletonPlugin({
 *       defaultLayout: 'list',
 *       animation: 'pulse',
 *       routeSkeletons: {
 *         '/dashboard': 'dashboard',
 *         '/articles/:id': 'detail',
 *       },
 *     }),
 *   ],
 * };
 * ```
 *
 * @packageDocumentation
 */

// 导出插件主体
export { NamiSkeletonPlugin } from './skeleton-plugin';
export type { SkeletonPluginOptions } from './skeleton-plugin';

// 导出原始骨架屏组件（向后兼容）
export { SkeletonScreen, DefaultPageSkeleton } from './components/skeleton-screen';
export type { SkeletonScreenProps } from './components/skeleton-screen';

// 导出骨架屏基础组件
export {
  SkeletonText,
  SkeletonImage,
  SkeletonAvatar,
  SkeletonButton,
  SkeletonCard,
} from './components/skeleton-screen';
export type {
  SkeletonAnimation,
  SkeletonBaseProps,
  SkeletonTextProps,
  SkeletonImageProps,
  SkeletonAvatarProps,
  SkeletonButtonProps,
  SkeletonCardProps,
} from './components/skeleton-screen';

// 导出页面级骨架屏组件
export { SkeletonPage, detectLayoutFromRoute } from './components/skeleton-page';
export type { SkeletonPageLayout, SkeletonPageProps } from './components/skeleton-page';

// 导出骨架屏生成器
export { SkeletonGenerator } from './generator/skeleton-generator';
export type {
  SkeletonNode,
  SkeletonNodeType,
  SkeletonDescriptor,
  SkeletonGeneratorOptions,
} from './generator/skeleton-generator';
