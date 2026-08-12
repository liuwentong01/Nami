import type { NamiPlugin } from '@nami/shared';
import App from './app';

/** 构建、重验证与客户端共用的应用外壳，保证各缓存快照结构一致。 */
const appShellPlugin: NamiPlugin = {
  name: 'example:isr-app-shell',
  version: '1.0.0',
  setup(api) {
    api.wrapApp((app) => <App>{app}</App>);
  },
};

export default appShellPlugin;
