import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/*
 * Shadow run of the mocked Postgres suites (`pnpm test:postgres:shadow`): the
 * same unit tests, unchanged and in place, but with `helpers/fake-postgres.ts`
 * also PREPARE-validating every captured statement against the real server at
 * DATABASE_URL — see the shadow-mode notes in that helper. Collection is by
 * content, not location: any `src/__tests__` suite using the helper is picked
 * up automatically, so migrating a suite off its hand-rolled db stub is what
 * enrols it here.
 */
const testsDir = "src/__tests__";
const include = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => readFileSync(join(testsDir, name), "utf8").includes("helpers/fake-postgres"))
  .map((name) => `${testsDir}/${name}`);

export default defineConfig({
  test: {
    environment: "node",
    include,
    env: { INFRAWRENCH_SHADOW_POSTGRES: "1" },
    globalSetup: ["src/__tests__/helpers/shadow-postgres-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
