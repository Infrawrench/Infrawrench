import { describe, expect, it, vi } from "vitest";

// The alert module reaches the database and alert routing; the pure halves
// under test never call them.
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../alerts/route", () => ({ routeAlert: vi.fn() }));
vi.mock("../plugin-loader", () => ({ loadPlugins: vi.fn(async () => []) }));

import {
  lookbackStart,
  matchPriceMoves,
  moveMatchesSelection,
  parsePriceMove,
  usageByPlatform,
  type PriceMove,
  type UsageEntry,
} from "../price-changes/match";
import { catalogPriceMovesSql, orgPriceMovesSql } from "../price-changes/sql";
import { shouldAlertPriceChange } from "../price-changes/alerts";
import { priceChangesSegments } from "../digest/compose";

const AT = new Date("2026-11-01T00:00:00Z");

function move(overrides: Partial<PriceMove> = {}): PriceMove {
  return {
    instanceType: "m5.large",
    region: "us-east-1",
    dimensions: {
      operating_system: "Linux",
      tenancy: "Shared",
      pre_installed_sw: "NA",
      capacity_status: "Used",
      license_model: "No License required",
      database_engine: "",
    },
    variant: {},
    oldUsd: 0.096,
    newUsd: 0.105,
    effectiveAt: AT,
    ...overrides,
  };
}

function entry(overrides: Partial<UsageEntry> = {}, units = 1): UsageEntry {
  return {
    resourceId: "r1",
    pluginId: "aws",
    accountId: "acct-1",
    usage: {
      platform: "ec2",
      instanceType: "m5.large",
      region: "us-east-1",
      selection: { operating_system: "Linux", tenancy: "Shared" },
      units,
    },
    ...overrides,
  };
}

describe("parsePriceMove", () => {
  it("reads a warehouse row, its dimensions and its variant map", () => {
    const parsed = parsePriceMove({
      instance_type: "Standard_D2s_v5",
      region: "eastus",
      operating_system: "Linux",
      variant: { priority: "Regular" } as never,
      old_usd: 0.096,
      new_usd: "0.1",
      effective_at: AT.getTime() / 1000,
    });
    expect(parsed).toMatchObject({
      instanceType: "Standard_D2s_v5",
      region: "eastus",
      variant: { priority: "Regular" },
      oldUsd: 0.096,
      newUsd: 0.1,
      effectiveAt: AT,
    });
    expect(parsed?.dimensions["operating_system"]).toBe("Linux");
    expect(parsed?.dimensions["tenancy"]).toBe("");
  });

  it("drops a row without both prices", () => {
    expect(parsePriceMove({ old_usd: 0, new_usd: 1, effective_at: 1 })).toBeNull();
    expect(parsePriceMove({ old_usd: 1, new_usd: null, effective_at: 1 })).toBeNull();
  });
});

describe("moveMatchesSelection", () => {
  it("matches equal values and dimensions the row leaves unset", () => {
    expect(moveMatchesSelection(move(), { operating_system: "Linux" })).toBe(true);
    expect(moveMatchesSelection(move(), { database_engine: "PostgreSQL" })).toBe(true);
    expect(moveMatchesSelection(move(), { operating_system: "Windows" })).toBe(false);
  });

  it("reads variant.<key> from the variant map and ignores unknown keys", () => {
    const azure = move({ variant: { priority: "Spot" } });
    expect(moveMatchesSelection(azure, { "variant.priority": "Regular" })).toBe(false);
    expect(moveMatchesSelection(azure, { "variant.priority": "Spot" })).toBe(true);
    expect(moveMatchesSelection(azure, { not_a_column: "x" })).toBe(true);
  });
});

describe("matchPriceMoves", () => {
  it("folds several resources on one type into one change with summed units", () => {
    const changes = matchPriceMoves(
      [move()],
      [entry({ resourceId: "r1" }, 1), entry({ resourceId: "r2", accountId: "acct-2" }, 5)],
    );
    expect(changes).toHaveLength(1);
    const [c] = changes;
    expect(c?.units).toBe(6);
    expect(c?.resources.map((r) => r.resourceId)).toEqual(["r1", "r2"]);
    // (0.105 - 0.096) x 730 x 6
    expect(c?.monthlyImpactUsd).toBeCloseTo(39.42, 2);
  });

  it("keeps different variants and different instants apart", () => {
    const windows = entry({
      resourceId: "w1",
      usage: {
        platform: "ec2",
        instanceType: "m5.large",
        region: "us-east-1",
        selection: { operating_system: "Windows" },
        units: 1,
      },
    });
    const later = move({
      effectiveAt: new Date("2026-11-08T00:00:00Z"),
      oldUsd: 0.105,
      newUsd: 0.11,
    });
    const changes = matchPriceMoves(
      [
        move(),
        later,
        move({ dimensions: { operating_system: "Windows" }, oldUsd: 0.188, newUsd: 0.2 }),
      ],
      [entry(), windows],
    );
    expect(changes.map((c) => [c.selection["operating_system"], c.oldHourlyUsd])).toEqual([
      ["Linux", 0.096],
      ["Linux", 0.105],
      ["Windows", 0.188],
    ]);
  });

  it("takes the cheapest product when the selection leaves several matching", () => {
    const changes = matchPriceMoves(
      [move({ newUsd: 0.2 }), move({ newUsd: 0.105, dimensions: { tenancy: "" } })],
      [entry()],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.newHourlyUsd).toBe(0.105);
  });

  it("ignores moves in other regions or of other types", () => {
    expect(
      matchPriceMoves(
        [move({ region: "eu-west-1" }), move({ instanceType: "m5.xlarge" })],
        [entry()],
      ),
    ).toEqual([]);
  });
});

describe("usageByPlatform and the SQL", () => {
  it("groups types and regions per platform", () => {
    const grouped = usageByPlatform([entry(), entry({ resourceId: "r2" })]);
    expect([...grouped.keys()]).toEqual(["ec2"]);
    expect([...grouped.get("ec2")!.types]).toEqual(["m5.large"]);
  });

  it("reads on-demand list prices of only the named types and regions, adjacent periods only", () => {
    const sql = orgPriceMovesSql("ec2", ["m5.large", "c'q"], ["us-east-1"], lookbackStart(AT));
    expect(sql).toContain("platform = 'ec2'");
    expect(sql).toContain("pricing = 'on_demand'");
    expect(sql).toContain("instance_type IN ('m5.large', 'c\\'q')");
    expect(sql).toContain("n.valid_from = o.valid_to");
    expect(sql).toContain("usage_type NOT LIKE '%Unused%'");
    expect(sql.length).toBeLessThan(20_000);
  });

  it("limits the catalog list and keeps the headline variant", () => {
    const sql = catalogPriceMovesSql("rds", AT, 1001);
    expect(sql).toContain("LIMIT 1001");
    expect(sql).toContain("operating_system IN ('', 'Linux')");
  });
});

describe("shouldAlertPriceChange", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  const settings = { minMonthlyImpactCents: 1000, minPercent: 1 };
  const row = {
    alertedAt: null,
    effectiveAt: AT,
    oldHourlyUsd: 0.096,
    newHourlyUsd: 0.105,
    monthlyImpactUsd: 39.42,
  };

  it("alerts a fresh change over both thresholds, once", () => {
    expect(shouldAlertPriceChange(row, settings, now)).toBe(true);
    expect(shouldAlertPriceChange({ ...row, alertedAt: now }, settings, now)).toBe(false);
  });

  it("does not alert a change that is old news", () => {
    const later = new Date("2026-11-20T00:00:00Z");
    expect(shouldAlertPriceChange(row, settings, later)).toBe(false);
  });

  it("alerts an upcoming change", () => {
    expect(
      shouldAlertPriceChange(
        { ...row, effectiveAt: new Date("2027-01-01T00:00:00Z") },
        settings,
        now,
      ),
    ).toBe(true);
  });

  it("needs both the amount and the percentage", () => {
    expect(shouldAlertPriceChange({ ...row, monthlyImpactUsd: 5 }, settings, now)).toBe(false);
    expect(shouldAlertPriceChange(row, { minMonthlyImpactCents: 1000, minPercent: 20 }, now)).toBe(
      false,
    );
    // A cut counts by its size.
    expect(
      shouldAlertPriceChange(
        { ...row, oldHourlyUsd: 0.105, newHourlyUsd: 0.096, monthlyImpactUsd: -39.42 },
        settings,
        now,
      ),
    ).toBe(true);
  });
});

describe("priceChangesSegments", () => {
  it("says how many moved, which way, the net month and the largest", () => {
    const line = priceChangesSegments({
      count: 3,
      increases: 2,
      decreases: 1,
      netMonthlyUsd: 120.4,
      largest: "m5.large in us-east-1 (Amazon EC2) went from $0.096/hr to $0.105/hr",
    });
    expect(line?.map((s) => s.text).join("")).toBe(
      "Price changes: 3 list prices changed on what you run (2 up, 1 down), +$120.40/mo net at list price. Largest: m5.large in us-east-1 (Amazon EC2) went from $0.096/hr to $0.105/hr",
    );
  });

  it("is left out when nothing changed", () => {
    expect(priceChangesSegments(null)).toBeNull();
  });
});
