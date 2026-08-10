import { beforeEach, describe, expect, it, vi } from "vitest";

const command = vi.fn(async (_opts?: unknown) => undefined);
const isConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => isConfigured(),
  getClickHouseClient: () => ({ command }),
}));

let migrate: typeof import("../clickhouse/migrate");

beforeEach(async () => {
  vi.clearAllMocks();
  isConfigured.mockReturnValue(true);
  migrate = await import("../clickhouse/migrate");
});

describe("migrateMetrics", () => {
  it("no-ops when ClickHouse is not configured", async () => {
    isConfigured.mockReturnValue(false);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await migrate.migrateMetrics();
    expect(command).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });

  it("issues all DDL statements when configured", async () => {
    await migrate.migrateMetrics();
    expect(command.mock.calls.length).toBeGreaterThanOrEqual(8);
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    expect(queries.some((q) => q.includes("metric_points_raw"))).toBe(true);
    expect(queries.some((q) => q.includes("mv_metric_points_1m"))).toBe(true);
    expect(queries.some((q) => q.includes("poll_outcomes"))).toBe(true);
    // every statement is a CREATE
    for (const q of queries) expect(q.trimStart().startsWith("CREATE")).toBe(true);
  });

  it("propagates a command error", async () => {
    command.mockRejectedValueOnce(new Error("ddl fail"));
    await expect(migrate.migrateMetrics()).rejects.toThrow("ddl fail");
  });

  it("keeps plain engines unless CLICKHOUSE_METRICS_REPLICATED=1", async () => {
    await migrate.migrateMetrics();
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    for (const q of queries) expect(q).not.toContain("Replicated");
  });

  it("emits Replicated* engines when CLICKHOUSE_METRICS_REPLICATED=1", async () => {
    process.env["CLICKHOUSE_METRICS_REPLICATED"] = "1";
    try {
      await migrate.migrateMetrics();
    } finally {
      delete process.env["CLICKHOUSE_METRICS_REPLICATED"];
    }
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    const engines = queries.flatMap((q) => q.match(/ENGINE = \w+/g) ?? []);
    expect(engines.length).toBeGreaterThan(0);
    for (const e of engines) expect(e).toMatch(/^ENGINE = Replicated\w*MergeTree$/);
  });
});

describe("withReplicatedEngines", () => {
  it("rewrites plain MergeTree", () => {
    expect(migrate.withReplicatedEngines("ENGINE = MergeTree\nORDER BY ts")).toBe(
      "ENGINE = ReplicatedMergeTree\nORDER BY ts",
    );
  });

  it("rewrites AggregatingMergeTree", () => {
    expect(migrate.withReplicatedEngines(") ENGINE = AggregatingMergeTree\nPARTITION BY x")).toBe(
      ") ENGINE = ReplicatedAggregatingMergeTree\nPARTITION BY x",
    );
  });

  it("rewrites ReplacingMergeTree and keeps its version argument", () => {
    expect(migrate.withReplicatedEngines(") ENGINE = ReplacingMergeTree(ingested_at)")).toBe(
      ") ENGINE = ReplicatedReplacingMergeTree(ingested_at)",
    );
  });

  it("leaves statements without a MergeTree engine alone", () => {
    const mv = "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_x TO x AS SELECT 1";
    expect(migrate.withReplicatedEngines(mv)).toBe(mv);
  });
});
