import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/*
 * Shadow run of the existing mocked ClickHouse suites (`pnpm
 * test:clickhouse:shadow`): the same unit tests, unchanged and in place, but
 * with `helpers/fake-clickhouse.ts` also executing every captured statement
 * against the real server named by CLICKHOUSE_METRICS_* — see the shadow-mode
 * notes in that helper. Collection is by content, not location: any
 * `src/__tests__` suite that uses the helper is picked up automatically.
 *
 * Serial and with long limits for the same reason as vitest.db.config.ts: every
 * statement now includes a server round trip.
 */
const testsDir = "src/__tests__";
const include = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => readFileSync(join(testsDir, name), "utf8").includes("helpers/fake-clickhouse"))
  .map((name) => `${testsDir}/${name}`);

export default defineConfig({
  test: {
    environment: "node",
    include,
    env: { INFRAWRENCH_SHADOW_CLICKHOUSE: "1" },
    globalSetup: ["src/__tests__/helpers/shadow-clickhouse-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
