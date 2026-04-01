import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginManager } from '../src/plugin/plugin-manager';
import type { NamiPlugin, NamiConfig } from '@nami/shared';
import { RenderMode } from '@nami/shared';

/**
 * 创建测试用的完整 NamiConfig
 */
function createTestConfig(): NamiConfig {
  return {
    appName: 'test-app',
    defaultRenderMode: RenderMode.CSR,
    srcDir: 'src',
    outDir: 'dist',
    routes: [],
    server: {
      port: 3000,
      host: '0.0.0.0',
      ssrTimeout: 5000,
      gracefulShutdown: true,
      gracefulShutdownTimeout: 30000,
    },
    webpack: {},
    isr: {
      enabled: false,
      cacheDir: '.nami-cache/isr',
      defaultRevalidate: 60,
      cacheAdapter: 'memory',
    },
    assets: { publicPath: '/', hash: true },
    monitor: { enabled: false, sampleRate: 1 },
    fallback: { ssrToCSR: true, timeout: 5000, maxRetries: 0 },
    plugins: [],
  } as NamiConfig;
}

describe('PluginManager', () => {
  let pm: PluginManager;

  beforeEach(() => {
    pm = new PluginManager(createTestConfig());
  });

  describe('registerPlugins', () => {
    it('should register plugins successfully', async () => {
      const plugin: NamiPlugin = {
        name: 'test-plugin',
        setup: vi.fn(),
      };

      await pm.registerPlugins([plugin]);

      // setup should have been called
      expect(plugin.setup).toHaveBeenCalledTimes(1);
    });

    it('should skip duplicate plugin names', async () => {
      const plugin1: NamiPlugin = { name: 'dup', setup: vi.fn() };
      const plugin2: NamiPlugin = { name: 'dup', setup: vi.fn() };

      await pm.registerPlugins([plugin1, plugin2]);

      expect(plugin1.setup).toHaveBeenCalledTimes(1);
      // Second plugin with same name should be skipped
      expect(plugin2.setup).not.toHaveBeenCalled();
    });
  });

  describe('runParallelHook', () => {
    it('should run hooks registered by plugins', async () => {
      const hookFn = vi.fn();

      const plugin: NamiPlugin = {
        name: 'hook-test',
        setup: (api) => {
          api.onClientInit(hookFn);
        },
      };

      await pm.registerPlugins([plugin]);
      await pm.runParallelHook('onClientInit');

      expect(hookFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRegisteredPlugins', () => {
    it('should return all registered plugins', async () => {
      const plugin1: NamiPlugin = { name: 'p1', setup: vi.fn() };
      const plugin2: NamiPlugin = { name: 'p2', setup: vi.fn() };

      await pm.registerPlugins([plugin1, plugin2]);

      const registered = pm.getRegisteredPlugins();
      expect(registered).toHaveLength(2);
      expect(registered.map((p) => p.name)).toEqual(['p1', 'p2']);
    });
  });

  describe('dispose', () => {
    it('should mark manager as disposed', async () => {
      expect(pm.isDisposed()).toBe(false);
      await pm.dispose();
      expect(pm.isDisposed()).toBe(true);
    });

    it('should prevent registering plugins after dispose', async () => {
      await pm.dispose();

      const plugin: NamiPlugin = { name: 'late', setup: vi.fn() };
      await expect(pm.registerPlugin(plugin)).rejects.toThrow();
    });
  });
});
