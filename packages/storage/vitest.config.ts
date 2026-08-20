import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'storage',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
