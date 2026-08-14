/**
 * Global setup for the shadow run (vitest.shadow.config.ts): fail fast with a
 * usable message when the env vars are missing, and migrate the schema so the
 * shadowed statements have real tables to run against. Runs in vitest's own
 * process, where nothing is vi.mocked, so this is the real client.
 */
import { getClickHouseClient, isClickHouseConfigured } from "../../clickhouse/client";
import { migrateMetrics } from "../../clickhouse/migrate";

export default async function setup(): Promise<() => Promise<void>> {
  if (!isClickHouseConfigured()) {
    throw new Error(
      "test:clickhouse:shadow needs CLICKHOUSE_METRICS_URL, CLICKHOUSE_METRICS_USER, " +
        "CLICKHOUSE_METRICS_PASSWORD and CLICKHOUSE_METRICS_DATABASE pointed at a " +
        "scratch server (the shadowed inserts really write the suites' fixture rows).",
    );
  }
  await migrateMetrics();
  return async () => {
    await getClickHouseClient().close();
  };
}
