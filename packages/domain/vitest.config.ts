import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'domain',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
