import { describe, it, expect, beforeEach } from 'vitest';
import { RouteMatcher } from '../route-matcher';

describe('RouteMatcher', () => {
  let matcher: RouteMatcher;

  beforeEach(() => {
    matcher = new RouteMatcher();
  });

  // ==================== 静态路径匹配 ====================

  describe('静态路径匹配', () => {
    it('精确匹配静态路径', () => {
      const result = matcher.match('/about', '/about');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({});
    });

    it('匹配多段静态路径', () => {
      const result = matcher.match('/user/profile', '/user/profile');
      expect(result.matched).toBe(true);
    });

    it('允许尾部可选斜杠', () => {
      const result = matcher.match('/about', '/about/');
      expect(result.matched).toBe(true);
    });

    it('路径不匹配返回 false', () => {
      const result = matcher.match('/about', '/contact');
      expect(result.matched).toBe(false);
      expect(result.params).toEqual({});
    });

    it('不区分大小写', () => {
      const result = matcher.match('/About', '/about');
      expect(result.matched).toBe(true);
    });
  });

  // ==================== 动态参数匹配 ====================

  describe('动态参数匹配（/user/:id）', () => {
    it('匹配单个动态参数', () => {
      const result = matcher.match('/user/:id', '/user/123');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ id: '123' });
    });

    it('匹配多个动态参数', () => {
      const result = matcher.match('/post/:year/:slug', '/post/2024/hello');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ year: '2024', slug: 'hello' });
    });

    it('动态参数路径段不匹配时返回 false', () => {
      const result = matcher.match('/user/:id', '/post/123');
      expect(result.matched).toBe(false);
    });

    it('缺少参数值时不匹配', () => {
      const result = matcher.match('/user/:id', '/user');
      expect(result.matched).toBe(false);
    });

    it('URL 编码参数值被正确解码', () => {
      const result = matcher.match('/user/:name', '/user/%E5%BC%A0%E4%B8%89');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ name: '张三' });
    });
  });

  // ==================== 可选参数匹配 ====================

  describe('可选参数匹配（/user/:id?）', () => {
    it('提供可选参数时匹配成功', () => {
      const result = matcher.match('/user/:id?', '/user/123');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ id: '123' });
    });

    it('省略可选参数时仍然匹配', () => {
      const result = matcher.match('/user/:id?', '/user');
      expect(result.matched).toBe(true);
      // id 可选，省略时不在 params 中
    });
  });

  // ==================== 通配符匹配 ====================

  describe('通配符匹配（/docs/*）', () => {
    it('匹配单层路径', () => {
      const result = matcher.match('/docs/*', '/docs/getting-started');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ '*': 'getting-started' });
    });

    it('匹配多层嵌套路径', () => {
      const result = matcher.match('/docs/*', '/docs/getting-started/install');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ '*': 'getting-started/install' });
    });

    it('通配符不匹配空路径', () => {
      // /docs/* 要求 * 至少有一个字符
      const result = matcher.match('/docs/*', '/docs');
      expect(result.matched).toBe(false);
    });
  });

  // ==================== 不匹配场景 ====================

  describe('不匹配场景', () => {
    it('空模式返回 false', () => {
      const result = matcher.match('', '/about');
      expect(result.matched).toBe(false);
    });

    it('空路径返回 false', () => {
      const result = matcher.match('/about', '');
      expect(result.matched).toBe(false);
    });

    it('完全不同的路径不匹配', () => {
      const result = matcher.match('/user/:id', '/api/data');
      expect(result.matched).toBe(false);
    });
  });
});
