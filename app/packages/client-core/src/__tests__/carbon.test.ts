import { describe, expect, it } from "vitest";

import {
  GRID_INTENSITY_G_PER_KWH,
  PROVIDER_PUE,
  gridIntensityFor,
  normalizeCarbonRegion,
} from "../carbon-factors";
import {
  CARBON_LIMITS,
  estimateCarbon,
  estimateResourceCarbon,
  formatCo2e,
  unestimatableReason,
  wattsPerVcpu,
  type CarbonInputResource,
} from "../carbon";

function resource(over: Partial<CarbonInputResource> = {}): CarbonInputResource {
  return {
    resourceId: "r1",
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    accountId: "a1",
    accountName: "prod",
    displayName: "api-1",
    region: "eu-west-1",
    vcpus: 4,
    ...over,
  };
}

describe("published coefficients", () => {
  it("are all in a physically plausible band", () => {
    // Every value is a reproduction of a third-party figure, and the unit
    // conversion (tons vs kilograms per kWh) is the easy thing to get wrong by
    // three orders of magnitude. No real grid is under 1 or over 1100 g/kWh.
    for (const [plugin, table] of Object.entries(GRID_INTENSITY_G_PER_KWH)) {
      for (const [region, value] of Object.entries(table)) {
        expect(value, `${plugin} ${region}`).toBeGreaterThan(1);
        expect(value, `${plugin} ${region}`).toBeLessThan(1100);
      }
    }
  });

  it("has a PUE above 1 for every supported provider", () => {
    // A PUE of 1.0 is a datacentre with no cooling or distribution losses,
    // which does not exist.
    for (const [plugin, pue] of Object.entries(PROVIDER_PUE)) {
      expect(pue, plugin).toBeGreaterThan(1);
      expect(pue, plugin).toBeLessThan(2);
    }
  });
});

describe("normalizeCarbonRegion", () => {
  it("folds Azure's display form onto the compact one", () => {
    // Azure reports both "East US" and "eastus" depending on the API.
    expect(normalizeCarbonRegion("azure", "East US")).toBe("eastus");
    expect(normalizeCarbonRegion("azure", "UK South")).toBe("uksouth");
  });

  it("leaves AWS and GCP regions alone apart from case", () => {
    expect(normalizeCarbonRegion("aws", "EU-West-1")).toBe("eu-west-1");
    expect(normalizeCarbonRegion("gcp", "us-central1")).toBe("us-central1");
  });
});

describe("gridIntensityFor", () => {
  it("finds a known region", () => {
    expect(gridIntensityFor("aws", "eu-west-1")).toBe(316);
    expect(gridIntensityFor("azure", "East US")).toBeCloseTo(415.8);
  });

  it("returns null rather than a default for anything it does not know", () => {
    // A carbon figure computed against a guessed grid is worse than no figure:
    // it is a number somebody will put in a report.
    expect(gridIntensityFor("aws", "mars-north-1")).toBeNull();
    expect(gridIntensityFor("hetzner", "fsn1")).toBeNull();
    expect(gridIntensityFor("aws", null)).toBeNull();
  });
});

describe("wattsPerVcpu", () => {
  it("interpolates between idle and full load", () => {
    const idle = wattsPerVcpu("aws", 0)!;
    const full = wattsPerVcpu("aws", 1)!;
    const half = wattsPerVcpu("aws", 0.5)!;
    expect(idle).toBeLessThan(half);
    expect(half).toBeLessThan(full);
    expect(half).toBeCloseTo((idle + full) / 2);
  });

  it("clamps a nonsense utilisation rather than extrapolating", () => {
    expect(wattsPerVcpu("aws", 5)).toBe(wattsPerVcpu("aws", 1));
    expect(wattsPerVcpu("aws", -1)).toBe(wattsPerVcpu("aws", 0));
  });

  it("is null for an unsupported provider", () => {
    expect(wattsPerVcpu("hetzner", 0.5)).toBeNull();
  });
});

describe("unestimatableReason", () => {
  it("blames the provider before the region", () => {
    // Checking region first would report every Fly machine as "unknown region"
    // and send somebody looking for a mapping that was never the problem.
    expect(unestimatableReason({ pluginId: "fly", region: "lhr", vcpus: 2 })).toBe(
      "unsupported-provider",
    );
  });

  it("names an unknown region and an unknown size", () => {
    expect(unestimatableReason({ pluginId: "aws", region: "mars-1", vcpus: 2 })).toBe(
      "unknown-region",
    );
    expect(unestimatableReason({ pluginId: "aws", region: "eu-west-1", vcpus: null })).toBe(
      "unknown-size",
    );
    expect(unestimatableReason({ pluginId: "aws", region: "eu-west-1", vcpus: 0 })).toBe(
      "unknown-size",
    );
  });

  it("is null for something estimable", () => {
    expect(unestimatableReason({ pluginId: "aws", region: "eu-west-1", vcpus: 4 })).toBeNull();
  });
});

describe("estimateResourceCarbon", () => {
  it("follows the operational formula", () => {
    const row = estimateResourceCarbon(resource(), { windowDays: 30, utilization: 0.5 })!;
    // 4 vCPU × 2.12 W × 720 h × 1.135 PUE ÷ 1000 = 6.93 kWh
    expect(row.kwh).toBeCloseTo(6.93, 1);
    // × 316 g/kWh ÷ 1000 = 2.19 kg
    expect(row.kgCo2e).toBeCloseTo(2.19, 1);
    expect(row.gridIntensity).toBe(316);
  });

  it("scales with the window and the size", () => {
    const month = estimateResourceCarbon(resource(), { windowDays: 30 })!;
    const year = estimateResourceCarbon(resource(), { windowDays: 360 })!;
    expect(year.kgCo2e / month.kgCo2e).toBeCloseTo(12, 5);
    const bigger = estimateResourceCarbon(resource({ vcpus: 8 }), { windowDays: 30 })!;
    expect(bigger.kgCo2e / month.kgCo2e).toBeCloseTo(2, 5);
  });

  it("puts a clean grid far below a dirty one", () => {
    const clean = estimateResourceCarbon(resource({ region: "eu-north-1" }), { windowDays: 30 })!;
    const dirty = estimateResourceCarbon(resource({ region: "af-south-1" }), { windowDays: 30 })!;
    expect(clean.kwh).toBeCloseTo(dirty.kwh, 5);
    expect(dirty.kgCo2e / clean.kgCo2e).toBeGreaterThan(100);
  });

  it("is null for anything it cannot place", () => {
    expect(estimateResourceCarbon(resource({ region: null }), { windowDays: 30 })).toBeNull();
  });
});

describe("estimateCarbon", () => {
  it("totals the estimable rows and names the rest", () => {
    const estimate = estimateCarbon(
      [
        resource({ resourceId: "ok-1" }),
        resource({ resourceId: "no-region", region: "mars-1" }),
        resource({ resourceId: "no-size", vcpus: null }),
        resource({ resourceId: "no-provider", pluginId: "hetzner" }),
      ],
      { windowDays: 30 },
    );
    expect(estimate.estimatedCount).toBe(1);
    expect(estimate.unestimated.map((row) => row.reason).sort()).toEqual([
      "unknown-region",
      "unknown-size",
      "unsupported-provider",
    ]);
    // The unestimable rows contribute nothing to the total.
    expect(estimate.totalKgCo2e).toBeCloseTo(estimate.rows[0]!.kgCo2e, 6);
  });

  it("groups by region and by account, heaviest first", () => {
    const estimate = estimateCarbon(
      [
        resource({
          resourceId: "a",
          region: "af-south-1",
          accountId: "acct-dirty",
          accountName: "dirty",
        }),
        resource({
          resourceId: "b",
          region: "eu-north-1",
          accountId: "acct-clean",
          accountName: "clean",
        }),
        resource({
          resourceId: "c",
          region: "eu-north-1",
          accountId: "acct-clean",
          accountName: "clean",
        }),
      ],
      { windowDays: 30 },
    );
    expect(estimate.byRegion[0]?.label).toContain("af-south-1");
    expect(estimate.byAccount[0]?.label).toBe("dirty");
    expect(estimate.byAccount.find((g) => g.label === "clean")?.resourceCount).toBe(2);
  });

  it("carries its assumptions on the response", () => {
    // The utilisation is the largest source of error; burying it in a constant
    // would make the number look more solid than it is.
    const estimate = estimateCarbon([resource()], { windowDays: 30 });
    expect(estimate.assumptions.cpuUtilization).toBe(0.5);
    expect(estimate.assumptions.pue["aws"]).toBe(PROVIDER_PUE["aws"]);
    expect(estimate.assumptions.coefficientSource).toContain("Cloud Carbon Footprint");
    expect(estimate.assumptions.scope).toContain("compute only");
  });

  it("only reports assumptions for providers that contributed", () => {
    const estimate = estimateCarbon([resource({ pluginId: "aws" })], { windowDays: 30 });
    expect(Object.keys(estimate.assumptions.pue)).toEqual(["aws"]);
  });

  it("clamps the window rather than rejecting it", () => {
    expect(estimateCarbon([], { windowDays: 100_000 }).windowDays).toBe(
      CARBON_LIMITS.maxWindowDays,
    );
    expect(estimateCarbon([], { windowDays: 0 }).windowDays).toBe(CARBON_LIMITS.minWindowDays);
  });

  it("is empty and honest with nothing to estimate", () => {
    const estimate = estimateCarbon([], {});
    expect(estimate).toMatchObject({
      totalKgCo2e: 0,
      estimatedCount: 0,
      rows: [],
      unestimated: [],
    });
  });
});

describe("formatCo2e", () => {
  it("reads as a mass a person can hold in their head", () => {
    expect(formatCo2e(0.4)).toBe("0.4 kg");
    expect(formatCo2e(12.4)).toBe("12 kg");
    expect(formatCo2e(1240)).toBe("1.2 t");
    expect(formatCo2e(Number.NaN)).toBe("—");
  });
});
