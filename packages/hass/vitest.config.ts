import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'hass',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
