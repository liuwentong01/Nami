import { describe, it, expect } from 'vitest';
import { RenderMode } from '@nami/shared';
import { ConfigValidator } from '../config-validator';
import { createMockConfig } from '../../__tests__/mocks';

describe('ConfigValidator', () => {
  const validator = new ConfigValidator();

  // ==================== 合法配置 ====================

  describe('合法配置校验', () => {
    it('有效配置通过校验', () => {
      const config = createMockConfig();
      const result = validator.validate(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('包含完整路由配置的有效配置通过校验', () => {
      const config = createMockConfig({
        routes: [
          { path: '/', component: './pages/home', renderMode: RenderMode.CSR },
          { path: '/about', component: './pages/about', renderMode: RenderMode.SSR },
          { path: '/blog', component: './pages/blog', renderMode: RenderMode.SSG },
        ],
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ==================== appName 校验 ====================

  describe('appName 校验', () => {
    it('缺少 appName 校验失败', () => {
      const config = createMockConfig({ appName: '' });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('appName'))).toBe(true);
    });

    it('空白 appName 校验失败', () => {
      const config = createMockConfig({ appName: '   ' });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('appName'))).toBe(true);
    });
  });

  // ==================== 端口校验 ====================

  describe('server.port 校验', () => {
    it('端口为 0 校验失败', () => {
      const config = createMockConfig({
        server: {
          port: 0,
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

    it('端口超出范围校验失败', () => {
      const config = createMockConfig({
        server: {
          port: 70000,
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

    it('端口为小数校验失败', () => {
      const config = createMockConfig({
        server: {
          port: 3000.5,
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
  });

  // ==================== 渲染模式校验 ====================

  describe('defaultRenderMode 校验', () => {
    it('无效渲染模式校验失败', () => {
      const config = createMockConfig({
        defaultRenderMode: 'invalid-mode' as any,
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes('defaultRenderMode')),
      ).toBe(true);
    });

    it('有效渲染模式校验通过', () => {
      for (const mode of [
        RenderMode.CSR,
        RenderMode.SSR,
        RenderMode.SSG,
        RenderMode.ISR,
      ]) {
        const config = createMockConfig({ defaultRenderMode: mode });
        const result = validator.validate(config);
        // 不应该因 renderMode 报错
        expect(
          result.errors.some((e) => e.includes('defaultRenderMode')),
        ).toBe(false);
      }
    });
  });

  // ==================== 路由配置校验 ====================

  describe('路由配置校验', () => {
    it('路由 path 缺失校验失败', () => {
      const config = createMockConfig({
        routes: [
          { path: '', component: './pages/home', renderMode: RenderMode.CSR },
        ],
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('path'))).toBe(true);
    });

    it('路由 path 不以 / 开头校验失败', () => {
      const config = createMockConfig({
        routes: [
          {
            path: 'about',
            component: './pages/about',
            renderMode: RenderMode.CSR,
          },
        ],
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"/"'))).toBe(true);
    });

    it('路由 component 缺失校验失败', () => {
      const config = createMockConfig({
        routes: [
          { path: '/', component: '', renderMode: RenderMode.CSR },
        ],
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('component'))).toBe(true);
    });

    it('路由 renderMode 无效值校验失败', () => {
      const config = createMockConfig({
        routes: [
          {
            path: '/',
            component: './pages/home',
            renderMode: 'bad-mode' as any,
          },
        ],
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('renderMode'))).toBe(true);
    });

    it('重复路由路径校验失败', () => {
      const config = createMockConfig({
        routes: [
          { path: '/', component: './pages/home', renderMode: RenderMode.CSR },
          { path: '/', component: './pages/home2', renderMode: RenderMode.CSR },
        ],
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('重复'))).toBe(true);
    });
  });

  // ==================== SSR 超时校验 ====================

  describe('server.ssrTimeout 校验', () => {
    it('ssrTimeout 为 0 校验失败', () => {
      const config = createMockConfig({
        server: {
          port: 3000,
          host: '0.0.0.0',
          ssrTimeout: 0,
          gracefulShutdown: true,
          gracefulShutdownTimeout: 30000,
        },
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('ssrTimeout'))).toBe(true);
    });

    it('ssrTimeout 超过最大值校验失败', () => {
      const config = createMockConfig({
        server: {
          port: 3000,
          host: '0.0.0.0',
          ssrTimeout: 999999,
          gracefulShutdown: true,
          gracefulShutdownTimeout: 30000,
        },
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('ssrTimeout'))).toBe(true);
    });
  });

  // ==================== 收集所有错误 ====================

  describe('错误收集策略', () => {
    it('同时存在多个错误时全部收集', () => {
      const config = createMockConfig({
        appName: '',
        defaultRenderMode: 'invalid' as any,
        server: {
          port: 0,
          host: '0.0.0.0',
          ssrTimeout: -1,
          gracefulShutdown: true,
          gracefulShutdownTimeout: 30000,
        },
      });
      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      // 至少应有 appName、renderMode、port、ssrTimeout 四类错误
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});
