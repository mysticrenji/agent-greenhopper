import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Domain and graph packages are pure logic — hold them to a high bar.
      thresholds: {
        'packages/domain/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/graph/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
