import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.{js,jsx,ts,tsx}'],
    environment: 'node',
    globals: false,
  },
});
