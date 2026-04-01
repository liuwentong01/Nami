import { describe, it, expect } from 'vitest';
import { RouteMatcher } from '../src/router/route-matcher';

describe('RouteMatcher', () => {
  const matcher = new RouteMatcher();

  describe('static paths', () => {
    it('should match exact static paths', () => {
      const result = matcher.match('/about', '/about');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({});
    });

    it('should match root path', () => {
      const result = matcher.match('/', '/');
      expect(result.matched).toBe(true);
    });

    it('should not match different static paths', () => {
      const result = matcher.match('/about', '/contact');
      expect(result.matched).toBe(false);
    });

    it('should match with trailing slash', () => {
      const result = matcher.match('/about', '/about/');
      expect(result.matched).toBe(true);
    });

    it('should match multi-segment static paths', () => {
      const result = matcher.match('/user/profile', '/user/profile');
      expect(result.matched).toBe(true);
    });
  });

  describe('dynamic parameters', () => {
    it('should match single dynamic parameter', () => {
      const result = matcher.match('/user/:id', '/user/123');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ id: '123' });
    });

    it('should match multiple dynamic parameters', () => {
      const result = matcher.match('/post/:year/:slug', '/post/2024/hello');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ year: '2024', slug: 'hello' });
    });

    it('should decode URL-encoded parameters', () => {
      const result = matcher.match('/search/:query', '/search/hello%20world');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ query: 'hello world' });
    });

    it('should not match if required param is missing', () => {
      const result = matcher.match('/user/:id', '/user/');
      expect(result.matched).toBe(false);
    });

    it('should not match if path has more segments than pattern', () => {
      const result = matcher.match('/user/:id', '/user/123/extra');
      expect(result.matched).toBe(false);
    });
  });

  describe('optional parameters', () => {
    it('should match with optional parameter present', () => {
      const result = matcher.match('/user/:id?', '/user/123');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ id: '123' });
    });

    it('should match with optional parameter absent', () => {
      const result = matcher.match('/user/:id?', '/user');
      expect(result.matched).toBe(true);
    });
  });

  describe('wildcard', () => {
    it('should match wildcard paths', () => {
      const result = matcher.match('/docs/*', '/docs/getting-started/install');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ '*': 'getting-started/install' });
    });

    it('should match single segment with wildcard', () => {
      const result = matcher.match('/api/*', '/api/users');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ '*': 'users' });
    });
  });

  describe('edge cases', () => {
    it('should return false for empty pattern', () => {
      const result = matcher.match('', '/about');
      expect(result.matched).toBe(false);
    });

    it('should return false for empty path', () => {
      const result = matcher.match('/about', '');
      expect(result.matched).toBe(false);
    });

    it('should be case insensitive', () => {
      const result = matcher.match('/About', '/about');
      expect(result.matched).toBe(true);
    });
  });
});
