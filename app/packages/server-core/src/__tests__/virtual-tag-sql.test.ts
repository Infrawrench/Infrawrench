/**
 * Virtual tags compile into the reader's own statement. These tests assert on
 * the actual SQL the readers emit over a fake driver (see `fake-postgres.ts`),
 * with the parameters written back in (`inlineSql`); `pnpm test:postgres:shadow`
 * also prepares each statement against a real server.
 *
 * The properties that matter:
 *
 * 1. A query that mentions no virtual tag emits exactly the SQL it did before.
 * 2. A scalar tag is a `CASE` and needs no join.
 * 3. A split tag is a lateral join whose weight multiplies the money, raw and
 *    adjusted alike, so a split can never change a total.
 * 4. An unresolved key throws; it never degrades to unfiltered spend.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledVirtualTag } from "../analytics/virtual-tag-sql";
import { fakePostgres } from "./helpers/fake-postgres";
import { inlineSql } from "./helpers/inline-sql";

const pg = fakePostgres();
/** Every statement so far, parameters inlined. */
const captured = new Proxy([] as string[], {
  get: (_target, prop) => Reflect.get(pg.queries.map(inlineSql), prop),
});

vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

// The lazy loader a reader falls back to when the caller did not supply a
// definition: here it knows no tags, which is the deleted-tag case.
const loadVirtualTagDefinitions = vi.fn(async () => new Map());
vi.mock("../cost/virtual-tags", () => ({ loadVirtualTagDefinitions }));

const { queryCosts, getShowbackSpend, getVirtualTagStats, getPricingLines } =
  await import("../analytics/cost-readers");
const { buildCostExportQuery } = await import("../cost-exports/rows");
const { VirtualTagUnresolvedError } = await import("../analytics/virtual-tag-sql");

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

beforeEach(() => pg.reset());

const JOIN = /cross join lateral jsonb_to_recordset\(/g;

describe("queries without virtual tags", () => {
  it("emit no join and no weight", async () => {
    await queryCosts("org", { ...baseQuery, groupBy: "service" });
    expect(captured[0]).not.toMatch(JOIN);
    expect(captured[0]).not.toContain("vt_weight");
  });
});

describe("scalar virtual tags", () => {
  it("group through a CASE with ordered rules, time bounds, prefix and fold", async () => {
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "env",
      virtualTags: defs,
    });
    const sql = captured[0]!;
    const fold = (key: string) =>
      `translate(coalesce("cost_daily"."tags" ->> '${key}'::text, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
    expect(sql).not.toMatch(JOIN);
    expect(sql).toContain("(CASE WHEN ");
    expect(sql).toContain(fold("env"));
    expect(sql).toContain(`('az-'::text || ${fold("Environment")})`);
    expect(sql).toContain(`"cost_daily"."day" >= '2026-01-01'`);
    expect(sql).toContain("THEN 'shared'::text");
    expect(sql).toContain("ELSE 'unknown'::text END");
    // The first rule is ordered before the catch-all value rule.
    expect(sql.indexOf("'aws'")).toBeLessThan(sql.indexOf("'shared'"));
  });
});

describe("split virtual tags", () => {
  it("join the shares laterally and weight the money", async () => {
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "team",
      filters: [{ dimension: "virtual_tag", op: "in", values: ["payments"], tagKey: "team" }],
      virtualTags: defs,
    });
    const sql = captured[0]!;
    expect(sql.match(JOIN)).toHaveLength(1);
    expect(sql).toContain(`AS "vt_0"("vt_value" text, "vt_weight" float8)`);
    expect(sql).toContain(`sum(("cost_daily"."amount") * "vt_0"."vt_weight")`);
    expect(sql).toContain(
      "jsonb_build_object('vt_value', 'payments'::text, 'vt_weight', 0.6::float8)",
    );
    expect(sql).toContain(
      `(CASE "cost_daily"."day" WHEN '2026-08-01'::date THEN 0.25::float8 WHEN '2026-08-02'::date THEN 0.5::float8 ELSE 0.5::float8 END)`,
    );
    // The filter reads the joined value, so it selects the payments share only.
    expect(sql).toContain(`"vt_0"."vt_value" in ('payments')`);
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
    expect(sql).toContain(`sum(("cost_daily"."amount") * "vt_0"."vt_weight") as "raw_amount"`);
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
    expect(captured[0]!.match(JOIN)).toHaveLength(2);
    expect(captured[0]).toContain(`"vt_0"."vt_weight" * "vt_1"."vt_weight"`);
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
    expect(captured[0]).toMatch(JOIN);
    expect(captured[0]).toContain(
      `WHEN ("vt_0"."vt_value" = 'payments'::text) THEN 'cc-pay'::text`,
    );
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
    expect(captured[0]).toMatch(JOIN);
    expect(captured[0]).toContain(
      `WHEN ("vt_0"."vt_value" = 'payments'::text) THEN 'cc-pay'::text`,
    );
    // Collected money, list price and usage are all weighted by the share.
    expect(captured[0]!.match(/"vt_0"\."vt_weight"/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("exports virtual tag columns with weighted measures", () => {
    const built = buildCostExportQuery({
      organizationId: "org",
      from: "2026-08-01",
      to: "2026-08-31",
      dimensions: ["service"],
      tagKeys: [],
      virtualTagKeys: ["team", "env"],
      filters: [{ dimension: "virtual_tag", op: "not_in", values: ["shared"], tagKey: "env" }],
      virtualTags: defs,
    });
    const sql = inlineSql(built);
    expect(built.columns.virtualTagColumns).toEqual(["vtag_team", "vtag_env"]);
    expect(sql).toContain(`as "vtag_team"`);
    expect(sql).toMatch(JOIN);
    expect(sql).toContain(`sum(("cost_daily"."usage_amount") * "vt_0"."vt_weight")`);
  });

  it("evaluates per-rule spend for the processing pass", async () => {
    await getVirtualTagStats("org", team, "2026-08-01", "2026-08-31");
    expect(captured).toHaveLength(3);
    expect(captured[0]).toContain(" THEN 1 ");
    expect(captured[0]).toMatch(JOIN);
    expect(captured[2]).toContain("count(DISTINCT ");
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

describe("tags built on tags", () => {
  /** `owner`: payments on GCP. A scalar tag other tags can filter on. */
  const owner: CompiledVirtualTag = {
    ...env,
    key: "owner",
    defaultValue: null,
    rules: [
      {
        ...env.rules[1]!,
        filters: [{ dimension: "provider", op: "in", values: ["gcp"] }],
        value: "payments",
      },
    ],
  };
  /** `unit`: commerce when the owner is payments or search. */
  const unit = (dependencies?: Map<string, CompiledVirtualTag>): CompiledVirtualTag => ({
    key: "unit",
    defaultValue: "other",
    split: false,
    rules: [
      {
        ...env.rules[1]!,
        filters: [
          { dimension: "virtual_tag", op: "in", values: ["payments", "search"], tagKey: "owner" },
        ],
        value: "commerce",
      },
    ],
    dependencies,
  });

  it("nest the referenced tag's CASE inside the rule condition, with no join", async () => {
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "unit",
      virtualTags: new Map([["unit", unit(new Map([["owner", owner]]))]]),
    });
    const sql = captured[0]!;
    expect(sql).not.toMatch(JOIN);
    // The inner tag's expression is the subject of the outer rule's IN.
    expect(sql).toContain(
      `(CASE WHEN (CASE WHEN "cost_daily"."plugin_id" in ('gcp') THEN 'payments'::text ELSE ''::text END) in ('payments', 'search') THEN 'commerce'::text ELSE 'other'::text END)`,
    );
  });

  it("apply the new operators to a referenced tag", async () => {
    const owned: CompiledVirtualTag = {
      ...unit(new Map([["owner", owner]])),
      rules: [
        {
          ...env.rules[1]!,
          filters: [{ dimension: "virtual_tag", op: "is_set", values: [], tagKey: "owner" }],
          value: "owned",
        },
      ],
    };
    await queryCosts("org", {
      ...baseQuery,
      groupBy: "virtual_tag",
      groupByTagKey: "unit",
      virtualTags: new Map([["unit", owned]]),
    });
    expect(captured[0]).toContain(
      "THEN 'payments'::text ELSE ''::text END) != '' THEN 'owned'::text",
    );
  });

  it("throw for a reference that was not resolved, rather than matching nothing", async () => {
    await expect(
      queryCosts("org", {
        ...baseQuery,
        groupBy: "virtual_tag",
        groupByTagKey: "unit",
        virtualTags: new Map([["unit", unit()]]),
      }),
    ).rejects.toBeInstanceOf(VirtualTagUnresolvedError);
  });

  it("refuse to filter on a split tag even if a stored row says to", async () => {
    await expect(
      queryCosts("org", {
        ...baseQuery,
        groupBy: "virtual_tag",
        groupByTagKey: "unit",
        virtualTags: new Map([["unit", unit(new Map([["owner", { ...team, key: "owner" }]]))]]),
      }),
    ).rejects.toThrow(/splits rows between values/);
  });

  it("stop at a stored cycle instead of recursing forever", async () => {
    // owner filters on owner itself: a row the save check never lets through.
    const loop: CompiledVirtualTag = { ...owner, rules: unit().rules };
    loop.dependencies = new Map([["owner", loop]]);
    await expect(
      queryCosts("org", {
        ...baseQuery,
        groupBy: "virtual_tag",
        groupByTagKey: "unit",
        virtualTags: new Map([["unit", unit(new Map([["owner", loop]]))]]),
      }),
    ).rejects.toThrow(/nest deeper than/);
  });

  it("count per-rule spend through the nested expression in the processing pass", async () => {
    await getVirtualTagStats("org", unit(new Map([["owner", owner]])), "2026-08-01", "2026-08-31");
    expect(captured[0]).toContain("'gcp'");
    expect(captured[0]).toContain(" THEN 1 ");
  });
});
