import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.{js,ts}'],
    environment: 'node',
    globals: false,
  },
});
