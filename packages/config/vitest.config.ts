import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'config',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
