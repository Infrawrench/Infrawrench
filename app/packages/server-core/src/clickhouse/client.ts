import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { drizzle } from "drizzle-orm/clickhouse";
import * as schema from "./schema";

/** The Drizzle handle every reader and writer in this directory queries through. */
export type ClickHouseDb = ReturnType<typeof buildDb>;

let cachedClient: ClickHouseClient | null = null;
let cachedDb: ClickHouseDb | null = null;
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

function buildDb(client: ClickHouseClient) {
  return drizzle(client, { schema });
}

/**
 * Lazily-initialized singleton client pointed at the internal metrics cluster
 * (ClickHouse Cloud). Throws if env vars are missing — guard with
 * isClickHouseConfigured() at boundaries that may run without metrics
 * storage configured (e.g. tests, local dev).
 *
 * Prefer {@link getClickHouseDb}. This is the raw driver, and the two places
 * that still need it need it for reasons Drizzle does not cover: streaming a
 * result set row by row (`cost-exports/rows.ts`) and bulk `JSONEachRow` inserts
 * (`writers.ts`).
 */
export function getClickHouseClient(): ClickHouseClient {
  if (cachedClient) return cachedClient;
  if (!isClickHouseConfigured()) {
    throw new Error(
      "ClickHouse metrics is not configured. Set CLICKHOUSE_METRICS_URL, " +
        "CLICKHOUSE_METRICS_USER, CLICKHOUSE_METRICS_PASSWORD, CLICKHOUSE_METRICS_DATABASE.",
    );
  }
  cachedClient = createClient({
    url: process.env["CLICKHOUSE_METRICS_URL"]!,
    username: process.env["CLICKHOUSE_METRICS_USER"]!,
    password: process.env["CLICKHOUSE_METRICS_PASSWORD"]!,
    database: process.env["CLICKHOUSE_METRICS_DATABASE"]!,
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
    },
  });
  return cachedClient;
}

/**
 * The Drizzle database over the same singleton client.
 *
 * ClickHouse has no prepared-statement protocol, so the dialect renders every
 * parameter as a typed literal (`toDate('2026-01-01')`, `map('k', 'v')`) rather
 * than as an HTTP `{name:Type}` parameter. String content still goes through the
 * dialect's own escaping — nothing below interpolates a caller's value into SQL
 * text — but it does mean a statement carries its data, which is why bulk row
 * writes go through `writers.ts`'s `JSONEachRow` path instead of an
 * `INSERT ... VALUES` a megabyte wide.
 */
export function getClickHouseDb(): ClickHouseDb {
  if (cachedDb) return cachedDb;
  cachedDb = buildDb(getClickHouseClient());
  return cachedDb;
}

/** Test-only: drop the cached client so a new env can take effect. */
export function resetClickHouseClientForTests(): void {
  cachedClient = null;
  cachedDb = null;
  configured = null;
}
