import { describe, expect, it } from "vitest";
import type { CreateResourceConfig } from "@infrawrench/plugin-base";

import {
  CCF_GRID_G_PER_KWH,
  COLOCATION_PUE,
  PROVIDER_PUE,
  PROVIDER_REGION_ZONES,
  allGridFigures,
  gridIntensityFor,
  normalizeCarbonRegion,
  pueFor,
  resolveCarbonGrid,
} from "../carbon-factors";
import {
  CARBON_LIMITS,
  carbonSaving,
  createCarbonHint,
  effectiveCarbonDeclaration,
  estimateCarbon,
  estimateCreateFormCarbon,
  estimateFootprint,
  estimateResourceCarbon,
  formatCo2e,
  formatMonthlyCo2eDelta,
  parseCpuQuantity,
  readCarbonInputs,
  resourceCarbonEstimate,
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
    grid: "aws",
    region: "eu-west-1",
    vcpus: 4,
    ...over,
  };
}

describe("published coefficients", () => {
  it("are all in a physically plausible band", () => {
    // Every value is a reproduction of a third-party figure, and the unit
    // conversion (tons vs grams per kWh) is the easy thing to get wrong by
    // three orders of magnitude. No real grid is under 1 or over 1100 g/kWh.
    for (const figure of allGridFigures()) {
      expect(figure.gPerKwh, figure.zone).toBeGreaterThan(1);
      expect(figure.gPerKwh, figure.zone).toBeLessThan(1100);
    }
  });

  it("reproduces CCF's current figures rather than an older vintage", () => {
    // CCF reads us-east-1 as SERC (eGRID2023): 365.1 g/kWh.
    expect(CCF_GRID_G_PER_KWH.aws["us-east-1"]).toBeCloseTo(365.1, 1);
    expect(CCF_GRID_G_PER_KWH.aws["eu-north-1"]).toBe(8);
  });

  it("has a PUE above 1 for every supported provider", () => {
    // A PUE of 1.0 is a datacentre with no cooling or distribution losses,
    // which does not exist.
    for (const [plugin, pue] of Object.entries(PROVIDER_PUE)) {
      expect(pue, plugin).toBeGreaterThan(1);
      expect(pue, plugin).toBeLessThan(2);
    }
  });

  it("covers every provider with its own region table", () => {
    for (const grid of ["digitalocean", "hetzner", "fly", "scaleway", "ovh"]) {
      expect(Object.keys(PROVIDER_REGION_ZONES[grid] ?? {}).length, grid).toBeGreaterThan(3);
    }
  });
});

describe("normalizeCarbonRegion", () => {
  it("folds each provider's location spellings onto its table key", () => {
    // Azure reports both "East US" and "eastus" depending on the API.
    expect(normalizeCarbonRegion("azure", "East US")).toBe("eastus");
    expect(normalizeCarbonRegion("azure", "UK South")).toBe("uksouth");
    // A GCE instance syncs its zone, not its region.
    expect(normalizeCarbonRegion("gcp", "us-central1-a")).toBe("us-central1");
    expect(normalizeCarbonRegion("gcp", "europe-west10-b")).toBe("europe-west10");
    expect(normalizeCarbonRegion("aws", "us-east-1a")).toBe("us-east-1");
    expect(normalizeCarbonRegion("aws", "EU-West-1")).toBe("eu-west-1");
    expect(normalizeCarbonRegion("hetzner", "fsn1-dc14")).toBe("fsn1");
    expect(normalizeCarbonRegion("scaleway", "fr-par-2")).toBe("fr-par");
    expect(normalizeCarbonRegion("ovh", "GRA11")).toBe("gra");
    expect(normalizeCarbonRegion("ovh", "US-EAST-VA-1")).toBe("us-east-va");
  });
});

describe("gridIntensityFor", () => {
  it("finds a known region on every provider", () => {
    expect(gridIntensityFor("aws", "eu-west-1")).toBe(305);
    expect(gridIntensityFor("gcp", "us-central1-a")).toBe(gridIntensityFor("gcp", "us-central1"));
    expect(gridIntensityFor("hetzner", "fsn1")).toBeCloseTo(336.4);
    expect(gridIntensityFor("fly", "cdg")).toBeCloseTo(40.5);
    expect(gridIntensityFor("ovh", "GRA11")).toBeCloseTo(40.5);
    expect(gridIntensityFor("scaleway", "pl-waw-1")).toBeCloseTo(608.2);
    expect(gridIntensityFor("digitalocean", "nyc3")).toBeCloseTo(376.1);
  });

  it("reads a US site on the same grid as the hyperscaler beside it", () => {
    // A Hetzner server in Ashburn and an EC2 instance in us-east-1 sit on the
    // same SERC grid and must read the same figure.
    expect(gridIntensityFor("hetzner", "ash")).toBe(gridIntensityFor("aws", "us-east-1"));
  });

  it("fills Azure regions CCF lacks from Ember rather than an average", () => {
    expect(gridIntensityFor("azure", "polandcentral")).toBeCloseTo(608.2);
  });

  it("resolves 'auto' across the hyperscalers, prefixed or not", () => {
    expect(resolveCarbonGrid("auto", "us-east-1")?.grid).toBe("aws");
    expect(resolveCarbonGrid("auto", "europe-west4")?.grid).toBe("gcp");
    expect(resolveCarbonGrid("auto", "westeurope")?.grid).toBe("azure");
    expect(resolveCarbonGrid("auto", "aws-eu-central-1")?.grid).toBe("aws");
  });

  it("returns null rather than a default for anything it does not know", () => {
    // A carbon figure computed against a guessed grid is worse than no figure:
    // it is a number somebody will put in a report.
    expect(gridIntensityFor("aws", "mars-north-1")).toBeNull();
    expect(gridIntensityFor("vultr", "ewr")).toBeNull();
    // NYC2 is in Manhattan, whose grid CCF has no figure for.
    expect(gridIntensityFor("digitalocean", "nyc2")).toBeNull();
    expect(gridIntensityFor("aws", null)).toBeNull();
  });
});

describe("pueFor", () => {
  it("uses a regional figure where one is published", () => {
    expect(pueFor("scaleway", "fr-par-2")).toBe(1.16);
    expect(pueFor("gcp", "europe-west4-a")).toBe(1.07);
  });

  it("reads colocation sites at the industry average", () => {
    expect(pueFor("hetzner", "ash")).toBe(COLOCATION_PUE);
    expect(pueFor("hetzner", "fsn1")).toBe(1.13);
    expect(pueFor("fly", "iad")).toBe(COLOCATION_PUE);
  });
});

describe("wattsPerVcpu", () => {
  it("interpolates between idle and full load", () => {
    const idle = wattsPerVcpu("aws", 0);
    const full = wattsPerVcpu("aws", 1);
    const half = wattsPerVcpu("aws", 0.5);
    expect(idle).toBeLessThan(half);
    expect(half).toBeLessThan(full);
    expect(half).toBeCloseTo((idle + full) / 2);
  });

  it("clamps a nonsense utilisation rather than extrapolating", () => {
    expect(wattsPerVcpu("aws", 5)).toBe(wattsPerVcpu("aws", 1));
    expect(wattsPerVcpu("aws", -1)).toBe(wattsPerVcpu("aws", 0));
  });

  it("falls back to the AWS average for a provider CCF has no figure for", () => {
    // CCF's Alibaba precedent.
    expect(wattsPerVcpu("hetzner", 0.5)).toBe(wattsPerVcpu("aws", 0.5));
  });
});

describe("unestimatableReason", () => {
  it("blames the provider before the region", () => {
    expect(unestimatableReason({ grid: "vultr", region: "ewr", vcpus: 2 })).toBe(
      "unsupported-provider",
    );
  });

  it("names an unknown region and an unknown size", () => {
    expect(unestimatableReason({ grid: "aws", region: "mars-1", vcpus: 2 })).toBe("unknown-region");
    expect(unestimatableReason({ grid: "aws", region: "eu-west-1", vcpus: null })).toBe(
      "unknown-size",
    );
    expect(unestimatableReason({ grid: "aws", region: "eu-west-1", vcpus: 0 })).toBe(
      "unknown-size",
    );
  });

  it("is null for something estimable", () => {
    expect(unestimatableReason({ grid: "aws", region: "eu-west-1", vcpus: 4 })).toBeNull();
    expect(unestimatableReason({ grid: "auto", region: "us-east-1", vcpus: 4 })).toBeNull();
  });
});

describe("estimateFootprint", () => {
  it("follows the operational formula", () => {
    const row = estimateResourceCarbon(resource(), { windowDays: 30, utilization: 0.5 })!;
    // 4 vCPU × 2.12 W × 720 h × 1.135 PUE ÷ 1000 = 6.93 kWh
    expect(row.kwh).toBeCloseTo(6.93, 1);
    // × 305 g/kWh ÷ 1000 = 2.11 kg
    expect(row.kgCo2e).toBeCloseTo(2.11, 1);
    expect(row.gridIntensity).toBe(305);
    expect(row.gridBasis).toBe("ccf");
  });

  it("defaults to a 730-hour month and multiplies by the unit count", () => {
    const one = estimateFootprint({ grid: "aws", region: "eu-west-1", vcpus: 4 })!;
    const three = estimateFootprint({ grid: "aws", region: "eu-west-1", vcpus: 4, count: 3 })!;
    expect(three.kgCo2e / one.kgCo2e).toBeCloseTo(3, 6);
    const month = estimateFootprint(
      { grid: "aws", region: "eu-west-1", vcpus: 4 },
      { hours: 730 },
    )!;
    expect(month.kgCo2e).toBeCloseTo(one.kgCo2e, 9);
  });

  it("puts a clean grid far below a dirty one", () => {
    const clean = estimateResourceCarbon(resource({ region: "eu-north-1" }), { windowDays: 30 })!;
    const dirty = estimateResourceCarbon(resource({ region: "ap-south-1" }), { windowDays: 30 })!;
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
        resource({ resourceId: "ok-2", pluginId: "hetzner", grid: "hetzner", region: "fsn1" }),
        resource({ resourceId: "no-region", region: "mars-1" }),
        resource({ resourceId: "no-size", vcpus: null }),
        resource({ resourceId: "no-provider", pluginId: "vultr", grid: "vultr" }),
      ],
      { windowDays: 30 },
    );
    expect(estimate.estimatedCount).toBe(2);
    expect(estimate.unestimatedCount).toBe(3);
    expect(estimate.unestimated.map((row) => row.reason).sort()).toEqual([
      "unknown-region",
      "unknown-size",
      "unsupported-provider",
    ]);
    // The unestimable rows contribute nothing to the total.
    expect(estimate.totalKgCo2e).toBeCloseTo(
      estimate.rows.reduce((sum, row) => sum + row.kgCo2e, 0),
      6,
    );
    expect(estimate.byProvider.map((g) => g.key).sort()).toEqual(["aws", "hetzner"]);
  });

  it("groups by region and by account, heaviest first", () => {
    const estimate = estimateCarbon(
      [
        resource({
          resourceId: "a",
          region: "ap-south-1",
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
    expect(estimate.byRegion[0]?.label).toContain("ap-south-1");
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
    expect(estimate.assumptions.scope).toContain("not included");
  });

  it("only reports assumptions for grids that contributed", () => {
    const estimate = estimateCarbon([resource()], { windowDays: 30 });
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
      duplicateCount: 0,
    });
  });
});

describe("readCarbonInputs", () => {
  const noCatalogue = async () => null;

  it("reads a size through the create form's catalogue, with prefixes stripped", async () => {
    const inputs = await readCarbonInputs(
      {
        regionFieldKey: "region",
        vcpus: {
          from: "size",
          sizeFieldKey: "instanceClass",
          catalogueTypeId: "ec2-instance",
          catalogueFieldKey: "instanceType",
          stripPrefix: "db.",
        },
      },
      { instanceClass: "db.m5.large", region: "eu-west-1" },
      {
        pluginId: "aws",
        resourceTypeId: "rds-instance",
        loadCatalogue: async (typeId, fieldKey) => {
          expect([typeId, fieldKey]).toEqual(["ec2-instance", "instanceType"]);
          return [{ id: "m5.large", label: "m5.large", vcpus: 2 }];
        },
      },
    );
    expect(inputs).toMatchObject({ grid: "aws", region: "eu-west-1", vcpus: 2, count: 1 });
  });

  it("reads a Kubernetes CPU quantity and a node count", async () => {
    const inputs = await readCarbonInputs(
      {
        regionFieldKey: "region",
        grid: "auto",
        vcpus: { from: "field", fieldKey: "capacityCpu", format: "k8s-quantity" },
      },
      { capacityCpu: "3920m", region: "us-east-1" },
      { pluginId: "kubernetes", resourceTypeId: "k8s-node", loadCatalogue: noCatalogue },
    );
    expect(inputs.vcpus).toBeCloseTo(3.92);
    expect(inputs.grid).toBe("auto");
  });

  it("multiplies by a count field plus an offset", async () => {
    const inputs = await readCarbonInputs(
      {
        regionFieldKey: "region",
        vcpus: { from: "field", fieldKey: "vcpus" },
        countFieldKey: "numWorkers",
        countOffset: 1,
        role: "aggregate",
      },
      { vcpus: 4, numWorkers: "3", region: "eu-west-1" },
      { pluginId: "aws", resourceTypeId: "x", loadCatalogue: noCatalogue },
    );
    expect(inputs).toMatchObject({ vcpus: 4, count: 4, role: "aggregate" });
  });

  it("matches by label and takes the first of a list", async () => {
    const inputs = await readCarbonInputs(
      {
        regionFieldKey: "region",
        vcpus: { from: "size", sizeFieldKey: "flavorName", matchBy: "label", list: true },
      },
      { flavorName: "B2-7, b2-15", region: "GRA11" },
      {
        pluginId: "ovh",
        resourceTypeId: "instance",
        loadCatalogue: async () => [{ id: "uuid-1", label: "b2-7", vcpus: 2 }],
      },
    );
    expect(inputs.vcpus).toBe(2);
  });

  it("derives a declaration from right-sizing, and nothing from neither", () => {
    expect(
      effectiveCarbonDeclaration({
        rightsizing: { sizeFieldKey: "serverType", regionFieldKey: "location" },
      }),
    ).toEqual({ regionFieldKey: "location", vcpus: { from: "size", sizeFieldKey: "serverType" } });
    expect(effectiveCarbonDeclaration({})).toBeNull();
  });

  it("reports a type with no declaration as out of scope, not unestimated", () => {
    expect(resourceCarbonEstimate(null)).toMatchObject({ inScope: false, reason: null });
  });

  it("parses CPU quantities", () => {
    expect(parseCpuQuantity("4")).toBe(4);
    expect(parseCpuQuantity("500m")).toBe(0.5);
    expect(parseCpuQuantity("lots")).toBeNull();
  });
});

describe("the create form", () => {
  const config: CreateResourceConfig = {
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "region-picker",
        required: true,
        regions: [{ id: "fsn1", label: "fsn1" }],
      },
      {
        key: "serverType",
        label: "Type",
        kind: "size-picker",
        required: true,
        sizes: [
          { id: "cx22", label: "CX22", vcpus: 2, memoryMb: 4096 },
          { id: "cx42", label: "CX42", vcpus: 8, memoryMb: 16384 },
        ],
      },
    ],
    carbon: createCarbonHint("hetzner", {
      rightsizing: { sizeFieldKey: "serverType", regionFieldKey: "location" },
    })!,
  };

  it("estimates from the picked size and region with no request", () => {
    const small = estimateCreateFormCarbon(config, { location: "fsn1", serverType: "cx22" })!;
    const big = estimateCreateFormCarbon(config, { location: "fsn1", serverType: "cx42" })!;
    expect(small.grid).toBe("hetzner");
    expect(big.kgCo2e / small.kgCo2e).toBeCloseTo(4, 6);
  });

  it("is null until both are picked", () => {
    expect(estimateCreateFormCarbon(config, { serverType: "cx22" })).toBeNull();
    expect(estimateCreateFormCarbon(config, { location: "fsn1" })).toBeNull();
    expect(estimateCreateFormCarbon({ fields: config.fields }, { location: "fsn1" })).toBeNull();
  });
});

describe("carbonSaving", () => {
  it("is the difference between the two sizes in the same place", () => {
    const saving = carbonSaving({
      grid: "aws",
      region: "eu-west-1",
      currentVcpus: 8,
      recommendedVcpus: 2,
    })!;
    expect(saving.monthlyKgCo2eSaving / saving.currentMonthlyKgCo2e).toBeCloseTo(0.75, 6);
  });

  it("is null when the region cannot be placed", () => {
    expect(
      carbonSaving({ grid: "aws", region: "mars-1", currentVcpus: 8, recommendedVcpus: 2 }),
    ).toBeNull();
  });
});

describe("formatting", () => {
  it("reads as a mass a person can hold in their head", () => {
    expect(formatCo2e(0.4)).toBe("400 g");
    expect(formatCo2e(2.44)).toBe("2.4 kg");
    expect(formatCo2e(12.4)).toBe("12 kg");
    expect(formatCo2e(1240)).toBe("1.2 t");
    expect(formatCo2e(Number.NaN)).toBe("n/a");
  });

  it("signs a delta", () => {
    expect(formatMonthlyCo2eDelta(3.1)).toBe("+3.1 kg CO2e/mo");
    expect(formatMonthlyCo2eDelta(-3.1)).toBe("-3.1 kg CO2e/mo");
    expect(formatMonthlyCo2eDelta(0)).toBe("no change in CO2e");
  });
});
