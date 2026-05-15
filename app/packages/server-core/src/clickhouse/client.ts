import { createClient, type ClickHouseClient } from "@clickhouse/client";

let cached: ClickHouseClient | null = null;
let configured: boolean | null = null;

/**
 * Returns true if the four CLICKHOUSE_METRICS_* env vars are set. The metrics
 * pipeline is best-effort: callers should skip writes (and degrade reads) when
 * this is false rather than crashing.
 */
export function isClickHouseConfigured(): boolean {
  if (configured !== null) return configured;
  configured = !!(
    process.env["CLICKHOUSE_METRICS_URL"] &&
    process.env["CLICKHOUSE_METRICS_USER"] &&
    process.env["CLICKHOUSE_METRICS_PASSWORD"] &&
    process.env["CLICKHOUSE_METRICS_DATABASE"]
  );
  return configured;
}

/**
 * Lazily-initialized singleton client pointed at the internal metrics cluster
 * (ClickHouse Cloud). Throws if env vars are missing — guard with
 * isClickHouseConfigured() at boundaries that may run without metrics
 * storage configured (e.g. tests, local dev).
 */
export function getClickHouseClient(): ClickHouseClient {
  if (cached) return cached;
  if (!isClickHouseConfigured()) {
    throw new Error(
      "ClickHouse metrics is not configured. Set CLICKHOUSE_METRICS_URL, " +
        "CLICKHOUSE_METRICS_USER, CLICKHOUSE_METRICS_PASSWORD, CLICKHOUSE_METRICS_DATABASE.",
    );
  }
  cached = createClient({
    url: process.env["CLICKHOUSE_METRICS_URL"]!,
    username: process.env["CLICKHOUSE_METRICS_USER"]!,
    password: process.env["CLICKHOUSE_METRICS_PASSWORD"]!,
    database: process.env["CLICKHOUSE_METRICS_DATABASE"]!,
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
    },
  });
  return cached;
}

/** Test-only: drop the cached client so a new env can take effect. */
export function resetClickHouseClientForTests(): void {
  cached = null;
  configured = null;
}
