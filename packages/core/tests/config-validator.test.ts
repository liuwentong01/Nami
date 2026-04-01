import { describe, it, expect } from 'vitest';
import { ConfigValidator } from '../src/config/config-validator';
import { RenderMode } from '@nami/shared';
import type { NamiConfig } from '@nami/shared';

/**
 * 创建一个合法的完整配置用于测试
 */
function createValidConfig(overrides: Partial<NamiConfig> = {}): NamiConfig {
  return {
    appName: 'test-app',
    defaultRenderMode: RenderMode.CSR,
    srcDir: 'src',
    outDir: 'dist',
    routes: [{ path: '/', component: './pages/home' }],
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
    ...overrides,
  } as NamiConfig;
}

describe('ConfigValidator', () => {
  const validator = new ConfigValidator();

  it('should accept valid minimal config', () => {
    const config = createValidConfig();
    const result = validator.validate(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject config without appName', () => {
    const config = createValidConfig({ appName: '' });
    const result = validator.validate(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should reject config without routes', () => {
    const config = createValidConfig({ routes: undefined as any });
    const result = validator.validate(config);
    expect(result.valid).toBe(false);
  });

  it('should reject route without path', () => {
    const config = createValidConfig({
      routes: [{ component: './pages/home' } as any],
    });
    const result = validator.validate(config);
    expect(result.valid).toBe(false);
  });

  it('should reject route without component', () => {
    const config = createValidConfig({
      routes: [{ path: '/' } as any],
    });
    const result = validator.validate(config);
    expect(result.valid).toBe(false);
  });

  it('should reject invalid server port', () => {
    const config = createValidConfig({
      server: {
        port: 99999,
        host: '0.0.0.0',
        ssrTimeout: 5000,
        gracefulShutdown: true,
        gracefulShutdownTimeout: 30000,
      },
    });
    const result = validator.validate(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('port'))).toBe(true);
  });

  it('should reject invalid render mode on route', () => {
    const config = createValidConfig({
      routes: [{ path: '/', component: './pages/home', renderMode: 'invalid' as any }],
    });
    const result = validator.validate(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('renderMode'))).toBe(true);
  });
});
