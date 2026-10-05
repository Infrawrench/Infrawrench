/**
 * Virtual tags compile into the reader's own statement. These tests assert on
 * the actual SQL the readers emit over a fake driver (see `fake-clickhouse.ts`),
 * which is also what `pnpm test:clickhouse:shadow` replays against a real
 * server.
 *
 * The properties that matter:
 *
 * 1. A query that mentions no virtual tag emits exactly the SQL it did before.
 * 2. A scalar tag is a `multiIf` and needs no join.
 * 3. A split tag is an `ARRAY JOIN` whose weight multiplies the money, raw and
 *    adjusted alike, so a split can never change a total.
 * 4. An unresolved key throws; it never degrades to unfiltered spend.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledVirtualTag } from "../clickhouse/virtual-tag-sql";
import { fakeClickHouse } from "./helpers/fake-clickhouse";

const ch = fakeClickHouse();
const captured = ch.queries;

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

// The lazy loader a reader falls back to when the caller did not supply a
// definition: here it knows no tags, which is the deleted-tag case.
const loadVirtualTagDefinitions = vi.fn(async () => new Map());
vi.mock("../cost/virtual-tags", () => ({ loadVirtualTagDefinitions }));

const { queryCosts, getShowbackSpend, getVirtualTagStats, getPricingLines } =
  await import("../clickhouse/cost-readers");
const { buildCostExportQuery } = await import("../cost-exports/rows");
const { VirtualTagUnresolvedError } = await import("../clickhouse/virtual-tag-sql");

const env: CompiledVirtualTag = {
  key: "env",
  defaultValue: "unknown",
  split: false,
  rules: [
    {
      filters: [{ dimension: "provider", op: "in", values: ["aws"] }],
      startsOn: "2026-01-01",
      endsOn: null,
      kind: "tag",
      value: null,
      sources: [
        { tagKey: "env", valuePrefix: null, filters: [] },
        { tagKey: "Environment", valuePrefix: "az-", filters: [] },
      ],
      valueTransform: "lower",
      shares: [],
      metric: null,
    },
    {
      filters: [],
      startsOn: null,
      endsOn: null,
      kind: "value",
      value: "shared",
      sources: [],
      valueTransform: "none",
      shares: [],
      metric: null,
    },
  ],
};

const team: CompiledVirtualTag = {
  key: "team",
  defaultValue: null,
  split: true,
  rules: [
    {
      filters: [{ dimension: "service", op: "in", values: ["AmazonRDS"] }],
      startsOn: null,
      endsOn: null,
      kind: "split",
      value: null,
      sources: [],
      valueTransform: "none",
      shares: [
        { value: "payments", weight: 0.6 },
        { value: "search", weight: 0.4 },
      ],
      metric: null,
    },
    {
      filters: [],
      startsOn: null,
      endsOn: null,
      kind: "metric_split",
      value: null,
      sources: [],
      valueTransform: "none",
      shares: [],
      metric: {
        values: ["payments", "search"],
        days: ["2026-08-01", "2026-08-02"],
        weights: [
          [0.25, 0.75],
          [0.5, 0.5],
        ],
      },
    },
  ],
};

const defs = new Map([
  ["env", env],
  ["team", team],
]);

const baseQuery = {
  from: "2026-08-01",
  to: "2026-08-31",
  binning: "daily" as const,
  groupBy: "none" as const,
  filters: [],
};

beforeEach(() => ch.reset());

describe("queries without virtual tags", () => {
  it("emit no join and no weight", async () => {
    await queryCosts("org", { ...baseQuery, groupBy: "service" });
    expect(captured[0]).not.toContain("array join");
    expect(captured[0]).not.toContain("tupleElement");
  });
});

describe("scalar virtual tags", () => {
  it("group through a multiIf with ordered rules, time bounds, prefix and fold", async () => {
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "env",
      virtualTags: defs,
    });
    const sql = captured[0]!;
    expect(sql).not.toContain("array join");
    expect(sql).toContain("multiIf(");
    expect(sql).toContain("lower(`cost_daily`.`tags`['env'])");
    expect(sql).toContain("concat('az-', lower(`cost_daily`.`tags`['Environment']))");
    expect(sql).toContain("'shared'");
    expect(sql).toContain("'unknown'");
    // The first rule is ordered before the catch-all value rule.
    expect(sql.indexOf("'aws'")).toBeLessThan(sql.indexOf("'shared'"));
  });
});

describe("split virtual tags", () => {
  it("array-join the shares and weight the money", async () => {
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "team",
      filters: [{ dimension: "virtual_tag", op: "in", values: ["payments"], tagKey: "team" }],
      virtualTags: defs,
    });
    const sql = captured[0]!;
    expect(sql.match(/array join/g)).toHaveLength(1);
    expect(sql).toContain("AS Array(Tuple(String, Float64))");
    expect(sql).toContain("tupleElement(`vt_0`, 2)");
    expect(sql).toContain("toFloat64(0.6)");
    expect(sql).toContain("transform(toString(`cost_daily`.`day`)");
    // The filter reads the joined value, so it selects the payments share only.
    expect(sql).toMatch(/tupleElement\(`vt_0`, 1\) in \('payments'\)/);
  });

  it("weights raw and adjusted money alike when billing rules apply", async () => {
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "team",
      virtualTags: defs,
      adjustments: { factors: [], reallocations: [], fixed: [] },
    });
    const sql = captured[0]!;
    expect(sql).toMatch(
      /sum\(\(`cost_daily`\.`amount`\) \* tupleElement\(`vt_0`, 2\)\) as `raw_amount`/i,
    );
  });

  it("joins two split tags as two clauses", async () => {
    const other = { ...team, key: "owner" };
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "team",
      filters: [{ dimension: "virtual_tag", op: "in", values: ["x"], tagKey: "owner" }],
      virtualTags: new Map([...defs, ["owner", other]]),
    });
    expect(captured[0]!.match(/array join/g)).toHaveLength(2);
    expect(captured[0]).toContain("tupleElement(`vt_0`, 2) * tupleElement(`vt_1`, 2)");
  });
});

describe("other readers", () => {
  it("lets allocation rules match a virtual tag in showback", async () => {
    await getShowbackSpend(
      "org",
      [{ costCentreId: "cc-pay", match: { virtualTagKey: "team", virtualTagValue: "payments" } }],
      "2026-08-01",
      "2026-08-31",
      undefined,
      undefined,
      defs,
    );
    expect(captured[0]).toContain("array join");
    expect(captured[0]).toMatch(/tupleElement\(`vt_0`, 1\) = 'payments', 'cc-pay'/);
  });

  it("prices an invoice from the same weighted shares showback allocates", async () => {
    // Pricing lines resolve definitions themselves (no override): the loader.
    loadVirtualTagDefinitions.mockResolvedValueOnce(defs);
    await getPricingLines(
      "org",
      [{ costCentreId: "cc-pay", match: { virtualTagKey: "team", virtualTagValue: "payments" } }],
      "2026-08-01",
      "2026-08-31",
      { buckets: ["cc-pay"] },
    );
    expect(captured[0]).toContain("array join");
    expect(captured[0]).toMatch(/tupleElement\(`vt_0`, 1\) = 'payments', 'cc-pay'/);
    // Collected money, list price and usage are all weighted by the share.
    expect(captured[0]!.match(/tupleElement\(`vt_0`, 2\)/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("exports virtual tag columns with weighted measures", () => {
    const { sql, columns } = buildCostExportQuery({
      organizationId: "org",
      from: "2026-08-01",
      to: "2026-08-31",
      dimensions: ["service"],
      tagKeys: [],
      virtualTagKeys: ["team", "env"],
      filters: [{ dimension: "virtual_tag", op: "not_in", values: ["shared"], tagKey: "env" }],
      virtualTags: defs,
    });
    expect(columns.virtualTagColumns).toEqual(["vtag_team", "vtag_env"]);
    expect(sql).toContain("as `vtag_team`");
    expect(sql).toContain("array join");
    expect(sql).toMatch(/sum\(\(`cost_daily`\.`usage_amount`\) \* tupleElement\(`vt_0`, 2\)\)/);
  });

  it("evaluates per-rule spend for the processing pass", async () => {
    await getVirtualTagStats("org", team, "2026-08-01", "2026-08-31");
    expect(captured).toHaveLength(3);
    expect(captured[0]).toContain("toUInt16(1)");
    expect(captured[0]).toContain("array join");
    expect(captured[2]).toContain("uniqExact(");
  });
});

describe("unresolved keys", () => {
  it("throw rather than read unfiltered", async () => {
    await expect(
      queryCosts("org", {
        ...baseQuery,
        filters: [{ dimension: "virtual_tag", op: "in", values: ["x"], tagKey: "missing" }],
        virtualTags: new Map([["missing-not", env]]),
      }),
    ).rejects.toBeInstanceOf(VirtualTagUnresolvedError);
    expect(captured).toHaveLength(0);
  });
});
