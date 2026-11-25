import { defineConfig } from "vitest/config";

// The suites in `src/__tests__/db/` need a migrated Postgres and run through
// vitest.db.config.ts (`pnpm test:db`). Everything else needs nothing.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/__tests__/db/**", "node_modules/**"],
  },
});
