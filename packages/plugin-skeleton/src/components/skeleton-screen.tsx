/**
 * @nami/plugin-skeleton - 骨架屏组件
 *
 * SkeletonScreen 是一个通用的骨架屏占位组件，
 * 在页面加载或渲染过程中展示动画占位块，提升用户感知速度。
 *
 * 骨架屏的设计原则：
 * 1. 模拟页面真实布局结构（而非简单的 loading 动画）
 * 2. 使用渐变动画暗示"加载中"的状态
 * 3. 保持与目标页面接近的视觉结构，减少 CLS（布局偏移）
 *
 * 组件支持两种使用方式：
 * - 作为独立的骨架屏块使用（指定宽高的单个占位块）
 * - 作为页面级骨架屏使用（通过 children 组合多个骨架块）
 */

import React from 'react';

/**
 * 骨架屏组件属性
 */
export interface SkeletonScreenProps {
  /**
   * 骨架块宽度
   * 支持 CSS 值（如 '100%', '200px', '50vw'）
   * @default '100%'
   */
  width?: string | number;

  /**
   * 骨架块高度
   * 支持 CSS 值
   * @default '16px'
   */
  height?: string | number;

  /**
   * 圆角大小
   * 支持 CSS 值（如 '4px', '50%'）
   * @default '4px'
   */
  borderRadius?: string | number;

  /**
   * 是否启用闪烁动画
   * @default true
   */
  animate?: boolean;

  /**
   * 动画持续时间（秒）
   * @default 1.5
   */
  animationDuration?: number;

  /**
   * 骨架块的背景色
   * @default '#e0e0e0'
   */
  backgroundColor?: string;

  /**
   * 动画高亮色
   * @default '#f0f0f0'
   */
  highlightColor?: string;

  /**
   * 骨架块数量
   * 大于 1 时会渲染多个相同的骨架块
   * @default 1
   */
  count?: number;

  /**
   * 骨架块之间的间距
   * @default '8px'
   */
  gap?: string | number;

  /**
   * 自定义 CSS 类名
   */
  className?: string;

  /**
   * 自定义内联样式
   */
  style?: React.CSSProperties;

  /**
   * 子元素
   * 可包含多个 SkeletonScreen 组成复杂布局
   */
  children?: React.ReactNode;
}

/**
 * 骨架屏 CSS 动画关键帧名称
 * 使用唯一命名避免与业务方的 CSS 冲突
 */
const ANIMATION_NAME = 'nami-skeleton-pulse';

/**
 * 骨架屏样式标签 ID
 * 确保全局只注入一次动画样式
 */
const STYLE_ID = 'nami-skeleton-styles';

/**
 * 注入骨架屏动画的全局 CSS
 *
 * 在客户端环境下，将 @keyframes 注入到 <head> 中。
 * 使用 ID 去重，确保多个骨架屏实例不会重复注入。
 */
function injectStyles(): void {
  // 仅在浏览器环境执行
  if (typeof document === 'undefined') return;

  // 检查是否已注入
  if (document.getElementById(STYLE_ID)) return;

  const styleElement = document.createElement('style');
  styleElement.id = STYLE_ID;
  styleElement.textContent = `
    @keyframes ${ANIMATION_NAME} {
      0% { opacity: 1; }
      50% { opacity: 0.4; }
      100% { opacity: 1; }
    }
  `;
  document.head.appendChild(styleElement);
}

/**
 * 生成骨架屏 SSR 安全的内联样式
 *
 * 由于 SSR 环境下无法注入 <style> 标签，
 * 动画使用内联 style 的 animation 属性，
 * 同时提供 SSR 兼容的静态样式作为回退。
 */
function getSkeletonStyle(props: SkeletonScreenProps): React.CSSProperties {
  const {
    width = '100%',
    height = '16px',
    borderRadius = '4px',
    animate = true,
    animationDuration = 1.5,
    backgroundColor = '#e0e0e0',
  } = props;

  const baseStyle: React.CSSProperties = {
    display: 'block',
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius,
    backgroundColor,
    // 防止骨架块被压缩
    flexShrink: 0,
  };

  if (animate) {
    baseStyle.animation = `${ANIMATION_NAME} ${animationDuration}s ease-in-out infinite`;
  }

  return baseStyle;
}

/**
 * 骨架屏组件
 *
 * 渲染动画占位块，用作加载状态的视觉反馈。
 *
 * @example
 * ```tsx
 * // 单个骨架块
 * <SkeletonScreen width="200px" height="20px" />
 *
 * // 多行文字骨架
 * <SkeletonScreen count={3} width="100%" height="16px" gap="12px" />
 *
 * // 复杂页面骨架
 * <SkeletonScreen>
 *   <SkeletonScreen width="100%" height="200px" borderRadius="8px" />
 *   <SkeletonScreen width="60%" height="24px" />
 *   <SkeletonScreen count={3} width="100%" height="16px" />
 * </SkeletonScreen>
 * ```
 */
export const SkeletonScreen: React.FC<SkeletonScreenProps> = (props) => {
  const {
    count = 1,
    gap = '8px',
    className,
    style,
    children,
  } = props;

  // 在客户端注入动画样式
  React.useEffect(() => {
    injectStyles();
  }, []);

  // 如果有 children，作为容器使用
  if (children) {
    return (
      <div
        className={className}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: typeof gap === 'number' ? `${gap}px` : gap,
          ...style,
        }}
        role="status"
        aria-label="加载中..."
        aria-busy="true"
      >
        {children}
      </div>
    );
  }

  // 渲染指定数量的骨架块
  const skeletonStyle = getSkeletonStyle(props);
  const blocks = Array.from({ length: count }, (_, index) => (
    <span
      key={index}
      style={skeletonStyle}
      aria-hidden="true"
    />
  ));

  // 单个骨架块直接返回
  if (count === 1) {
    return (
      <span
        className={className}
        style={{ ...skeletonStyle, ...style }}
        role="status"
        aria-label="加载中..."
        aria-busy="true"
      />
    );
  }

  // 多个骨架块用容器包裹
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: typeof gap === 'number' ? `${gap}px` : gap,
        ...style,
      }}
      role="status"
      aria-label="加载中..."
      aria-busy="true"
    >
      {blocks}
    </div>
  );
};

/**
 * 默认的页面级骨架屏
 *
 * 提供一个通用的全页面骨架屏布局，适用于大部分页面结构。
 * 包含：顶部导航栏 + 大图 + 标题 + 多行文本 的典型布局。
 */
export const DefaultPageSkeleton: React.FC<{
  className?: string;
  style?: React.CSSProperties;
}> = ({ className, style }) => {
  return (
    <SkeletonScreen className={className} style={{ padding: '16px', ...style }} gap="16px">
      {/* 顶部导航栏骨架 */}
      <SkeletonScreen width="100%" height="48px" borderRadius="0" />

      {/* 主图区域骨架 */}
      <SkeletonScreen width="100%" height="200px" borderRadius="8px" />

      {/* 标题骨架 */}
      <SkeletonScreen width="70%" height="28px" borderRadius="4px" />

      {/* 副标题骨架 */}
      <SkeletonScreen width="40%" height="20px" borderRadius="4px" />

      {/* 正文段落骨架 */}
      <SkeletonScreen count={4} width="100%" height="16px" gap="10px" />

      {/* 底部操作区骨架 */}
      <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
        <SkeletonScreen width="120px" height="40px" borderRadius="20px" />
        <SkeletonScreen width="120px" height="40px" borderRadius="20px" />
      </div>
    </SkeletonScreen>
  );
};

SkeletonScreen.displayName = 'SkeletonScreen';
DefaultPageSkeleton.displayName = 'DefaultPageSkeleton';

// ==================== 新增骨架屏原子组件 ====================

/**
 * 骨架屏动画类型
 */
export type SkeletonAnimation = 'pulse' | 'wave' | 'none';

/**
 * 骨架屏基础属性
 */
export interface SkeletonBaseProps {
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  /** 动画类型 */
  animation?: SkeletonAnimation;
  /** 骨架屏背景色 */
  backgroundColor?: string;
  /** 波浪动画高亮色 */
  highlightColor?: string;
  /** 动画持续时间（秒） */
  animationDuration?: number;
  /** 圆角大小 */
  borderRadius?: string | number;
}

/** 默认背景色 */
const DEFAULT_BG_COLOR = '#e0e0e0';

/** 默认高亮色 */
const DEFAULT_HIGHLIGHT_COLOR = '#f5f5f5';

/** 默认动画时长 */
const DEFAULT_ANIM_DURATION = 1.5;

/**
 * 生成基础骨架屏样式
 */
function getAtomBaseStyle(props: SkeletonBaseProps): React.CSSProperties {
  const bgColor = props.backgroundColor ?? DEFAULT_BG_COLOR;
  const highlightColor = props.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR;
  const duration = props.animationDuration ?? DEFAULT_ANIM_DURATION;
  const animation = props.animation ?? 'pulse';

  const baseStyle: React.CSSProperties = {
    backgroundColor: bgColor,
    borderRadius: props.borderRadius ?? 4,
    display: 'inline-block',
    lineHeight: 1,
    ...props.style,
  };

  if (animation === 'pulse') {
    baseStyle.animation = `${ANIMATION_NAME} ${duration}s ease-in-out infinite`;
  }

  if (animation === 'wave') {
    baseStyle.backgroundImage = `linear-gradient(90deg, ${bgColor} 25%, ${highlightColor} 50%, ${bgColor} 75%)`;
    baseStyle.backgroundSize = '200% 100%';
    baseStyle.animation = `nami-skeleton-wave ${duration}s ease-in-out infinite`;
  }

  return baseStyle;
}

// ==================== SkeletonText 文本骨架 ====================

/**
 * 文本骨架属性
 */
export interface SkeletonTextProps extends SkeletonBaseProps {
  /** 文本行数 */
  lines?: number;
  /** 行宽度，可以是固定值或数组（为每行指定不同宽度） */
  width?: string | number | Array<string | number>;
  /** 行高度 */
  lineHeight?: string | number;
  /** 行间距 */
  lineSpacing?: string | number;
}

/**
 * 文本骨架组件
 *
 * 模拟文本内容的加载占位，支持多行显示。
 *
 * @example
 * ```tsx
 * <SkeletonText lines={3} width={['100%', '80%', '60%']} />
 * ```
 */
export const SkeletonText: React.FC<SkeletonTextProps> = (props) => {
  React.useEffect(() => { injectStyles(); }, []);

  const {
    lines = 1,
    width = '100%',
    lineHeight = 16,
    lineSpacing = 12,
    className,
    ...baseProps
  } = props;

  const lineElements: React.ReactElement[] = [];

  for (let i = 0; i < lines; i++) {
    let lineWidth: string | number;
    if (Array.isArray(width)) {
      lineWidth = width[i] ?? width[width.length - 1] ?? '100%';
    } else {
      lineWidth = i === lines - 1 && lines > 1 ? '60%' : width;
    }

    const style: React.CSSProperties = {
      ...getAtomBaseStyle(baseProps),
      width: typeof lineWidth === 'number' ? `${lineWidth}px` : lineWidth,
      height: typeof lineHeight === 'number' ? `${lineHeight}px` : lineHeight,
      display: 'block',
      marginTop: i > 0 ? (typeof lineSpacing === 'number' ? `${lineSpacing}px` : lineSpacing) : 0,
    };

    lineElements.push(
      <span key={i} className={className} style={style} role="presentation" aria-hidden="true" />,
    );
  }

  return <div data-nami-skeleton="text">{lineElements}</div>;
};

SkeletonText.displayName = 'SkeletonText';

// ==================== SkeletonImage 图片骨架 ====================

/**
 * 图片骨架属性
 */
export interface SkeletonImageProps extends SkeletonBaseProps {
  /** 图片宽度 */
  width?: string | number;
  /** 图片高度 */
  height?: string | number;
  /** 是否为圆形 */
  circle?: boolean;
}

/**
 * 图片骨架组件
 *
 * @example
 * ```tsx
 * <SkeletonImage width={200} height={150} />
 * ```
 */
export const SkeletonImage: React.FC<SkeletonImageProps> = (props) => {
  React.useEffect(() => { injectStyles(); }, []);

  const { width = 200, height = 150, circle = false, className, ...baseProps } = props;

  const style: React.CSSProperties = {
    ...getAtomBaseStyle(baseProps),
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: circle ? '50%' : (baseProps.borderRadius ?? 4),
  };

  return (
    <div className={className} style={style} data-nami-skeleton="image" role="presentation" aria-hidden="true" />
  );
};

SkeletonImage.displayName = 'SkeletonImage';

// ==================== SkeletonAvatar 头像骨架 ====================

/**
 * 头像骨架属性
 */
export interface SkeletonAvatarProps extends SkeletonBaseProps {
  /** 头像尺寸 */
  size?: number | 'small' | 'medium' | 'large';
  /** 形状：圆形或方形 */
  shape?: 'circle' | 'square';
}

/** 头像预设尺寸映射 */
const AVATAR_SIZES: Record<string, number> = { small: 32, medium: 40, large: 48 };

/**
 * 头像骨架组件
 *
 * @example
 * ```tsx
 * <SkeletonAvatar size="large" shape="circle" />
 * ```
 */
export const SkeletonAvatar: React.FC<SkeletonAvatarProps> = (props) => {
  React.useEffect(() => { injectStyles(); }, []);

  const { size = 'medium', shape = 'circle', className, ...baseProps } = props;
  const sizeValue = typeof size === 'number' ? size : (AVATAR_SIZES[size] ?? 40);

  const style: React.CSSProperties = {
    ...getAtomBaseStyle(baseProps),
    width: `${sizeValue}px`,
    height: `${sizeValue}px`,
    borderRadius: shape === 'circle' ? '50%' : (baseProps.borderRadius ?? 4),
    flexShrink: 0,
  };

  return (
    <div className={className} style={style} data-nami-skeleton="avatar" role="presentation" aria-hidden="true" />
  );
};

SkeletonAvatar.displayName = 'SkeletonAvatar';

// ==================== SkeletonButton 按钮骨架 ====================

/**
 * 按钮骨架属性
 */
export interface SkeletonButtonProps extends SkeletonBaseProps {
  /** 按钮宽度 */
  width?: string | number;
  /** 按钮高度 */
  height?: string | number;
  /** 按钮尺寸预设 */
  size?: 'small' | 'medium' | 'large';
}

/** 按钮尺寸预设 */
const BUTTON_SIZES: Record<string, { width: number; height: number }> = {
  small: { width: 64, height: 28 },
  medium: { width: 88, height: 36 },
  large: { width: 120, height: 44 },
};

/**
 * 按钮骨架组件
 *
 * @example
 * ```tsx
 * <SkeletonButton size="medium" />
 * ```
 */
export const SkeletonButton: React.FC<SkeletonButtonProps> = (props) => {
  React.useEffect(() => { injectStyles(); }, []);

  const { width, height, size = 'medium', className, ...baseProps } = props;
  const preset = BUTTON_SIZES[size] ?? BUTTON_SIZES['medium']!;

  const style: React.CSSProperties = {
    ...getAtomBaseStyle(baseProps),
    width: typeof (width ?? preset.width) === 'number' ? `${width ?? preset.width}px` : (width ?? preset.width),
    height: typeof (height ?? preset.height) === 'number' ? `${height ?? preset.height}px` : (height ?? preset.height),
    borderRadius: baseProps.borderRadius ?? 4,
  };

  return (
    <div className={className} style={style} data-nami-skeleton="button" role="presentation" aria-hidden="true" />
  );
};

SkeletonButton.displayName = 'SkeletonButton';

// ==================== SkeletonCard 卡片骨架 ====================

/**
 * 卡片骨架属性
 */
export interface SkeletonCardProps extends SkeletonBaseProps {
  /** 卡片宽度 */
  width?: string | number;
  /** 是否显示图片区域 */
  showImage?: boolean;
  /** 图片区域高度 */
  imageHeight?: string | number;
  /** 文本行数 */
  textLines?: number;
  /** 是否显示头像 */
  showAvatar?: boolean;
  /** 是否显示操作按钮 */
  showActions?: boolean;
  /** 内边距 */
  padding?: string | number;
}

/**
 * 卡片骨架组件
 *
 * 组合多个基础骨架组件，构成常见的卡片加载占位。
 *
 * @example
 * ```tsx
 * <SkeletonCard showImage showAvatar textLines={3} showActions />
 * ```
 */
export const SkeletonCard: React.FC<SkeletonCardProps> = (props) => {
  React.useEffect(() => { injectStyles(); }, []);

  const {
    width = '100%',
    showImage = true,
    imageHeight = 180,
    textLines = 3,
    showAvatar = false,
    showActions = false,
    padding = 16,
    className,
    animation = 'pulse',
    backgroundColor,
    highlightColor,
    animationDuration,
  } = props;

  const commonProps: SkeletonBaseProps = { animation, backgroundColor, highlightColor, animationDuration };

  const containerStyle: React.CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid #f0f0f0',
  };

  const bodyStyle: React.CSSProperties = {
    padding: typeof padding === 'number' ? `${padding}px` : padding,
  };

  return (
    <div className={className} style={containerStyle} data-nami-skeleton="card" role="presentation" aria-hidden="true">
      {showImage && (
        <SkeletonImage width="100%" height={imageHeight} {...commonProps} borderRadius={0} />
      )}
      <div style={bodyStyle}>
        {showAvatar && (
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <SkeletonAvatar size="medium" {...commonProps} />
            <div style={{ marginLeft: 12, flex: 1 }}>
              <SkeletonText lines={1} width="40%" lineHeight={14} {...commonProps} />
              <SkeletonText lines={1} width="20%" lineHeight={12} {...commonProps} style={{ marginTop: 8 }} />
            </div>
          </div>
        )}
        <SkeletonText lines={textLines} lineSpacing={10} {...commonProps} />
        {showActions && (
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <SkeletonButton size="small" {...commonProps} />
            <SkeletonButton size="small" {...commonProps} />
          </div>
        )}
      </div>
    </div>
  );
};

SkeletonCard.displayName = 'SkeletonCard';
