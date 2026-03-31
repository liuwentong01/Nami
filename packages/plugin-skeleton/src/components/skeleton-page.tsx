/**
 * @nami/plugin-skeleton - 页面级骨架屏组件
 *
 * 提供整页骨架屏布局，将基础骨架组件组合为常见的页面布局模板：
 * - list:      列表页布局（搜索框 + 列表卡片）
 * - detail:    详情页布局（标题 + 内容 + 侧边栏）
 * - dashboard: 仪表盘布局（数据卡片网格 + 图表区域）
 *
 * 支持从路由配置中自动检测布局类型，也可手动指定。
 */

import React from 'react';
import {
  SkeletonText,
  SkeletonImage,
  SkeletonAvatar,
  SkeletonCard,
  SkeletonButton,
  type SkeletonAnimation,
  type SkeletonBaseProps,
} from './skeleton-screen';

// ==================== 类型定义 ====================

/**
 * 页面布局类型
 */
export type SkeletonPageLayout = 'list' | 'detail' | 'dashboard' | 'custom';

/**
 * 页面骨架屏属性
 */
export interface SkeletonPageProps {
  /** 页面布局类型 */
  layout?: SkeletonPageLayout;
  /** 动画类型 */
  animation?: SkeletonAnimation;
  /** 骨架屏背景色 */
  backgroundColor?: string;
  /** 高亮色 */
  highlightColor?: string;
  /** 动画时长（秒） */
  animationDuration?: number;
  /** 自定义容器样式 */
  style?: React.CSSProperties;
  /** 自定义类名 */
  className?: string;
  /** 自定义内容（layout 为 'custom' 时使用） */
  children?: React.ReactNode;

  // ==================== 列表布局配置 ====================
  /** 列表项数量 */
  listItemCount?: number;
  /** 是否显示搜索框 */
  showSearch?: boolean;

  // ==================== 详情页配置 ====================
  /** 是否显示侧边栏 */
  showSidebar?: boolean;
  /** 内容段落数 */
  contentParagraphs?: number;

  // ==================== 仪表盘配置 ====================
  /** 数据卡片数量 */
  dashboardCardCount?: number;
  /** 是否显示图表区域 */
  showCharts?: boolean;
}

// ==================== 通用样式常量 ====================

const PAGE_PADDING = 24;
const SECTION_GAP = 24;

// ==================== 布局渲染函数 ====================

/**
 * 列表页骨架布局
 *
 * 包含：搜索栏 + 筛选条 + 列表项（带头像和操作按钮）
 */
function renderListLayout(props: SkeletonPageProps): React.ReactElement {
  const {
    listItemCount = 5,
    showSearch = true,
    animation,
    backgroundColor,
    highlightColor,
    animationDuration,
  } = props;

  const commonProps: SkeletonBaseProps = {
    animation,
    backgroundColor,
    highlightColor,
    animationDuration,
  };

  const items: React.ReactElement[] = [];
  for (let i = 0; i < listItemCount; i++) {
    items.push(
      <div
        key={i}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          padding: 16,
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <SkeletonAvatar size="medium" {...commonProps} />
        <div style={{ flex: 1, marginLeft: 12 }}>
          <SkeletonText lines={1} width="40%" lineHeight={16} {...commonProps} />
          <SkeletonText
            lines={2}
            width={['100%', '75%']}
            lineHeight={14}
            lineSpacing={8}
            {...commonProps}
            style={{ marginTop: 8 }}
          />
          <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
            <SkeletonText lines={1} width={60} lineHeight={12} {...commonProps} />
            <SkeletonText lines={1} width={60} lineHeight={12} {...commonProps} />
          </div>
        </div>
        <SkeletonButton size="small" {...commonProps} />
      </div>,
    );
  }

  return (
    <div>
      {/* 搜索栏 */}
      {showSearch && (
        <div style={{ marginBottom: SECTION_GAP, display: 'flex', gap: 12 }}>
          <SkeletonText
            lines={1}
            width="100%"
            lineHeight={40}
            {...commonProps}
            borderRadius={20}
          />
          <SkeletonButton width={80} height={40} {...commonProps} />
        </div>
      )}

      {/* 筛选条 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[80, 64, 72, 56].map((w, idx) => (
          <SkeletonButton key={idx} width={w} height={28} {...commonProps} borderRadius={14} />
        ))}
      </div>

      {/* 列表 */}
      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
        {items}
      </div>
    </div>
  );
}

/**
 * 详情页骨架布局
 *
 * 包含：面包屑 + 标题 + 内容区（可带侧边栏）
 */
function renderDetailLayout(props: SkeletonPageProps): React.ReactElement {
  const {
    showSidebar = true,
    contentParagraphs = 4,
    animation,
    backgroundColor,
    highlightColor,
    animationDuration,
  } = props;

  const commonProps: SkeletonBaseProps = {
    animation,
    backgroundColor,
    highlightColor,
    animationDuration,
  };

  const contentBlocks: React.ReactElement[] = [];
  for (let i = 0; i < contentParagraphs; i++) {
    contentBlocks.push(
      <div key={i} style={{ marginBottom: SECTION_GAP }}>
        <SkeletonText lines={1} width="30%" lineHeight={20} {...commonProps} />
        <SkeletonText
          lines={4}
          lineHeight={14}
          lineSpacing={8}
          {...commonProps}
          style={{ marginTop: 12 }}
        />
      </div>,
    );
  }

  return (
    <div>
      {/* 面包屑 */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <SkeletonText lines={1} width={40} lineHeight={14} {...commonProps} />
        <SkeletonText lines={1} width={60} lineHeight={14} {...commonProps} />
        <SkeletonText lines={1} width={80} lineHeight={14} {...commonProps} />
      </div>

      {/* 标题区 */}
      <SkeletonText lines={1} width="60%" lineHeight={32} {...commonProps} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, marginBottom: SECTION_GAP }}>
        <SkeletonAvatar size="small" {...commonProps} />
        <SkeletonText lines={1} width={120} lineHeight={14} {...commonProps} />
        <SkeletonText lines={1} width={80} lineHeight={14} {...commonProps} />
      </div>

      {/* 封面图 */}
      <SkeletonImage width="100%" height={300} {...commonProps} borderRadius={8} />

      {/* 内容区 */}
      <div style={{ display: 'flex', gap: SECTION_GAP, marginTop: SECTION_GAP }}>
        {/* 主内容 */}
        <div style={{ flex: 1 }}>
          {contentBlocks}
        </div>

        {/* 侧边栏 */}
        {showSidebar && (
          <div style={{ width: 280, flexShrink: 0 }}>
            <SkeletonCard
              showImage={false}
              showAvatar
              textLines={2}
              width="100%"
              {...commonProps}
            />
            <div style={{ marginTop: 16 }}>
              <SkeletonText lines={1} width="60%" lineHeight={18} {...commonProps} />
              <div style={{ marginTop: 12 }}>
                {[1, 2, 3].map((i) => (
                  <SkeletonText
                    key={i}
                    lines={1}
                    width="100%"
                    lineHeight={14}
                    {...commonProps}
                    style={{ marginTop: 8 }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 仪表盘骨架布局
 *
 * 包含：数据统计卡片 + 图表区域 + 表格
 */
function renderDashboardLayout(props: SkeletonPageProps): React.ReactElement {
  const {
    dashboardCardCount = 4,
    showCharts = true,
    animation,
    backgroundColor,
    highlightColor,
    animationDuration,
  } = props;

  const commonProps: SkeletonBaseProps = {
    animation,
    backgroundColor,
    highlightColor,
    animationDuration,
  };

  // 数据统计卡片
  const statCards: React.ReactElement[] = [];
  for (let i = 0; i < dashboardCardCount; i++) {
    statCards.push(
      <div
        key={i}
        style={{
          flex: 1,
          minWidth: 200,
          padding: 20,
          border: '1px solid #f0f0f0',
          borderRadius: 8,
        }}
      >
        <SkeletonText lines={1} width="50%" lineHeight={14} {...commonProps} />
        <SkeletonText
          lines={1}
          width="70%"
          lineHeight={32}
          {...commonProps}
          style={{ marginTop: 12 }}
        />
        <SkeletonText
          lines={1}
          width="30%"
          lineHeight={12}
          {...commonProps}
          style={{ marginTop: 8 }}
        />
      </div>,
    );
  }

  // 表格行
  const tableRows: React.ReactElement[] = [];
  for (let i = 0; i < 5; i++) {
    tableRows.push(
      <div
        key={i}
        style={{
          display: 'flex',
          gap: 16,
          padding: '12px 0',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <SkeletonText lines={1} width="20%" lineHeight={14} {...commonProps} />
        <SkeletonText lines={1} width="25%" lineHeight={14} {...commonProps} />
        <SkeletonText lines={1} width="15%" lineHeight={14} {...commonProps} />
        <SkeletonText lines={1} width="20%" lineHeight={14} {...commonProps} />
        <SkeletonText lines={1} width="10%" lineHeight={14} {...commonProps} />
      </div>,
    );
  }

  return (
    <div>
      {/* 页面标题 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SECTION_GAP }}>
        <SkeletonText lines={1} width={200} lineHeight={28} {...commonProps} />
        <div style={{ display: 'flex', gap: 8 }}>
          <SkeletonButton size="medium" {...commonProps} />
          <SkeletonButton size="medium" {...commonProps} />
        </div>
      </div>

      {/* 数据统计卡片 */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: SECTION_GAP }}>
        {statCards}
      </div>

      {/* 图表区域 */}
      {showCharts && (
        <div style={{ display: 'flex', gap: 16, marginBottom: SECTION_GAP }}>
          <div style={{ flex: 2, border: '1px solid #f0f0f0', borderRadius: 8, padding: 20 }}>
            <SkeletonText lines={1} width="30%" lineHeight={18} {...commonProps} />
            <SkeletonImage
              width="100%"
              height={240}
              {...commonProps}
              borderRadius={4}
              style={{ marginTop: 16 }}
            />
          </div>
          <div style={{ flex: 1, border: '1px solid #f0f0f0', borderRadius: 8, padding: 20 }}>
            <SkeletonText lines={1} width="40%" lineHeight={18} {...commonProps} />
            <SkeletonImage
              width="100%"
              height={240}
              {...commonProps}
              borderRadius={4}
              style={{ marginTop: 16 }}
            />
          </div>
        </div>
      )}

      {/* 数据表格 */}
      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 20 }}>
        <SkeletonText lines={1} width="20%" lineHeight={18} {...commonProps} />
        {/* 表头 */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            padding: '12px 0',
            borderBottom: '2px solid #f0f0f0',
            marginTop: 16,
          }}
        >
          <SkeletonText lines={1} width="20%" lineHeight={14} {...commonProps} />
          <SkeletonText lines={1} width="25%" lineHeight={14} {...commonProps} />
          <SkeletonText lines={1} width="15%" lineHeight={14} {...commonProps} />
          <SkeletonText lines={1} width="20%" lineHeight={14} {...commonProps} />
          <SkeletonText lines={1} width="10%" lineHeight={14} {...commonProps} />
        </div>
        {tableRows}
      </div>
    </div>
  );
}

// ==================== 辅助函数 ====================

/**
 * 根据路由路径自动检测布局类型
 *
 * 通过路径模式推断页面类型：
 * - 包含 /list、/search 的路径 → list 布局
 * - 包含 /:id、/detail 的路径 → detail 布局
 * - 包含 /dashboard、/admin 的路径 → dashboard 布局
 *
 * @param routePath - 路由路径
 * @returns 推断的布局类型
 */
export function detectLayoutFromRoute(routePath: string): SkeletonPageLayout {
  const normalized = routePath.toLowerCase();

  if (normalized.includes('/dashboard') || normalized.includes('/admin') || normalized.includes('/analytics')) {
    return 'dashboard';
  }

  if (normalized.includes('/list') || normalized.includes('/search') || normalized.endsWith('s')) {
    return 'list';
  }

  if (normalized.includes('/:') || normalized.includes('/detail') || normalized.includes('/article')) {
    return 'detail';
  }

  // 默认使用列表布局
  return 'list';
}

// ==================== 主组件 ====================

/**
 * 页面级骨架屏组件
 *
 * 根据指定的布局类型渲染整页骨架屏。
 * 支持自动从路由路径检测布局类型。
 *
 * @example
 * ```tsx
 * // 列表页骨架
 * <SkeletonPage layout="list" listItemCount={6} showSearch />
 *
 * // 详情页骨架
 * <SkeletonPage layout="detail" showSidebar contentParagraphs={5} />
 *
 * // 仪表盘骨架
 * <SkeletonPage layout="dashboard" dashboardCardCount={4} showCharts />
 *
 * // 自定义骨架
 * <SkeletonPage layout="custom">
 *   <MyCustomSkeleton />
 * </SkeletonPage>
 * ```
 */
export const SkeletonPage: React.FC<SkeletonPageProps> = (props) => {
  const { layout = 'list', style, className, children } = props;

  const containerStyle: React.CSSProperties = {
    padding: PAGE_PADDING,
    maxWidth: 1200,
    margin: '0 auto',
    ...style,
  };

  let content: React.ReactNode;

  switch (layout) {
    case 'list':
      content = renderListLayout(props);
      break;
    case 'detail':
      content = renderDetailLayout(props);
      break;
    case 'dashboard':
      content = renderDashboardLayout(props);
      break;
    case 'custom':
      content = children;
      break;
    default:
      content = renderListLayout(props);
      break;
  }

  return (
    <div
      className={className}
      style={containerStyle}
      data-nami-skeleton="page"
      role="presentation"
      aria-label="页面加载中"
    >
      {content}
    </div>
  );
};

SkeletonPage.displayName = 'SkeletonPage';
