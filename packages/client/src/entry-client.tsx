/**
 * @nami/client - 客户端入口
 *
 * initNamiClient 是整个 Nami 客户端运行时的启动入口函数。
 * 它完成以下工作：
 *
 * 1. 初始化插件系统 — 加载和注册所有客户端插件
 * 2. 读取服务端注入数据 — 从 window.__NAMI_DATA__ 恢复预取数据
 * 3. 构建应用组件树 — 创建 NamiApp 并应用 wrapApp 插件钩子
 * 4. 挂载应用 — 根据渲染模式选择 hydrateRoot（SSR）或 createRoot（CSR）
 * 5. 触发生命周期钩子 — 依次触发 onClientInit 和 onHydrated 钩子
 * 6. 启动性能监控 — 收集 Web Vitals 指标
 * 7. 注册 Service Worker — 如果配置了 SW 路径则注册
 *
 * 调用时机：
 * 由 webpack 构建的客户端 bundle 在浏览器中加载后自动调用。
 * 通常在构建产物的 entry.client.js 文件中：
 *
 * ```typescript
 * import { initNamiClient } from '@nami/client';
 * initNamiClient({ routes, plugins, config });
 * ```
 *
 * @module
 */

import React from 'react';
import type { ClientOptions, NamiPlugin, AppWrapper, RenderMode } from '@nami/shared';
import {
  createLogger,
  NAMI_DATA_VARIABLE,
  NAMI_DATA_PROTOCOL_VERSION,
  DEFAULT_CONTAINER_ID,
  NamiError,
  ErrorCode,
  ErrorSeverity,
  isDev,
} from '@nami/shared';
import { PluginManager } from '@nami/core-client-shim';
import { NamiApp } from './app';
import type { NamiAppProps } from './app';
import { hydrateApp, renderApp } from './hydration/hydrate';
import { reportMismatch } from './hydration/hydration-mismatch';
import { readServerData, cleanupServerData } from './data/data-hydrator';
import { markNamiEvent, measureBetween } from './performance/performance-mark';
import { collectWebVitals } from './performance/web-vitals';
import type { ComponentResolver } from './router/nami-router';
import { ClientErrorBoundary } from './error/client-error-boundary';

// ==================== 类型定义 ====================

/**
 * 扩展的客户端初始化选项
 *
 * 在 @nami/shared 的 ClientOptions 基础上增加客户端特有的配置。
 */
export interface InitClientOptions extends ClientOptions {
  /**
   * 组件解析器
   *
   * 由 webpack 构建阶段注入，负责将路由配置中的组件路径
   * 映射到实际的 JS 模块动态 import 函数。
   */
  componentResolver?: ComponentResolver;

  /**
   * 路由加载中的全局 fallback。
   * 未传时由框架为 CSR 与客户端导航提供默认骨架；显式传 null 可关闭。
   */
  loadingFallback?: React.ReactNode;

  /**
   * 应用级错误降级 UI
   */
  errorFallback?: NamiAppProps['errorFallback'];

  /**
   * Service Worker 脚本路径
   *
   * 配置后框架会在应用初始化完成后自动注册 Service Worker。
   * 通常用于 PWA 离线缓存、资源预缓存等场景。
   *
   * @example '/sw.js'
   */
  serviceWorkerUrl?: string;

  /**
   * Service Worker 注册选项
   *
   * 传递给 navigator.serviceWorker.register() 的配置对象。
   */
  serviceWorkerOptions?: RegistrationOptions;
}

// ==================== 内部工具 ====================

/** 模块日志 */
const logger = createLogger('@nami/client:entry');

/**
 * 在 React 根节点建立前发生致命错误时，替换仍停留在页面中的 CSR Shell 骨架。
 *
 * 这里刻意使用 DOM API 而不是 innerHTML：错误文本可能来自插件或网络环境，
 * 只能作为文本展示，不能被解释为 HTML。重试采用整页 reload，确保插件状态、
 * 动态 import 缓存和注水数据都从干净环境重新初始化。
 */
function renderBootstrapErrorPage(containerId: string, error: unknown): void {
  if (typeof document === 'undefined') return;

  const container = document.getElementById(containerId);
  if (!container) return;

  const section = document.createElement('section');
  section.setAttribute('data-nami-client-error', 'bootstrap');
  section.setAttribute('role', 'alert');
  section.style.boxSizing = 'border-box';
  section.style.maxWidth = '720px';
  section.style.margin = '64px auto';
  section.style.padding = '32px';
  section.style.border = '1px solid #e5e7eb';
  section.style.borderRadius = '12px';
  section.style.fontFamily = 'system-ui, sans-serif';
  section.style.textAlign = 'center';

  const title = document.createElement('h1');
  title.textContent = '页面初始化失败';
  title.style.margin = '0 0 12px';
  title.style.fontSize = '24px';

  const description = document.createElement('p');
  description.textContent = '客户端未能完成初始化，请重新加载后重试。';
  description.style.margin = '0';
  description.style.color = '#6b7280';

  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = '重新加载';
  retryButton.style.marginTop = '20px';
  retryButton.style.padding = '9px 18px';
  retryButton.style.border = '1px solid #d1d5db';
  retryButton.style.borderRadius = '6px';
  retryButton.style.background = '#fff';
  retryButton.style.cursor = 'pointer';
  retryButton.addEventListener('click', () => window.location.reload());

  section.append(title, description);

  if (isDev()) {
    const detail = document.createElement('pre');
    detail.textContent = error instanceof Error ? error.message : String(error);
    detail.style.margin = '20px 0 0';
    detail.style.padding = '12px';
    detail.style.overflow = 'auto';
    detail.style.borderRadius = '6px';
    detail.style.background = '#f9fafb';
    detail.style.textAlign = 'left';
    detail.style.whiteSpace = 'pre-wrap';
    section.append(detail);
  }

  section.append(retryButton);
  container.replaceChildren(section);
}

/**
 * 注册 Service Worker
 *
 * 在应用初始化完成后注册 Service Worker。
 * 如果浏览器不支持 Service Worker 则静默跳过。
 * 注册失败不影响应用正常运行。
 *
 * @param url     - Service Worker 脚本路径
 * @param options - 注册选项（如 scope）
 */
async function registerServiceWorker(url: string, options?: RegistrationOptions): Promise<void> {
  // 检查浏览器是否支持 Service Worker
  if (!('serviceWorker' in navigator)) {
    logger.debug('浏览器不支持 Service Worker，跳过注册');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register(url, options);

    logger.info('Service Worker 注册成功', {
      scope: registration.scope,
      scriptURL: url,
    });

    // 监听更新事件
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (newWorker) {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // 有新版本可用（当前已有活跃的 SW 实例）
            logger.info('Service Worker 有新版本可用', {
              state: newWorker.state,
            });
          }
        });
      }
    });
  } catch (error) {
    // Service Worker 注册失败不应阻断应用启动
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Service Worker 注册失败', {
      url,
      error: message,
    });
  }
}

// ==================== 主入口函数 ====================

/**
 * 初始化 Nami 客户端运行时
 *
 * 这是客户端应用的唯一启动入口。执行完整的初始化流程：
 * 插件注册 → 数据恢复 → 组件树构建 → 应用挂载 → 生命周期回调 → 性能监控 → SW 注册
 *
 * @param options - 客户端初始化选项
 * @returns Promise — 初始化完成后 resolve
 *
 * @example
 * ```typescript
 * 在 webpack 入口文件中调用
 * import { initNamiClient } from '@nami/client';
 * import routes from './routes';
 * import config from './nami.config';
 * import plugins from './plugins';
 *
 * initNamiClient({
 *   routes,
 *   plugins,
 *   config,
 *   containerId: 'nami-root',
 *   serviceWorkerUrl: '/sw.js',
 * }).then(() => {
 *   console.log('Nami 客户端初始化完成');
 * }).catch((error) => {
 *   console.error('Nami 客户端初始化失败:', error);
 * });
 * ```
 */
export async function initNamiClient(options: InitClientOptions): Promise<void> {
  const {
    routes,
    plugins,
    config,
    containerId = DEFAULT_CONTAINER_ID,
    componentResolver,
    loadingFallback,
    errorFallback,
    serviceWorkerUrl,
    serviceWorkerOptions,
  } = options;

  // ==================== 阶段 0：标记初始化开始 ====================

  markNamiEvent('client-init-start');
  logger.info('Nami 客户端初始化开始', {
    appName: config.appName,
    routeCount: routes.length,
    pluginCount: plugins.length,
    containerId,
  });

  // 提交给 React 前保持 false；提交后即使 API 同步抛错，也不再用 DOM API
  // 改写同一容器，避免和一个可能已经建立的 React Root 竞争所有权。
  let reactRootStarted = false;
  let registeredPluginManager: PluginManager | undefined;

  try {
    // ==================== 阶段 1：初始化插件系统 ====================

    markNamiEvent('plugin-init-start');

    const pluginManager = new PluginManager(config);
    registeredPluginManager = pluginManager;

    /**
     * 客户端运行时只接受已经解析完成的插件实例。
     *
     * 历史实现里这里会直接静默过滤掉字符串插件，容易让调用方误以为插件已经生效。
     * 现在改为显式告警：服务端仍可通过 PluginLoader 解析字符串插件，
     * 但客户端必须在构建阶段把它们转换成真实插件对象再传入。
     */
    const unresolvedPluginNames = plugins.filter(
      (plugin) => typeof plugin === 'string',
    ) as string[];

    if (unresolvedPluginNames.length > 0) {
      logger.warn('检测到未解析的客户端插件字符串，相关插件将在客户端被忽略', {
        plugins: unresolvedPluginNames,
      });
    }

    const pluginInstances = plugins.filter((p): p is NamiPlugin => typeof p !== 'string');

    await pluginManager.registerPlugins(pluginInstances);

    markNamiEvent('plugin-init-end');
    logger.info('插件系统初始化完成', { count: pluginInstances.length });

    // ==================== 阶段 2：触发 onClientInit 钩子 ====================

    markNamiEvent('client-init-hooks-start');

    await pluginManager.runParallelHook('onClientInit');

    markNamiEvent('client-init-hooks-end');
    logger.debug('onClientInit 钩子执行完成');

    // ==================== 阶段 3：读取服务端注入数据 ====================

    markNamiEvent('data-read-start');

    const serverData = readServerData();
    const renderMode = (serverData.renderMode || config.defaultRenderMode) as RenderMode;

    markNamiEvent('data-read-end');
    logger.info('服务端数据读取完成', {
      renderMode,
      hasProps: !!serverData.props,
    });

    // ==================== 阶段 4：构建应用组件树 ====================

    markNamiEvent('app-build-start');

    /**
     * 路由变化处理函数
     *
     * 每次客户端路由切换时触发，执行所有插件的 onRouteChange 钩子。
     */
    const handleRouteChange = (info: { from: string; to: string }) => {
      void pluginManager.runParallelHook('onRouteChange', {
        from: info.from,
        to: info.to,
        params: {},
      });
    };

    /**
     * 错误处理函数
     *
     * 应用级错误边界捕获到错误时触发，执行所有插件的 onError 钩子。
     */
    const handleError = (error: Error) => {
      void pluginManager.runParallelHook('onError', error, {
        source: 'client-error-boundary',
      });
    };

    /**
     * 创建 NamiApp 根元素
     */
    let appElement: React.ReactElement = (
      <NamiApp
        routes={routes}
        config={config}
        initialData={serverData.props}
        initialDataDegraded={serverData.degraded}
        initialRoutePath={serverData.routePath}
        initialRenderMode={serverData.renderMode}
        componentResolver={componentResolver}
        onRouteChange={handleRouteChange}
        onError={handleError}
        loadingFallback={loadingFallback}
        errorFallback={errorFallback}
      />
    );

    // ==================== 阶段 5：执行 wrapApp 钩子 ====================

    /**
     * wrapApp 钩子允许插件用 Provider 等组件包裹应用根节点。
     * 例如：ThemeProvider、StoreProvider、IntlProvider 等。
     *
     * 钩子类型为 waterfall — 层层包裹：
     * Plugin A: (app) => <ThemeProvider>{app}</ThemeProvider>
     * Plugin B: (app) => <StoreProvider>{app}</StoreProvider>
     * 最终结果: <StoreProvider><ThemeProvider><NamiApp /></ThemeProvider></StoreProvider>
     */
    appElement = await pluginManager.runWaterfallHook<React.ReactElement>('wrapApp', appElement);

    // NamiApp 内部边界负责页面与路由错误；这一层位于插件 wrapper 外侧，
    // 兜住插件在客户端渲染阶段引入的异常。外层刻意使用框架默认错误页，避免
    // 自定义 errorFallback 本身抛错时被第二个边界再次渲染同一个坏 fallback。
    appElement = <ClientErrorBoundary onError={handleError}>{appElement}</ClientErrorBoundary>;

    markNamiEvent('app-build-end');
    logger.debug('应用组件树构建完成');

    // ==================== 阶段 6：挂载应用 ====================

    markNamiEvent('mount-start');

    /**
     * 获取挂载容器 DOM 元素
     */
    const container = document.getElementById(containerId);
    if (!container) {
      throw new NamiError(
        `找不到挂载容器元素: #${containerId}`,
        ErrorCode.CLIENT_INIT_FAILED,
        ErrorSeverity.Fatal,
        { containerId },
      );
    }

    /**
     * 根据渲染模式选择挂载方式：
     *
     * - SSR/SSG/ISR: 使用 hydrateRoot
     *   容器中已有服务端渲染的 HTML，React 只需附加事件和交互
     *
     * - CSR: 使用 createRoot
     *   容器为空，React 需要完整创建所有 DOM 节点
     */
    const isSSR = renderMode !== 'csr';
    const hasCompatibleHydrationPayload = serverData.version === NAMI_DATA_PROTOCOL_VERSION;

    if (isSSR && hasCompatibleHydrationPayload && container.childNodes.length > 0) {
      logger.info('使用 Hydration 模式挂载', { renderMode });

      // hydrateApp/createRoot 可能在调用内部同步抛错。提前标记所有权，确保
      // catch 不会直接改写一个可能已被 React 接管的容器。
      reactRootStarted = true;
      hydrateApp(container, appElement, {
        onRecoverableError: (error) => {
          // 上报 Hydration 不匹配错误
          reportMismatch(
            error,
            { renderMode, appName: config.appName },
            {
              reportUrl: config.monitor?.reportUrl,
              sampleRate: config.monitor?.sampleRate,
            },
          );
        },
        onHydrated: () => {
          markNamiEvent('hydration-end');

          // 测量 Hydration 耗时
          const hydrationMeasure = measureBetween('mount-start', 'hydration-end');
          if (hydrationMeasure) {
            logger.info('Hydration 完成', {
              duration: `${hydrationMeasure.duration.toFixed(2)}ms`,
            });
          }

          // 清理服务端数据
          cleanupServerData();

          // 触发 onHydrated 钩子
          void pluginManager.runParallelHook('onHydrated');
        },
      });
    } else {
      logger.info('使用 CSR 模式挂载', {
        renderMode,
        reason: hasCompatibleHydrationPayload
          ? '容器为空或路由为 CSR'
          : '不存在兼容的服务端注水协议',
      });

      reactRootStarted = true;
      renderApp(container, appElement);

      markNamiEvent('csr-render-end');

      // CSR 模式也触发 onHydrated 钩子（保持接口一致性）
      void pluginManager.runParallelHook('onHydrated');
    }

    markNamiEvent('mount-end');

    // ==================== 阶段 7：启动性能监控 ====================

    if (config.monitor?.enabled && config.monitor.webVitals !== false) {
      const cleanupVitals = collectWebVitals(
        (metric) => {
          logger.debug('Web Vital 指标', {
            name: metric.name,
            value: metric.value,
            rating: metric.rating,
          });
        },
        {
          sampleRate: config.monitor.sampleRate,
          reportUrl: config.monitor.reportUrl,
        },
      );

      // 页面卸载时清理
      window.addEventListener('beforeunload', cleanupVitals, { once: true });
    }

    // ==================== 阶段 8：注册 Service Worker ====================

    if (serviceWorkerUrl) {
      /**
       * 在页面加载完成后注册 Service Worker
       *
       * 延迟到 load 事件后注册，避免 SW 的预缓存逻辑
       * 与首屏资源加载产生带宽竞争，影响首屏性能。
       */
      if (document.readyState === 'complete') {
        // 页面已加载完成，直接注册
        void registerServiceWorker(serviceWorkerUrl, serviceWorkerOptions);
      } else {
        // 等待页面加载完成后注册
        window.addEventListener(
          'load',
          () => {
            void registerServiceWorker(serviceWorkerUrl, serviceWorkerOptions);
          },
          { once: true },
        );
      }
    }

    // ==================== 阶段 9：标记初始化完成 ====================

    markNamiEvent('client-init-end');

    const initMeasure = measureBetween('client-init-start', 'client-init-end');
    logger.info('Nami 客户端初始化完成', {
      duration: initMeasure ? `${initMeasure.duration.toFixed(2)}ms` : 'N/A',
      renderMode,
      appName: config.appName,
    });
  } catch (error) {
    /**
     * 顶层错误处理
     *
     * 如果初始化过程中发生致命错误（如容器不存在、插件加载失败），
     * 在这里捕获并给出明确的错误信息。
     */
    markNamiEvent('client-init-error');

    const message = error instanceof Error ? error.message : String(error);

    logger.fatal('Nami 客户端初始化失败', {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // 开发环境下在控制台输出完整错误
    if (isDev()) {
      console.error('[Nami] 客户端初始化失败:', error);
    }

    if (!reactRootStarted) {
      renderBootstrapErrorPage(containerId, error);
    }
    if (!reactRootStarted && registeredPluginManager) {
      try {
        await registeredPluginManager.dispose();
      } catch (disposeError) {
        logger.warn('客户端初始化回滚时插件销毁失败', {
          error: disposeError instanceof Error ? disposeError.message : String(disposeError),
        });
      }
    }

    // 重新抛出以便外部 catch 处理
    throw error instanceof NamiError
      ? error
      : new NamiError(
          `客户端初始化失败: ${message}`,
          ErrorCode.CLIENT_INIT_FAILED,
          ErrorSeverity.Fatal,
          { originalError: message },
        );
  }
}
