import { describe, expect, it } from "vitest";
import {
  chooseMigrationRegion,
  migrationRegionArea,
  migrationScenarioInput,
  migrationTargetRegions,
  pickMigrationSize,
  rankMigrationSizes,
  sizeMeetsSpec,
  summarizeMigrationTotals,
  type MigrationCost,
  type MigrationSizeOption,
} from "../migration-estimates";

const size = (
  id: string,
  vcpus: number,
  memoryGb: number,
  monthly: number | null,
  gpuCount: number | null = null,
): Omit<MigrationSizeOption, "meetsSpec"> => ({
  id,
  label: id,
  vcpus,
  memoryGb,
  gpuCount,
  gpuModel: null,
  monthly: monthly === null ? null : { amount: monthly, currency: "USD" },
});

const cost = (amount: number, currency = "USD"): MigrationCost => ({
  amount,
  currency,
  basis: "list-price",
  partial: false,
});

describe("migration matching", () => {
  it("meets a spec only at or above every known axis, and keeps CPU work off GPUs", () => {
    const spec = { vcpus: 4, memoryGb: 16, gpuCount: null };
    expect(sizeMeetsSpec(size("a", 4, 16, 1), spec)).toBe(true);
    expect(sizeMeetsSpec(size("b", 4, 15.9, 1), spec)).toBe(true);
    expect(sizeMeetsSpec(size("c", 2, 32, 1), spec)).toBe(false);
    expect(sizeMeetsSpec(size("d", 8, 32, 1, 1), spec)).toBe(false);
    expect(sizeMeetsSpec(size("e", 8, 32, 1, 1), { ...spec, gpuCount: 1 })).toBe(true);
  });

  it("ranks qualifying sizes first, cheapest first, unpriced last, and picks a priced one", () => {
    const ranked = rankMigrationSizes(
      [
        size("small", 2, 4, 5),
        size("big-unpriced", 8, 32, null),
        size("big", 8, 32, 60),
        size("medium", 4, 16, 30),
      ],
      { vcpus: 4, memoryGb: 16, gpuCount: null },
    );
    expect(ranked.map((r) => [r.id, r.meetsSpec])).toEqual([
      ["medium", true],
      ["big", true],
      ["big-unpriced", true],
      ["small", false],
    ]);
    expect(pickMigrationSize(ranked)?.id).toBe("medium");
  });

  it("matches nothing when the source size is unknown", () => {
    const ranked = rankMigrationSizes([size("a", 2, 4, 5)], {
      vcpus: null,
      memoryGb: null,
      gpuCount: null,
    });
    expect(ranked[0]!.meetsSpec).toBe(false);
    expect(pickMigrationSize(ranked)).toBeNull();
  });
});

describe("migration regions", () => {
  const regions = [
    { id: "us-east-1", label: "N. Virginia", area: "north-america" as const },
    { id: "eu-central-1", label: "Frankfurt", area: "europe" as const },
  ];

  it("reads areas from catalog regions, their zones, and the carbon sites", () => {
    expect(migrationRegionArea("aws", "eu-central-1", regions)).toBe("europe");
    expect(migrationRegionArea("aws", "eu-central-1a", regions)).toBe("europe");
    expect(migrationRegionArea("hetzner", "fsn1-dc14")).toBe("europe");
    expect(migrationRegionArea("digitalocean", "nyc3")).toBe("north-america");
    expect(migrationRegionArea("nowhere", "xyz")).toBeNull();
    expect(migrationRegionArea("aws", null, regions)).toBeNull();
  });

  it("lists target regions from the catalog, else from the carbon sites", () => {
    expect(migrationTargetRegions("aws", regions)).toHaveLength(2);
    expect(migrationTargetRegions("hetzner", null).find((r) => r.id === "fsn1")?.area).toBe(
      "europe",
    );
    expect(migrationTargetRegions("nowhere", null)).toEqual([]);
  });

  it("prefers the user's region, then the dominant source area, then the first", () => {
    expect(chooseMigrationRegion(regions, ["europe"], "us-east-1")).toMatchObject({
      region: { id: "us-east-1" },
      choice: "user",
    });
    expect(
      chooseMigrationRegion(regions, ["europe", "europe", "north-america"], null),
    ).toMatchObject({ region: { id: "eu-central-1" }, choice: "nearest" });
    expect(chooseMigrationRegion(regions, [null], null)).toMatchObject({
      region: { id: "us-east-1" },
      choice: "default",
    });
    expect(chooseMigrationRegion([], ["europe"], null)).toEqual({ region: null, choice: "none" });
  });
});

describe("migration totals", () => {
  const identity = (m: { amount: number; currency: string }) => m;

  it("counts unknowns, never adds zero, and states the change over paired rows only", () => {
    const totals = summarizeMigrationTotals(
      [
        { current: cost(100), target: { cost: cost(40) } },
        { current: cost(50), target: { cost: null } },
        { current: null, target: { cost: cost(10) } },
      ],
      [{ current: cost(7) }],
      identity,
    );
    expect(totals.current).toEqual([{ amount: 150, currency: "USD" }]);
    expect(totals.target).toEqual([{ amount: 50, currency: "USD" }]);
    expect(totals.currentUnknown).toBe(1);
    expect(totals.targetUnknown).toBe(1);
    expect(totals.unmatchedCurrent).toEqual([{ amount: 7, currency: "USD" }]);
    expect(totals.comparable).toEqual({
      currency: "USD",
      current: 150,
      target: 50,
      pairedDelta: -60,
      pairedRows: 1,
    });
  });

  it("gives no comparable figure across currencies without a rate", () => {
    const totals = summarizeMigrationTotals(
      [{ current: cost(100, "USD"), target: { cost: cost(30, "EUR") } }],
      [],
      identity,
    );
    expect(totals.comparable).toBeNull();
    expect(totals.target).toEqual([{ amount: 30, currency: "EUR" }]);
  });

  it("turns the paired change into a recurring monthly scenario", () => {
    const totals = summarizeMigrationTotals(
      [{ current: cost(100), target: { cost: cost(40) } }],
      [],
      identity,
    );
    const input = migrationScenarioInput(
      { name: "Checkout", target: { pluginId: "hetzner", pluginName: "Hetzner" }, totals },
      { startDate: "2027-03-01" },
    );
    expect(input).toMatchObject({
      name: "Checkout on Hetzner",
      currency: "USD",
      adjustments: [
        { kind: "recurring", period: "monthly", amountCents: -6000, startDate: "2027-03-01" },
      ],
    });
    expect(
      migrationScenarioInput(
        { name: "x", target: { pluginId: "h", pluginName: "H" }, totals },
        { startDate: "March" },
      ),
    ).toBeNull();
  });
});
