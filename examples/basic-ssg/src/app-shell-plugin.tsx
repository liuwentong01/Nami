import type { NamiPlugin } from '@nami/shared';
import App from './app';

/** 构建期与客户端共用的应用外壳，保证静态 HTML 可被同构 Hydration。 */
const appShellPlugin: NamiPlugin = {
  name: 'example:ssg-app-shell',
  version: '1.0.0',
  setup(api) {
    api.wrapApp((app) => <App>{app}</App>);
  },
};

export default appShellPlugin;
