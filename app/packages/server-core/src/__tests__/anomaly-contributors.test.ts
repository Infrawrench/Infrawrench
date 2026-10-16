/**
 * Anomaly root-cause attribution: the pure ranking against hand-built facet
 * rows, the naming step, and the one ClickHouse statement the decomposition
 * issues (rendered through the real dialect by the fake driver).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClickHouse } from "./helpers/fake-clickhouse";
import type { AnomalyContributorRow } from "../clickhouse/cost-readers";

const ch = fakeClickHouse();

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

// The naming step reads Postgres; these tests drive the pure halves and the
// SQL, so the module's db import only has to resolve.
vi.mock("../db/client", () => ({ db: {} }));

const { getAnomalyContributorRows } = await import("../clickhouse/cost-readers");
const { rankAnomalyContributors, toStoredContributors } =
  await import("../cost/anomaly-contributors");

const DAYS = 28;

/** A facet row whose baseline mean is `mean` (summed over the window, as the SQL returns it). */
function row(
  facet: string,
  key: string,
  actual: number,
  mean: number,
  accountId = "acc_a",
  pluginId = "aws",
): AnomalyContributorRow {
  return { facet, key, accountId, pluginId, actual, baselineTotal: mean * DAYS };
}

beforeEach(() => {
  ch.reset();
});

describe("rankAnomalyContributors", () => {
  // The day rose from a $100/day baseline to $600: a $500 rise.
  const total = row("total", "", 600, 100, "", "");

  it("ranks risers within a facet and states each as a share of the whole rise", () => {
    const ranked = rankAnomalyContributors(
      [
        total,
        row("resource", "i-small", 60, 10),
        row("resource", "i-big", 340, 20),
        row("resource", "i-flat", 30, 30),
      ],
      { baselineDays: DAYS },
    );
    expect(ranked.map((c) => [c.key, Math.round(c.delta), c.share])).toEqual([
      ["i-big", 320, 0.64],
      ["i-small", 50, 0.1],
    ]);
  });

  it("drops what fell, noise under the share floor, unattributed spend and empty tags", () => {
    const ranked = rankAnomalyContributors(
      [
        total,
        row("resource", "", 400, 0), // the provider reported no resource id
        row("resource", "i-noise", 11, 1), // 2% of the rise
        row("region", "us-east-1", 50, 80), // fell
        row("tag:team", "", 300, 0),
        row("account", "acc_a", 600, 100),
      ],
      { baselineDays: DAYS },
    );
    expect(ranked.map((c) => [c.facet, c.key])).toEqual([["account", "acc_a"]]);
  });

  it("keeps a few per facet, in facet order, and one value per tag key", () => {
    const ranked = rankAnomalyContributors(
      [
        total,
        row("tag:team", "data", 300, 0),
        row("tag:team", "web", 200, 0),
        row("tag:env", "prod", 450, 0),
        row("region", "us-east-1", 500, 50),
        row("resource", "a", 200, 0),
        row("resource", "b", 150, 0),
        row("resource", "c", 100, 0),
        row("resource", "d", 50, 0),
      ],
      { baselineDays: DAYS },
    );
    expect(ranked.map((c) => [c.facet, c.tagKey, c.key])).toEqual([
      ["resource", null, "a"],
      ["resource", null, "b"],
      ["resource", null, "c"],
      ["region", null, "us-east-1"],
      ["tag", "env", "prod"],
      ["tag", "team", "data"],
    ]);
  });

  it("has no share to state when the scope did not rise as a whole", () => {
    const ranked = rankAnomalyContributors(
      [row("total", "", 90, 100), row("resource", "i-1", 50, 0)],
      { baselineDays: DAYS },
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.share).toBeNull();
  });

  it("treats a value spanning accounts as belonging to none", () => {
    const [c] = rankAnomalyContributors([total, row("region", "eu-west-1", 400, 0, "", "aws")], {
      baselineDays: DAYS,
    });
    expect(c!.accountId).toBeNull();
    expect(c!.pluginId).toBe("aws");
  });
});

describe("toStoredContributors", () => {
  it("names synced resources and accounts and converts to cents", () => {
    const ranked = rankAnomalyContributors(
      [
        row("total", "", 600, 100, "", ""),
        row("resource", "i-big", 340, 20, "acc_a"),
        row("resource", "i-unsynced", 140, 0, "acc_a"),
        row("account", "acc_a", 600, 100, "acc_a"),
        row("region", "", 200, 0, "acc_a"),
      ],
      { baselineDays: DAYS },
    );
    const stored = toStoredContributors(ranked, {
      accountNames: new Map([["acc_a", "Production"]]),
      resourcesByKey: new Map([
        [
          "acc_a i-big",
          {
            id: "res_1",
            accountId: "acc_a",
            pluginId: "aws",
            resourceTypeId: "ec2-instance",
            name: "web-1",
          },
        ],
      ]),
    });
    expect(stored.map((c) => [c.facet, c.label, c.resource?.id ?? null])).toEqual([
      ["resource", "web-1", "res_1"],
      ["resource", "i-unsynced", null],
      ["account", "Production", null],
      ["region", "(no region)", null],
    ]);
    expect(stored[0]).toMatchObject({
      key: "i-big",
      actualCents: 34_000,
      baselineCents: 2_000,
      deltaCents: 32_000,
      share: 0.64,
    });
  });
});

describe("getAnomalyContributorRows", () => {
  const q = {
    day: "2026-10-14",
    baselineFrom: "2026-09-16",
    baselineDays: 28,
    dimension: "service" as const,
    dimensionKey: "Amazon EC2",
    currency: "USD",
    perFacet: 4,
    maxRows: 400,
  };

  it("decomposes every facet in one statement over the scope and window", async () => {
    ch.setRows([
      {
        facet: "total",
        key: "",
        single_account: "",
        single_plugin: "aws",
        actual: 600,
        baseline_total: 2800,
      },
      {
        facet: "resource",
        key: "i-1",
        single_account: "acc_a",
        single_plugin: "aws",
        actual: 340,
        baseline_total: 560,
      },
    ]);
    const rows = await getAnomalyContributorRows("org_1", q);
    expect(ch.queries).toHaveLength(1);
    const sql = ch.lastQuery();
    expect(sql).toContain("from `cost_daily` final array join arrayConcat(");
    expect(sql).toContain("mapKeys(`cost_daily`.`tags`)");
    expect(sql).toContain("`cost_daily`.`service` = 'Amazon EC2'");
    expect(sql).toContain("`cost_daily`.`currency` = 'USD'");
    expect(sql).toMatch(/LIMIT 4 BY facet/i);
    expect(sql).toMatch(/LIMIT 400/i);
    // Scoped through the one org predicate every cost read uses.
    expect(sql).toContain("`cost_daily`.`organization_id` = 'org_1'");
    expect(rows[1]).toEqual({
      facet: "resource",
      key: "i-1",
      accountId: "acc_a",
      pluginId: "aws",
      actual: 340,
      baselineTotal: 560,
    });
  });

  it("filters a provider anomaly by plugin", async () => {
    await getAnomalyContributorRows("org_1", { ...q, dimension: "provider", dimensionKey: "gcp" });
    expect(ch.lastQuery()).toContain("`cost_daily`.`plugin_id` = 'gcp'");
  });
});
