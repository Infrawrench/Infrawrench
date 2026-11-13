import { beforeEach, describe, expect, it, vi } from "vitest";

const command = vi.fn(async (_opts?: unknown) => undefined);
const isConfigured = vi.fn(() => true);
// What `system.merge_tree_settings` says about allow_dimensions_outside_sorting_key.
const knowsDimensionsSetting = vi.fn(() => true);
const query = vi.fn(async (_opts?: unknown) => ({
  json: async () => [{ n: knowsDimensionsSetting() ? "1" : "0" }],
}));
vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => isConfigured(),
  getClickHouseClient: () => ({ command, query }),
}));

let migrate: typeof import("../clickhouse/migrate");

beforeEach(async () => {
  vi.clearAllMocks();
  isConfigured.mockReturnValue(true);
  knowsDimensionsSetting.mockReturnValue(true);
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
    // Every statement creates or adds, and every one is idempotent: this runs
    // on every boot, so a statement that is neither would fail the second time
    // (or, worse, succeed and destroy something).
    for (const q of queries) {
      // The builder renders `create table` in lower case and backticks every
      // identifier; only the shape is being asserted here.
      expect(q.trimStart()).toMatch(
        /^(create table if not exists|CREATE MATERIALIZED VIEW IF NOT EXISTS|ALTER TABLE `\w+` ADD COLUMN IF NOT EXISTS)\b/,
      );
    }
  });

  it("only ever ADDs columns — the cost_daily sort key is frozen", async () => {
    await migrate.migrateMetrics();
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    const alters = queries.filter((q) => q.trimStart().startsWith("ALTER"));
    expect(alters.length).toBeGreaterThan(0);
    for (const q of alters) {
      // Re-keying cost_daily would silently merge away three years of history
      // under ReplacingMergeTree; dropping or retyping a column loses it.
      expect(q).not.toMatch(/\b(MODIFY|DROP|RENAME|ORDER BY|PRIMARY KEY)\b/);
    }
  });

  it("gives every added cost_daily column a default so old rows still read", async () => {
    await migrate.migrateMetrics();
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    const added = queries.filter((q) => q.includes("ADD COLUMN IF NOT EXISTS"));
    // charge_type in particular: without DEFAULT 'usage' the whole back
    // catalogue reads as an empty string that matches no charge-type filter.
    expect(added.some((q) => /charge_type` .*DEFAULT 'usage'/.test(q))).toBe(true);
    expect(added.some((q) => /amortized_amount` .*DEFAULT 0/.test(q))).toBe(true);
    // amortized_reported defaults to 0 = "not reported", which drops every
    // pre-existing row onto the legacy `amortized_amount != 0` branch and so
    // reproduces exactly what those rows read before the column existed.
    expect(added.some((q) => /amortized_reported` UInt8 DEFAULT 0/.test(q))).toBe(true);
    expect(added.some((q) => /commitment_id` .*DEFAULT ''/.test(q))).toBe(true);
    // blended_reported = 0 means "no blended opinion": every row written before
    // the blended basis existed reads as its amortized amount.
    expect(added.some((q) => /blended_amount` .*DEFAULT 0/.test(q))).toBe(true);
    expect(added.some((q) => /blended_reported` UInt8 DEFAULT 0/.test(q))).toBe(true);
    for (const q of added) expect(q).toMatch(/DEFAULT/);
  });

  // #1116: 26.7 rejects an AggregatingMergeTree column outside the sorting key
  // that is not an aggregate state (`unit`) unless the table allows it, and
  // 24.8 rejects the setting as unknown, so it follows what the server has.
  it("allows dimensions outside the sorting key where the server has the setting", async () => {
    await migrate.migrateMetrics();
    expect(JSON.stringify(query.mock.calls[0]![0])).toContain("system.merge_tree_settings");
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    const withSetting = queries.filter((q) => q.includes("allow_dimensions_outside_sorting_key"));
    expect(withSetting.map((q) => q.match(/`(metric_points_\w+)`/)?.[1]).sort()).toEqual([
      "metric_points_1h",
      "metric_points_1m",
    ]);
    for (const q of withSetting) {
      expect(q).toMatch(/ENGINE = AggregatingMergeTree\b/);
      expect(q).toMatch(/ SETTINGS allow_dimensions_outside_sorting_key = 1$/);
    }
  });

  it("leaves the setting out where the server does not have it", async () => {
    knowsDimensionsSetting.mockReturnValue(false);
    await migrate.migrateMetrics();
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    expect(queries.length).toBeGreaterThanOrEqual(8);
    for (const q of queries) expect(q).not.toContain("SETTINGS");
  });

  it("keeps the setting on Replicated engines", async () => {
    process.env["CLICKHOUSE_METRICS_REPLICATED"] = "1";
    try {
      await migrate.migrateMetrics();
    } finally {
      delete process.env["CLICKHOUSE_METRICS_REPLICATED"];
    }
    const queries = command.mock.calls.map((c) => (c[0] as unknown as { query: string }).query);
    const aggregating = queries.filter((q) => q.includes("ReplicatedAggregatingMergeTree"));
    expect(aggregating).toHaveLength(2);
    for (const q of aggregating)
      expect(q).toMatch(/ SETTINGS allow_dimensions_outside_sorting_key = 1$/);
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

describe("withDimensionsOutsideSortingKey", () => {
  it("adds the setting to an AggregatingMergeTree table", () => {
    expect(
      migrate.withDimensionsOutsideSortingKey(
        "create table t (a String) ENGINE = AggregatingMergeTree ORDER BY a",
      ),
    ).toBe(
      "create table t (a String) ENGINE = AggregatingMergeTree ORDER BY a SETTINGS allow_dimensions_outside_sorting_key = 1",
    );
  });

  it("leaves other engines alone", () => {
    for (const engine of ["MergeTree", "ReplacingMergeTree(`ingested_at`)"]) {
      const stmt = `create table t (a String) ENGINE = ${engine} ORDER BY a`;
      expect(migrate.withDimensionsOutsideSortingKey(stmt)).toBe(stmt);
    }
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
