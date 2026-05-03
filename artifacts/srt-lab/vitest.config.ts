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
    // The validation runner stresses the host hard enough that 5s default
    // timeouts flake on UI tests that load real binary fixtures into jsdom
    // and on tests that spawn subprocess parsers. Standalone runs of the
    // suite are consistently green; the bumped ceiling only takes effect
    // when something actually hangs, so legitimate hangs still fail.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
