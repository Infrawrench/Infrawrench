/**
 * Copy the analytics tables from the retired ClickHouse cluster into the
 * Postgres at DATABASE_URL. One-off, for the cutover in KNOWLEDGE.md
 * ("Analytics on Postgres: cutover"); the logic, and why a rerun is safe, is in
 * `src/analytics/clickhouse-copy.ts`.
 *
 *   DATABASE_URL=postgres://...          the destination, migrated to 0188 or later
 *   CLICKHOUSE_URL=https://...           the source's HTTP interface (the old
 *                                        CLICKHOUSE_METRICS_URL)
 *   CLICKHOUSE_USER=infrawrench          default "default"
 *   CLICKHOUSE_PASSWORD=...              default empty
 *   CLICKHOUSE_DATABASE=infrawrench      default "infrawrench"
 *   CLICKHOUSE_HEADERS='{"CF-Access-Client-Id":"...","CF-Access-Client-Secret":"..."}'
 *                                        optional, sent with every request (the old
 *                                        CLICKHOUSE_METRICS_HTTP_HEADERS)
 *
 *   pnpm --filter @infrawrench/server-core exec tsx scripts/copy-clickhouse-to-postgres.ts --dry-run
 *   pnpm --filter @infrawrench/server-core exec tsx scripts/copy-clickhouse-to-postgres.ts
 *
 * `--dry-run` only counts both sides. `--tables cost_daily,poll_outcomes`
 * limits the run to those tables. It prints per-table source, inserted and
 * destination counts at the end, and exits 1 when a destination table holds
 * fewer rows than its source.
 */
import { createDb } from "../src/db/client";
import {
  copyClickHouseToPostgres,
  formatCopyReport,
  sourceFromEnv,
} from "../src/analytics/clickhouse-copy";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tablesArg = args.find((a, i) => args[i - 1] === "--tables" || a.startsWith("--tables="));
const tables = tablesArg
  ?.replace(/^--tables=/, "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const source = sourceFromEnv(process.env);
const { db, close } = createDb(databaseUrl, { max: 2 });

try {
  console.log(
    `${dryRun ? "Counting" : "Copying"} ${source.database} at ${new URL(source.url).host} ` +
      `into ${new URL(databaseUrl).host}${new URL(databaseUrl).pathname}`,
  );
  const results = await copyClickHouseToPostgres({
    db,
    source,
    dryRun,
    ...(tables ? { tables } : {}),
    log: (line) => console.log(line),
  });
  console.log("");
  console.log(formatCopyReport(results, dryRun));
  if (!dryRun && results.some((r) => r.destination < r.source)) process.exitCode = 1;
} finally {
  await close();
}
