/**
 * @nami/shared - 默认配置常量
 *
 * 框架各模块的默认配置值。
 * 当业务方未在 nami.config.ts 中指定某项配置时，使用此处的默认值。
 */

import { RenderMode } from '../types/render-mode';
import type {
  ServerConfig,
  ISRConfig,
  MonitorConfig,
  FallbackConfig,
  AssetsConfig,
} from '../types/config';

/** 默认应用名称 */
export const DEFAULT_APP_NAME = 'nami-app';

/** 默认源码目录 */
export const DEFAULT_SRC_DIR = 'src';

/** 默认输出目录 */
export const DEFAULT_OUT_DIR = 'dist';

/** 默认渲染模式 */
export const DEFAULT_RENDER_MODE = RenderMode.CSR;

/** 默认 HTML 挂载容器 ID */
export const DEFAULT_CONTAINER_ID = 'nami-root';

/** 服务端注入数据的全局变量名 */
export const NAMI_DATA_VARIABLE = '__NAMI_DATA__';

/** 客户端路由数据预取接口前缀 */
export const NAMI_DATA_API_PREFIX = '/_nami/data';

/** ISR 内部后台重验证请求头 */
export const NAMI_ISR_REVALIDATE_HEADER = 'x-nami-isr-revalidate';

/** 资源清单文件名 */
export const ASSET_MANIFEST_FILENAME = 'asset-manifest.json';

/** 框架总清单文件名 */
export const NAMI_MANIFEST_FILENAME = 'nami-manifest.json';

/** 默认服务端配置 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 3000,
  host: '0.0.0.0',
  ssrTimeout: 5000,
  gracefulShutdown: true,
  gracefulShutdownTimeout: 30000,
};

/** 默认 ISR 配置 */
export const DEFAULT_ISR_CONFIG: ISRConfig = {
  enabled: false,
  cacheDir: '.nami-cache/isr',
  defaultRevalidate: 60,
  cacheAdapter: 'memory',
};

/** 默认监控配置 */
export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  enabled: false,
  sampleRate: 1,
  webVitals: true,
  renderMetrics: true,
};

/** 默认降级配置 */
export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  ssrToCSR: true,
  timeout: 5000,
  maxRetries: 0,
};

/** 默认静态资源配置 */
export const DEFAULT_ASSETS_CONFIG: AssetsConfig = {
  publicPath: '/',
  hash: true,
};

/** 健康检查端点路径 */
export const HEALTH_CHECK_PATH = '/_health';

/** ISR 重验证 API 路径前缀 */
export const ISR_REVALIDATE_PATH = '/_nami/revalidate';

/** SSR 超时最大允许值（毫秒） */
export const MAX_SSR_TIMEOUT = 30000;

/** ISR 最小重验证间隔（秒） */
export const MIN_REVALIDATE_INTERVAL = 1;

/** ISR 最大重验证间隔（秒）— 7 天 */
export const MAX_REVALIDATE_INTERVAL = 604800;
