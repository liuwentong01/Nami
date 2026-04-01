import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookType, NamiError } from '@nami/shared';
import { PluginManager } from '../plugin-manager';
import { createMockConfig } from '../../__tests__/mocks';
import type { NamiPlugin, PluginAPI } from '@nami/shared';

describe('PluginManager', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager(createMockConfig());
  });

  // ==================== 插件注册 ====================

  describe('插件注册', () => {
    it('成功注册插件', async () => {
      const plugin: NamiPlugin = {
        name: 'test-plugin',
        setup: vi.fn(),
      };

      await manager.registerPlugin(plugin);

      expect(manager.hasPlugin('test-plugin')).toBe(true);
      expect(manager.getPluginCount()).toBe(1);
      expect(plugin.setup).toHaveBeenCalled();
    });

    it('批量注册插件', async () => {
      const plugins: NamiPlugin[] = [
        { name: 'plugin-a', setup: vi.fn() },
        { name: 'plugin-b', setup: vi.fn() },
        { name: 'plugin-c', setup: vi.fn() },
      ];

      await manager.registerPlugins(plugins);

      expect(manager.getPluginCount()).toBe(3);
    });

    it('重复注册同名插件会跳过', async () => {
      const plugin: NamiPlugin = {
        name: 'duplicate-plugin',
        setup: vi.fn(),
      };

      await manager.registerPlugin(plugin);
      await manager.registerPlugin(plugin);

      expect(manager.getPluginCount()).toBe(1);
      // setup 只被调用一次
      expect(plugin.setup).toHaveBeenCalledTimes(1);
    });

    it('缺少 name 字段时抛出错误', async () => {
      const plugin = {
        name: '',
        setup: vi.fn(),
      } as NamiPlugin;

      await expect(manager.registerPlugin(plugin)).rejects.toThrow();
    });

    it('缺少 setup 方法时抛出错误', async () => {
      const plugin = {
        name: 'bad-plugin',
      } as NamiPlugin;

      await expect(manager.registerPlugin(plugin)).rejects.toThrow();
    });
  });

  // ==================== Waterfall 钩子 ====================

  describe('runWaterfallHook（瀑布流钩子）', () => {
    it('按顺序传递值，前一个输出作为下一个输入', async () => {
      const plugin1: NamiPlugin = {
        name: 'plugin-1',
        setup(api: PluginAPI) {
          api.modifyRoutes((routes) => [...routes, { path: '/a', component: './a', renderMode: 'csr' as any }]);
        },
      };
      const plugin2: NamiPlugin = {
        name: 'plugin-2',
        setup(api: PluginAPI) {
          api.modifyRoutes((routes) => [...routes, { path: '/b', component: './b', renderMode: 'csr' as any }]);
        },
      };

      await manager.registerPlugins([plugin1, plugin2]);

      const result = await manager.runWaterfallHook('modifyRoutes', []);

      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('/a');
      expect(result[1].path).toBe('/b');
    });

    it('处理器返回 undefined 时保持上一个值', async () => {
      const plugin: NamiPlugin = {
        name: 'noop-plugin',
        setup(api: PluginAPI) {
          api.modifyRoutes(() => undefined as any);
        },
      };

      await manager.registerPlugin(plugin);

      const initial = [{ path: '/', component: './home', renderMode: 'csr' as any }];
      const result = await manager.runWaterfallHook('modifyRoutes', initial);

      // undefined 返回值被忽略，保持初始值
      expect(result).toEqual(initial);
    });

    it('没有处理器时返回初始值', async () => {
      const initial = { key: 'value' };
      const result = await manager.runWaterfallHook('modifyWebpackConfig', initial);
      expect(result).toBe(initial);
    });
  });

  // ==================== Parallel 钩子 ====================

  describe('runParallelHook（并行钩子）', () => {
    it('并行执行所有处理器', async () => {
      const results: string[] = [];

      const plugin1: NamiPlugin = {
        name: 'plugin-1',
        setup(api: PluginAPI) {
          api.onBuildStart(async () => {
            results.push('plugin-1');
          });
        },
      };
      const plugin2: NamiPlugin = {
        name: 'plugin-2',
        setup(api: PluginAPI) {
          api.onBuildStart(async () => {
            results.push('plugin-2');
          });
        },
      };

      await manager.registerPlugins([plugin1, plugin2]);
      await manager.runParallelHook('onBuildStart');

      expect(results).toContain('plugin-1');
      expect(results).toContain('plugin-2');
    });
  });

  // ==================== Bail 钩子 ====================

  describe('runBailHook（短路钩子）', () => {
    // 使用一个未在 HOOK_DEFINITIONS 中定义的钩子测试会触发 warn，
    // 但 bail 逻辑本身需要使用已定义的 bail 钩子。
    // 目前框架中没有定义 bail 类型的钩子，所以我们直接测试底层行为。
    // 由于 validateHookType 只打 warn 日志不阻断，我们可以利用任意钩子名测试逻辑。

    it('没有处理器时返回 undefined', async () => {
      // 直接调用一个已定义的钩子（没有注册处理器）
      // runBailHook 对任何已定义的钩子都能调用，只是类型不匹配会 warn
      const result = await manager.runBailHook('onBeforeRender');
      expect(result).toBeUndefined();
    });
  });

  // ==================== 错误隔离 ====================

  describe('错误隔离', () => {
    it('Waterfall 钩子中单个处理器抛错不影响其他处理器', async () => {
      const plugin1: NamiPlugin = {
        name: 'error-plugin',
        setup(api: PluginAPI) {
          api.modifyRoutes(() => {
            throw new Error('插件1报错');
          });
        },
      };
      const plugin2: NamiPlugin = {
        name: 'ok-plugin',
        setup(api: PluginAPI) {
          api.modifyRoutes((routes) => [
            ...routes,
            { path: '/ok', component: './ok', renderMode: 'csr' as any },
          ]);
        },
      };

      await manager.registerPlugins([plugin1, plugin2]);

      const result = await manager.runWaterfallHook('modifyRoutes', []);
      // 尽管 plugin1 抛错，plugin2 仍然能执行
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/ok');
    });

    it('Parallel 钩子中单个处理器抛错不影响其他处理器', async () => {
      const results: string[] = [];

      const plugin1: NamiPlugin = {
        name: 'error-plugin',
        setup(api: PluginAPI) {
          api.onBuildStart(() => {
            throw new Error('插件1报错');
          });
        },
      };
      const plugin2: NamiPlugin = {
        name: 'ok-plugin',
        setup(api: PluginAPI) {
          api.onBuildStart(async () => {
            results.push('plugin-2-执行成功');
          });
        },
      };

      await manager.registerPlugins([plugin1, plugin2]);
      await manager.runParallelHook('onBuildStart');

      expect(results).toContain('plugin-2-执行成功');
    });
  });

  // ==================== 插件销毁 ====================

  describe('dispose（插件销毁）', () => {
    it('调用所有 onDispose 钩子', async () => {
      const disposeFn = vi.fn();
      const plugin: NamiPlugin = {
        name: 'disposable-plugin',
        setup(api: PluginAPI) {
          api.onDispose(disposeFn);
        },
      };

      await manager.registerPlugin(plugin);
      await manager.dispose();

      expect(disposeFn).toHaveBeenCalled();
    });

    it('销毁后 isDisposed() 返回 true', async () => {
      expect(manager.isDisposed()).toBe(false);
      await manager.dispose();
      expect(manager.isDisposed()).toBe(true);
    });

    it('销毁后无法注册新插件', async () => {
      await manager.dispose();

      const plugin: NamiPlugin = {
        name: 'late-plugin',
        setup: vi.fn(),
      };

      await expect(manager.registerPlugin(plugin)).rejects.toThrow();
    });

    it('销毁后无法执行钩子', async () => {
      await manager.dispose();

      await expect(
        manager.runWaterfallHook('modifyRoutes', []),
      ).rejects.toThrow();
    });

    it('重复调用 dispose 不会报错', async () => {
      await manager.dispose();
      await expect(manager.dispose()).resolves.toBeUndefined();
    });
  });
});
