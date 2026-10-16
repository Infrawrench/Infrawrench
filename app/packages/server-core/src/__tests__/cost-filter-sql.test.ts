/**
 * Every cost filter operator, compiled through the real readers over the fake
 * driver (see `fake-clickhouse.ts`), so the assertions are about the SQL that
 * would be sent: the dialect's literal escaping included.
 *
 * The JS half of the semantics (`client-core/src/cost-filter-match.ts`) is
 * tested next to it; the pins here on `lower(…)` and `[[:space:]_-]` are the
 * other side of that agreement. Changing either normalisation without the
 * other fails one of the two suites.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostFilter } from "@infrawrench/client-core";
import type { CompiledVirtualTag } from "../clickhouse/virtual-tag-sql";
import { fakeClickHouse } from "./helpers/fake-clickhouse";

const ch = fakeClickHouse();
const captured = ch.queries;

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

const loadVirtualTagDefinitions = vi.fn(async () => new Map());
vi.mock("../cost/virtual-tags", () => ({ loadVirtualTagDefinitions }));

const { queryCosts } = await import("../clickhouse/cost-readers");
const { buildCostExportQuery } = await import("../cost-exports/rows");
const { runWithCostVisibility } = await import("../cost/visibility-context");

const baseQuery = {
  from: "2026-08-01",
  to: "2026-08-31",
  binning: "daily" as const,
  groupBy: "none" as const,
};

async function sqlFor(filters: CostFilter[]): Promise<string> {
  ch.reset();
  await queryCosts("org", { ...baseQuery, filters });
  return captured[0]!;
}

beforeEach(() => ch.reset());

describe("filter operators in SQL", () => {
  it("keeps in / not_in exactly as before", async () => {
    const sql = await sqlFor([
      { dimension: "provider", op: "in", values: ["aws"] },
      { dimension: "region", op: "not_in", values: ["us-east-1", "eu-west-1"] },
    ]);
    expect(sql).toContain("`cost_daily`.`plugin_id` in ('aws')");
    expect(sql).toContain("`cost_daily`.`region` not in ('us-east-1', 'eu-west-1')");
  });

  it("flexible_match normalises the column in SQL and the values in JS, identically", async () => {
    const sql = await sqlFor([
      { dimension: "tag", tagKey: "env", op: "flexible_match", values: ["Prod_Env", "prod-env"] },
    ]);
    expect(sql).toContain(
      "replaceRegexpAll(lower(`cost_daily`.`tags`['env']), '[[:space:]_-]', '') in ('prodenv')",
    );
  });

  it("contains / starts_with fold case on both sides and OR across values", async () => {
    const sql = await sqlFor([
      { dimension: "service", op: "contains", values: ["Compute", "STORAGE"] },
      { dimension: "resource", op: "starts_with", values: ["ARN:aws:rds"] },
    ]);
    expect(sql).toContain(
      "(position(lower(`cost_daily`.`service`), 'compute') > 0 OR " +
        "position(lower(`cost_daily`.`service`), 'storage') > 0)",
    );
    expect(sql).toContain("startsWith(lower(`cost_daily`.`resource_id`), 'arn:aws:rds')");
  });

  it("not_contains negates the whole disjunction", async () => {
    const sql = await sqlFor([
      { dimension: "service", op: "not_contains", values: ["support", "tax"] },
    ]);
    expect(sql).toContain(
      "NOT ((position(lower(`cost_daily`.`service`), 'support') > 0 OR " +
        "position(lower(`cost_daily`.`service`), 'tax') > 0))",
    );
  });

  it("is_set / is_not_set test the map lookup against the empty string", async () => {
    const sql = await sqlFor([
      { dimension: "tag", tagKey: "owner", op: "is_set", values: [] },
      { dimension: "tag", tagKey: "team", op: "is_not_set", values: [] },
    ]);
    expect(sql).toContain("`cost_daily`.`tags`['owner'] != ''");
    expect(sql).toContain("`cost_daily`.`tags`['team'] = ''");
  });

  it("escapes values as literals, never splicing them", async () => {
    const sql = await sqlFor([{ dimension: "service", op: "contains", values: ["x') OR 1=1 --"] }]);
    expect(sql).toContain("position(lower(`cost_daily`.`service`), 'x\\') or 1=1 --') > 0");
    expect(sql).not.toContain("'x') OR 1=1");
  });

  it("compiles the new operators on a virtual tag through its expression", async () => {
    const team: CompiledVirtualTag = {
      key: "team",
      defaultValue: null,
      split: false,
      rules: [
        {
          filters: [{ dimension: "provider", op: "in", values: ["aws"] }],
          startsOn: null,
          endsOn: null,
          kind: "value",
          value: "platform",
          sources: [],
          valueTransform: "none",
          shares: [],
          metric: null,
        },
      ],
    };
    ch.reset();
    await queryCosts("org", {
      ...baseQuery,
      filters: [{ dimension: "virtual_tag", tagKey: "team", op: "is_not_set", values: [] }],
      virtualTags: new Map([["team", team]]),
    });
    expect(captured[0]).toMatch(/multiIf\(.*'platform', ''\) = ''/);
  });

  it("reaches the export row builder too", () => {
    const { sql } = buildCostExportQuery({
      organizationId: "org",
      dimensions: ["service"],
      tagKeys: [],
      filters: [
        { dimension: "tag", tagKey: "env", op: "flexible_match", values: ["prod"] },
        { dimension: "tag", tagKey: "owner", op: "is_set", values: [] },
      ],
      from: "2026-08-01",
      to: "2026-08-02",
    });
    expect(sql).toContain("replaceRegexpAll(lower(");
    expect(sql).toContain("['owner'] != ''");
  });
});

describe("cost visibility scopes", () => {
  it("AND a scope's saved filter onto the query whatever its operators", async () => {
    await runWithCostVisibility(
      {
        organizationId: "org",
        restricted: true,
        userId: "user-1",
        layers: [
          {
            source: {
              kind: "member",
              label: null,
              costCentreIds: [],
              accountIds: [],
              savedFilterId: "f1",
            },
            accountIds: [],
            costCentreIds: [],
            rules: [],
            filters: [{ dimension: "service", op: "not_contains", values: ["support"] }],
            unresolvable: false,
          },
        ],
      },
      () =>
        queryCosts("org", {
          ...baseQuery,
          // The caller's own filter cannot widen the scope: both must hold.
          filters: [{ dimension: "service", op: "contains", values: ["support"] }],
        }),
    );
    const sql = captured[0]!;
    expect(sql).toContain("NOT (position(lower(`cost_daily`.`service`), 'support') > 0)");
    expect(sql).toContain("position(lower(`cost_daily`.`service`), 'support') > 0");
  });
});
