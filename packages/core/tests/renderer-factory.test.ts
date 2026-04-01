import { describe, it, expect, vi } from 'vitest';
import { RendererFactory } from '../src/renderer';
import { CSRRenderer } from '../src/renderer/csr-renderer';
import { SSRRenderer } from '../src/renderer/ssr-renderer';
import { SSGRenderer } from '../src/renderer/ssg-renderer';
import { RenderMode } from '@nami/shared';

/**
 * 创建最小化的测试配置
 */
function createTestConfig(overrides: Partial<any> = {}): any {
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
      compression: true,
      healthCheck: { enabled: true, path: '/_health' },
    },
    assets: {
      publicPath: '/',
    },
    title: 'Test App',
    description: '',
    plugins: [],
    fallback: {
      maxRetries: 2,
      skeleton: true,
      staticHTML: '',
    },
    ...overrides,
  };
}

describe('RendererFactory', () => {
  describe('create()', () => {
    it('should create CSRRenderer for CSR mode', () => {
      const renderer = RendererFactory.create({
        mode: RenderMode.CSR,
        config: createTestConfig(),
      });

      expect(renderer).toBeInstanceOf(CSRRenderer);
    });

    it('should create SSRRenderer for SSR mode with appElementFactory', () => {
      const renderer = RendererFactory.create({
        mode: RenderMode.SSR,
        config: createTestConfig(),
        appElementFactory: () => null,
      });

      expect(renderer).toBeInstanceOf(SSRRenderer);
    });

    it('should throw when creating SSR without appElementFactory', () => {
      expect(() => {
        RendererFactory.create({
          mode: RenderMode.SSR,
          config: createTestConfig(),
        });
      }).toThrow('appElementFactory');
    });

    it('should create SSGRenderer for SSG mode', () => {
      const renderer = RendererFactory.create({
        mode: RenderMode.SSG,
        config: createTestConfig(),
      });

      expect(renderer).toBeInstanceOf(SSGRenderer);
    });
  });

  describe('getFallbackMode()', () => {
    it('should return CSR as fallback for SSR', () => {
      expect(RendererFactory.getFallbackMode(RenderMode.SSR)).toBe(RenderMode.CSR);
    });

    it('should return CSR as fallback for SSG', () => {
      expect(RendererFactory.getFallbackMode(RenderMode.SSG)).toBe(RenderMode.CSR);
    });

    it('should return CSR as fallback for ISR', () => {
      expect(RendererFactory.getFallbackMode(RenderMode.ISR)).toBe(RenderMode.CSR);
    });

    it('should return null as fallback for CSR', () => {
      expect(RendererFactory.getFallbackMode(RenderMode.CSR)).toBeNull();
    });
  });

  describe('requiresServerRuntime()', () => {
    it('should return true for SSR', () => {
      expect(RendererFactory.requiresServerRuntime(RenderMode.SSR)).toBe(true);
    });

    it('should return true for ISR', () => {
      expect(RendererFactory.requiresServerRuntime(RenderMode.ISR)).toBe(true);
    });

    it('should return false for CSR', () => {
      expect(RendererFactory.requiresServerRuntime(RenderMode.CSR)).toBe(false);
    });

    it('should return false for SSG', () => {
      expect(RendererFactory.requiresServerRuntime(RenderMode.SSG)).toBe(false);
    });
  });
});
