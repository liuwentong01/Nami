import type { NamiConfig, UserNamiConfig } from '../types/config';
import {
  DEFAULT_APP_NAME,
  DEFAULT_SRC_DIR,
  DEFAULT_OUT_DIR,
  DEFAULT_RENDER_MODE,
  DEFAULT_SERVER_CONFIG,
  DEFAULT_ISR_CONFIG,
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_FALLBACK_CONFIG,
  DEFAULT_ASSETS_CONFIG,
} from '../constants/defaults';
import { deepMerge } from './deep-merge';

/**
 * 把业务侧的局部 nami.config 配置解析为浏览器和服务端共用的完整配置。
 *
 * 该函数不读取文件、不访问 Node API，可安全用于 entry-client；CLI 的
 * ConfigLoader 也复用它，确保两端不会各维护一套默认值合并逻辑。
 */
export function resolveNamiConfig(userConfig: UserNamiConfig): NamiConfig {
  const defaults: NamiConfig = {
    appName: DEFAULT_APP_NAME,
    srcDir: DEFAULT_SRC_DIR,
    outDir: DEFAULT_OUT_DIR,
    defaultRenderMode: DEFAULT_RENDER_MODE,
    routes: [],
    server: { ...DEFAULT_SERVER_CONFIG },
    webpack: {},
    isr: { ...DEFAULT_ISR_CONFIG },
    assets: { ...DEFAULT_ASSETS_CONFIG },
    monitor: { ...DEFAULT_MONITOR_CONFIG },
    fallback: { ...DEFAULT_FALLBACK_CONFIG },
    plugins: [],
  };

  return deepMerge(
    defaults as unknown as Record<string, unknown>,
    userConfig as unknown as Record<string, unknown>,
  ) as unknown as NamiConfig;
}
