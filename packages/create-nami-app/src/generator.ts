/**
 * create-nami-app - 项目生成器
 *
 * 根据用户选择的模板和插件，生成完整的项目目录结构。
 */

import path from 'path';
import fs from 'fs-extra';
import ejs from 'ejs';
import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'child_process';
import type { ProjectOptions } from './prompts';

/**
 * 生成选项
 */
interface GenerateOptions {
  /** 是否跳过依赖安装 */
  skipInstall?: boolean;
  /** 包管理器 */
  packageManager?: 'pnpm' | 'npm' | 'yarn';
}

/**
 * 生成项目
 *
 * @param options - 项目配置选项
 * @param generateOptions - 生成选项
 */
export async function generateProject(
  options: ProjectOptions,
  generateOptions: GenerateOptions = {},
): Promise<void> {
  const { projectName, description, template, plugins, author } = options;
  const { skipInstall = false, packageManager = 'pnpm' } = generateOptions;

  const targetDir = path.resolve(process.cwd(), projectName);

  // 检查目标目录
  if (fs.existsSync(targetDir)) {
    const files = fs.readdirSync(targetDir);
    if (files.length > 0) {
      console.log(chalk.red(`  目录 ${projectName} 不为空，请选择一个空目录或新名称。`));
      process.exit(1);
    }
  }

  const spinner = ora('正在生成项目...').start();

  try {
    // 创建目录
    fs.mkdirSync(targetDir, { recursive: true });

    // 模板数据
    const templateData = {
      projectName,
      description,
      template,
      plugins,
      author,
      isSSR: template === 'ssr' || template === 'full',
      isSSG: template === 'ssg' || template === 'full',
      isCSR: template === 'csr' || template === 'full',
      hasPluginCache: plugins.includes('@nami/plugin-cache'),
      hasPluginMonitor: plugins.includes('@nami/plugin-monitor'),
      hasPluginSkeleton: plugins.includes('@nami/plugin-skeleton'),
      hasPluginRequest: plugins.includes('@nami/plugin-request'),
      hasPluginErrorBoundary: plugins.includes('@nami/plugin-error-boundary'),
    };

    // 生成 package.json
    await writeTemplate(targetDir, 'package.json', generatePackageJson(templateData));

    // 生成 tsconfig.json
    await writeTemplate(targetDir, 'tsconfig.json', generateTsConfig());

    // 生成 nami.config.ts
    await writeTemplate(targetDir, 'nami.config.ts', generateNamiConfig(templateData));

    // 生成 .gitignore
    await writeTemplate(targetDir, '.gitignore', generateGitignore());

    // 生成源码目录
    const srcDir = path.join(targetDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'pages'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'layouts'), { recursive: true });

    // 生成入口文件
    await writeTemplate(path.join(srcDir), 'app.tsx', generateAppTsx(templateData));
    await writeTemplate(path.join(srcDir), 'entry-client.tsx', generateEntryClient());

    if (templateData.isSSR) {
      await writeTemplate(path.join(srcDir), 'entry-server.tsx', generateEntryServer());
    }

    // 生成页面
    await writeTemplate(path.join(srcDir, 'pages'), 'home.tsx', generateHomePage(templateData));
    await writeTemplate(path.join(srcDir, 'pages'), 'about.tsx', generateAboutPage());

    // 生成布局
    await writeTemplate(path.join(srcDir, 'layouts'), 'default.tsx', generateDefaultLayout());

    // 生成全局样式
    await writeTemplate(path.join(srcDir), 'global.css', generateGlobalCss());

    spinner.succeed('项目生成完成');

    // 安装依赖
    if (!skipInstall) {
      const installSpinner = ora('正在安装依赖...').start();
      try {
        execSync(`${packageManager} install`, {
          cwd: targetDir,
          stdio: 'pipe',
        });
        installSpinner.succeed('依赖安装完成');
      } catch {
        installSpinner.warn('依赖安装失败，请手动执行安装');
      }
    }

    // 初始化 Git
    try {
      execSync('git init', { cwd: targetDir, stdio: 'pipe' });
    } catch {
      // Git 初始化失败不影响项目创建
    }
  } catch (error) {
    spinner.fail('项目生成失败');
    throw error;
  }
}

// ==================== 模板生成函数 ====================

async function writeTemplate(dir: string, filename: string, content: string): Promise<void> {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function generatePackageJson(data: Record<string, unknown>): string {
  const deps: Record<string, string> = {
    '@nami/core': '^0.1.0',
    '@nami/shared': '^0.1.0',
    '@nami/client': '^0.1.0',
    'react': '^18.2.0',
    'react-dom': '^18.2.0',
  };

  if (data.isSSR) {
    deps['@nami/server'] = '^0.1.0';
  }

  // 添加选择的插件
  for (const plugin of (data.plugins as string[]) || []) {
    deps[plugin] = '^0.1.0';
  }

  return JSON.stringify(
    {
      name: data.projectName,
      version: '0.1.0',
      private: true,
      description: data.description,
      scripts: {
        dev: 'nami dev',
        build: 'nami build',
        start: 'nami start',
        generate: 'nami generate',
      },
      dependencies: deps,
      devDependencies: {
        '@nami/cli': '^0.1.0',
        '@nami/webpack': '^0.1.0',
        '@types/react': '^18.2.0',
        '@types/react-dom': '^18.2.0',
        typescript: '^5.3.0',
      },
    },
    null,
    2,
  );
}

function generateTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        moduleResolution: 'node',
        strict: true,
        jsx: 'react-jsx',
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        isolatedModules: true,
        baseUrl: '.',
        paths: {
          '@/*': ['src/*'],
        },
      },
      include: ['src'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  );
}

function generateNamiConfig(data: Record<string, unknown>): string {
  const renderMode = data.isSSR ? 'ssr' : data.isSSG ? 'ssg' : 'csr';

  const pluginImports = ((data.plugins as string[]) || [])
    .map((p) => {
      const className = resolvePluginClassName(p);
      return className ? `import { ${className} } from '${p}';` : '';
    })
    .filter(Boolean)
    .join('\n');

  const pluginArray = ((data.plugins as string[]) || [])
    .map((p) => {
      const className = resolvePluginClassName(p);
      return className ? `    new ${className}()` : '';
    })
    .filter(Boolean)
    .join(',\n');

  return `/**
 * Nami 框架配置文件
 * @see https://nami.dev/docs/config
 */
import { defineConfig, RenderMode } from '@nami/core';
${pluginImports}

export default defineConfig({
  appName: '${data.projectName}',
  defaultRenderMode: RenderMode.${renderMode.toUpperCase()},

  routes: [
    {
      path: '/',
      component: './pages/home',
      renderMode: RenderMode.${renderMode.toUpperCase()},
    },
    {
      path: '/about',
      component: './pages/about',
      renderMode: RenderMode.CSR,
    },
  ],

  server: {
    port: 3000,
  },

  plugins: [
${pluginArray}
  ],
});
`;
}

function resolvePluginClassName(packageName: string): string | null {
  const pluginClassMap: Record<string, string> = {
    '@nami/plugin-cache': 'NamiCachePlugin',
    '@nami/plugin-monitor': 'NamiMonitorPlugin',
    '@nami/plugin-skeleton': 'NamiSkeletonPlugin',
    '@nami/plugin-request': 'NamiRequestPlugin',
    '@nami/plugin-error-boundary': 'NamiErrorBoundaryPlugin',
  };

  return pluginClassMap[packageName] ?? null;
}

function generateGitignore(): string {
  return `node_modules/
dist/
.nami-cache/
*.tsbuildinfo
.env
.env.local
.DS_Store
`;
}

function generateAppTsx(data: Record<string, unknown>): string {
  return `/**
 * 应用根组件
 */
import React from 'react';
import './global.css';

interface AppProps {
  children: React.ReactNode;
}

export default function App({ children }: AppProps) {
  return (
    <div className="nami-app">
      <header className="app-header">
        <nav>
          <a href="/">首页</a>
          <a href="/about">关于</a>
        </nav>
      </header>
      <main className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <p>Powered by Nami Framework</p>
      </footer>
    </div>
  );
}
`;
}

function generateEntryClient(): string {
  return `/**
 * 客户端入口
 */
import { initNamiClient } from '@nami/client';

initNamiClient({
  containerId: 'nami-root',
});
`;
}

function generateEntryServer(): string {
  return `/**
 * 服务端入口（SSR）
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './app';

export async function renderToHTML(url: string, props: Record<string, unknown>) {
  const html = renderToString(
    <App>
      <div>Server rendered: {url}</div>
    </App>
  );
  return html;
}
`;
}

function generateHomePage(data: Record<string, unknown>): string {
  const hasSSR = data.isSSR;
  const exports = hasSSR
    ? `
/**
 * 服务端数据预取
 */
export async function getServerSideProps() {
  return {
    props: {
      message: '来自服务端的数据',
      timestamp: new Date().toISOString(),
    },
  };
}
`
    : '';

  return `/**
 * 首页
 */
import React from 'react';

interface HomePageProps {
  message?: string;
  timestamp?: string;
}

export default function HomePage({ message, timestamp }: HomePageProps) {
  return (
    <div className="page-home">
      <h1>欢迎使用 Nami 框架</h1>
      <p>集团级前端框架 - CSR/SSR/SSG/ISR 多渲染模式</p>
      ${hasSSR ? `{message && <p className="server-data">服务端数据: {message} ({timestamp})</p>}` : ''}
    </div>
  );
}
${exports}`;
}

function generateAboutPage(): string {
  return `/**
 * 关于页面
 */
import React from 'react';

export default function AboutPage() {
  return (
    <div className="page-about">
      <h1>关于</h1>
      <p>这是一个使用 Nami 框架创建的应用。</p>
      <ul>
        <li>React 18 - UI 框架</li>
        <li>TypeScript - 类型安全</li>
        <li>Koa 3 - 服务端框架</li>
        <li>Webpack 5 - 构建工具</li>
      </ul>
    </div>
  );
}
`;
}

function generateDefaultLayout(): string {
  return `/**
 * 默认布局组件
 */
import React from 'react';

interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout({ children }: DefaultLayoutProps) {
  return (
    <div className="layout-default">
      {children}
    </div>
  );
}
`;
}

function generateGlobalCss(): string {
  return `/* 全局样式 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #333;
  line-height: 1.6;
}

.nami-app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  padding: 1rem 2rem;
  background: #f5f5f5;
  border-bottom: 1px solid #e0e0e0;
}

.app-header nav a {
  margin-right: 1rem;
  color: #0070f3;
  text-decoration: none;
}

.app-header nav a:hover {
  text-decoration: underline;
}

.app-main {
  flex: 1;
  padding: 2rem;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

.app-footer {
  padding: 1rem 2rem;
  text-align: center;
  color: #999;
  border-top: 1px solid #e0e0e0;
}
`;
}
