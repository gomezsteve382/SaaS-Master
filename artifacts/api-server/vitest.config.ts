import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    globals: false,
    // The route under test mocks @workspace/db, so DATABASE_URL is never
    // actually read — but lib/db/src/index.ts throws at import time if it
    // is unset. Seed a placeholder so the module loads cleanly in CI.
    env: { DATABASE_URL: "postgres://test:test@localhost:5432/test" },
  },
});
