import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/__tests__/**/*.test.{js,jsx,ts,tsx}'],
    // Default to Node for the lib-only suites; the React UI suite opts into
    // jsdom via a `// @vitest-environment jsdom` directive at the top of the file.
    environment: 'node',
    globals: false,
  },
});
