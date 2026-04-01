import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/index.ts',
        '**/*.d.ts',
        '**/types.ts',
      ],
    },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@nami/shared': path.resolve(__dirname, 'packages/shared/src'),
      '@nami/core': path.resolve(__dirname, 'packages/core/src'),
      '@nami/server': path.resolve(__dirname, 'packages/server/src'),
      '@nami/client': path.resolve(__dirname, 'packages/client/src'),
      '@nami/webpack': path.resolve(__dirname, 'packages/webpack/src'),
    },
  },
});
