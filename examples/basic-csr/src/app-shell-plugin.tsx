import type { NamiPlugin } from '@nami/shared';
import App from './app';

/** 服务端、构建期与客户端共用的应用外壳，保证 wrapApp 顺序一致。 */
const appShellPlugin: NamiPlugin = {
  name: 'example:csr-app-shell',
  version: '1.0.0',
  setup(api) {
    api.wrapApp((app) => <App>{app}</App>);
  },
};

export default appShellPlugin;
