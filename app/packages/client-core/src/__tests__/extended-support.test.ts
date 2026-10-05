import { describe, expect, it } from "vitest";

import {
  alertableExtendedSupport,
  applyExtendedSupportBilling,
  computeExtendedSupport,
  extendedSupportExpiryItems,
  extendedSupportIssueSourceId,
  extendedSupportVersionMatches,
  matchExtendedSupportRelease,
  type ExtendedSupportDeclaration,
  type ExtendedSupportScanInput,
} from "../extended-support";
import { computeExpiryFeed, expirySeverity } from "../expiry";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

/** EKS-shaped: per-cluster charge, enrolled unless the policy is STANDARD. */
const EKS: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  regionFieldKey: "region",
  chargedWhen: [{ fieldKey: "supportType", notIn: ["STANDARD"] }],
  notChargedNote: "Upgraded instead.",
  releases: [
    {
      id: "k8s-1.30",
      product: "Amazon EKS",
      versions: ["1.30"],
      standardSupportEnds: "2025-07-22",
      extendedSupportEnds: "2026-07-22",
      targetVersion: "1.35",
      surcharge: {
        unit: "cluster-hour",
        currency: "USD",
        tiers: [{ from: "2025-07-23", rate: 0.5, label: "$0.50" }],
        pricingUrl: "https://example.com/p",
      },
      upgradeUrl: "https://example.com/u",
    },
    {
      id: "k8s-1.32",
      product: "Amazon EKS",
      versions: ["1.32"],
      standardSupportEnds: "2026-03-22",
      extendedSupportEnds: "2027-03-22",
      targetVersion: "1.35",
      surcharge: {
        unit: "cluster-hour",
        currency: "USD",
        tiers: [{ from: "2026-03-23", rate: 0.5, label: "$0.50" }],
        pricingUrl: "https://example.com/p",
      },
      upgradeUrl: "https://example.com/u",
    },
    {
      id: "k8s-1.34",
      product: "Amazon EKS",
      versions: ["1.34"],
      standardSupportEnds: "2026-12-01",
      extendedSupportEnds: "2027-12-01",
      targetVersion: "1.35",
      surcharge: {
        unit: "cluster-hour",
        currency: "USD",
        tiers: [{ from: "2026-12-02", rate: 0.5, label: "$0.50" }],
        pricingUrl: "https://example.com/p",
      },
      upgradeUrl: "https://example.com/u",
    },
  ],
};

/** RDS-shaped: per-vCPU, engine-scoped, two tiers. */
const RDS: ExtendedSupportDeclaration = {
  versionFieldKey: "engineVersion",
  engineFieldKey: "engine",
  quantityFieldKey: "vcpus",
  regionFieldKey: "region",
  releases: [
    {
      id: "mysql-5.7",
      product: "RDS for MySQL",
      engines: ["mysql"],
      versions: ["5.7"],
      standardSupportEnds: "2024-02-29",
      extendedSupportEnds: "2029-06-30",
      targetVersion: "MySQL 8.4",
      surcharge: {
        unit: "vcpu-hour",
        currency: "USD",
        tiers: [
          { from: "2024-03-01", rate: 0.1, label: "Years 1-2" },
          { from: "2026-03-01", rate: 0.2, label: "Year 3" },
        ],
        pricingUrl: "https://example.com/p",
      },
      upgradeUrl: "https://example.com/u",
    },
    {
      id: "postgres-13",
      product: "RDS for PostgreSQL",
      engines: ["postgres"],
      versions: ["13"],
      standardSupportEnds: "2026-02-28",
      extendedSupportEnds: "2029-02-28",
      targetVersion: "PostgreSQL 17",
      surcharge: {
        unit: "vcpu-hour",
        currency: "USD",
        tiers: [
          { from: "2026-03-01", rate: 0.1, label: "Years 1-2" },
          { from: "2028-03-01", rate: 0.2, label: "Year 3" },
        ],
        pricingUrl: "https://example.com/p",
      },
      upgradeUrl: "https://example.com/u",
    },
  ],
};

interface Row {
  id: string;
  typeId: "eks" | "rds";
  fields: Record<string, unknown>;
  accountId?: string;
}

function scan(rows: Row[]): ExtendedSupportScanInput {
  return {
    plugins: [
      {
        id: "aws",
        displayName: "AWS",
        resourceTypes: [
          { id: "eks", displayName: "EKS Cluster", extendedSupport: EKS },
          { id: "rds", displayName: "RDS Instance", extendedSupport: RDS },
          { id: "s3", displayName: "Bucket" },
        ],
      },
    ],
    accounts: [
      { id: "acc", displayName: "Prod", pluginId: "aws" },
      { id: "acc2", displayName: "Staging", pluginId: "aws" },
    ],
    resources: rows.map((r) => ({
      id: r.id,
      pluginId: "aws",
      resourceTypeId: r.typeId,
      accountId: r.accountId ?? "acc",
      displayName: r.id,
      externalId: r.id,
      fields: r.fields,
    })),
  };
}

describe("extendedSupportVersionMatches", () => {
  it("matches at a boundary and ignores a leading v", () => {
    expect(extendedSupportVersionMatches("1.29", "1.29")).toBe(true);
    expect(extendedSupportVersionMatches("1.29.4", "1.29")).toBe(true);
    expect(extendedSupportVersionMatches("v1.29.4-eks-1234", "1.29")).toBe(true);
    expect(extendedSupportVersionMatches("5.7.mysql_aurora.2.11.2", "5.7")).toBe(true);
    expect(extendedSupportVersionMatches("POSTGRES_12", "postgres_12")).toBe(true);
    expect(extendedSupportVersionMatches("MYSQL_8_0_31", "MYSQL_8_0")).toBe(true);
  });

  it("never matches a longer number", () => {
    expect(extendedSupportVersionMatches("1.290", "1.29")).toBe(false);
    expect(extendedSupportVersionMatches("120", "12")).toBe(false);
    expect(extendedSupportVersionMatches("POSTGRES_120", "POSTGRES_12")).toBe(false);
    expect(extendedSupportVersionMatches("1.2", "1.29")).toBe(false);
  });
});

describe("matchExtendedSupportRelease", () => {
  it("requires the engine for engine-scoped releases", () => {
    expect(matchExtendedSupportRelease(RDS, { engineVersion: "5.7.44" })).toBeNull();
    expect(matchExtendedSupportRelease(RDS, { engine: "postgres", engineVersion: "5.7" })).toBe(
      null,
    );
    expect(matchExtendedSupportRelease(RDS, { engine: "MySQL", engineVersion: "5.7.44" })?.id).toBe(
      "mysql-5.7",
    );
  });
});

describe("computeExtendedSupport", () => {
  it("prices a surcharged cluster at list price per month", () => {
    const res = computeExtendedSupport(
      scan([{ id: "c1", typeId: "eks", fields: { version: "1.32", region: "us-east-1" } }]),
      { now: NOW },
    );
    expect(res.findings).toHaveLength(1);
    const f = res.findings[0]!;
    expect(f.status).toBe("surcharged");
    expect(f.charged).toBe(true);
    expect(f.monthlySurcharge).toBe(365);
    expect(f.costBasis).toBe("list-price");
    expect(f.surchargeStartsOn).toBe("2026-03-23");
    expect(f.daysUntilSurcharge).toBeLessThan(0);
    expect(f.extendedSupportEnds).toBe("2027-03-22");
    expect(res.currentMonthly).toEqual([{ currency: "USD", monthly: 365 }]);
  });

  it("reports an opted-out cluster as unsupported with no figure", () => {
    const res = computeExtendedSupport(
      scan([{ id: "c1", typeId: "eks", fields: { version: "1.32", supportType: "STANDARD" } }]),
      { now: NOW },
    );
    const f = res.findings[0]!;
    expect(f.status).toBe("unsupported");
    expect(f.charged).toBe(false);
    expect(f.monthlySurcharge).toBeNull();
    expect(f.costBasis).toBe("unpriced");
    expect(f.note).toBe("Upgraded instead.");
    expect(res.currentMonthly).toEqual([]);
  });

  it("treats an absent policy field as enrolled (notIn passes on absence)", () => {
    const res = computeExtendedSupport(
      scan([{ id: "c1", typeId: "eks", fields: { version: "1.32" } }]),
      {
        now: NOW,
      },
    );
    expect(res.findings[0]!.charged).toBe(true);
  });

  it("marks a version past extended support as end-of-life", () => {
    const res = computeExtendedSupport(
      scan([{ id: "c1", typeId: "eks", fields: { version: "1.30.9" } }]),
      {
        now: NOW,
      },
    );
    expect(res.findings[0]!.status).toBe("end-of-life");
    expect(res.findings[0]!.daysUntilForcedUpgrade).toBeLessThan(0);
  });

  it("lists upcoming surcharges only inside the lead time, priced at the first tier", () => {
    const rows: Row[] = [{ id: "c1", typeId: "eks", fields: { version: "1.34" } }];
    expect(computeExtendedSupport(scan(rows), { now: NOW, leadDays: 30 }).findings).toEqual([]);
    const res = computeExtendedSupport(scan(rows), { now: NOW, leadDays: 90 });
    const f = res.findings[0]!;
    expect(f.status).toBe("upcoming");
    expect(f.monthlySurcharge).toBe(365);
    expect(res.upcomingMonthly).toEqual([{ currency: "USD", monthly: 365 }]);
    expect(res.currentMonthly).toEqual([]);
    expect(alertableExtendedSupport(res)).toEqual([]);
  });

  it("uses the tier in force and shows the next one", () => {
    const res = computeExtendedSupport(
      scan([
        {
          id: "old",
          typeId: "rds",
          fields: { engine: "mysql", engineVersion: "5.7.44", vcpus: 4 },
        },
        {
          id: "pg",
          typeId: "rds",
          fields: { engine: "postgres", engineVersion: "13.15", vcpus: 2 },
        },
      ]),
      { now: NOW },
    );
    const old = res.findings.find((f) => f.resourceId === "old")!;
    expect(old.tierLabel).toBe("Year 3");
    expect(old.monthlySurcharge).toBe(584); // 0.2 * 4 * 730
    expect(old.nextTier).toBeNull();
    const pg = res.findings.find((f) => f.resourceId === "pg")!;
    expect(pg.monthlySurcharge).toBe(146); // 0.1 * 2 * 730
    expect(pg.nextTier).toEqual({ from: "2028-03-01", label: "Year 3", monthlySurcharge: 292 });
    // Largest surcharge first within a status.
    expect(res.findings.map((f) => f.resourceId)).toEqual(["old", "pg"]);
  });

  it("leaves the figure empty when the size is unknown, never zero", () => {
    const res = computeExtendedSupport(
      scan([
        { id: "srv", typeId: "rds", fields: { engine: "mysql", engineVersion: "5.7", vcpus: 0 } },
      ]),
      { now: NOW },
    );
    expect(res.findings[0]!.monthlySurcharge).toBeNull();
    expect(res.findings[0]!.quantity).toBeNull();
    expect(res.findings[0]!.costBasis).toBe("unpriced");
  });

  it("does not price a started surcharge before its first billed tier", () => {
    const grace: ExtendedSupportDeclaration = {
      ...RDS,
      releases: [
        {
          ...RDS.releases[1]!,
          surcharge: {
            ...RDS.releases[1]!.surcharge!,
            tiers: [{ from: "2026-11-01", rate: 0.1, label: "Billing starts" }],
          },
        },
      ],
    };
    const base = scan([
      { id: "pg", typeId: "rds", fields: { engine: "postgres", engineVersion: "13", vcpus: 2 } },
    ]);
    const input: ExtendedSupportScanInput = {
      ...base,
      plugins: [
        {
          id: "aws",
          displayName: "AWS",
          resourceTypes: [{ id: "rds", displayName: "RDS", extendedSupport: grace }],
        },
      ],
    };
    const f = computeExtendedSupport(input, { now: NOW }).findings[0]!;
    expect(f.status).toBe("surcharged");
    expect(f.monthlySurcharge).toBeNull();
    expect(f.nextTier?.from).toBe("2026-11-01");
  });

  it("ignores unmatched versions, undeclared types and missing accounts", () => {
    const res = computeExtendedSupport(
      scan([
        { id: "new", typeId: "eks", fields: { version: "1.35" } },
        { id: "orphan", typeId: "eks", fields: { version: "1.32" }, accountId: "gone" },
      ]),
      { now: NOW },
    );
    expect(res.findings).toEqual([]);
    expect(res.counts).toEqual({ "end-of-life": 0, surcharged: 0, unsupported: 0, upcoming: 0 });
  });
});

describe("applyExtendedSupportBilling", () => {
  const feed = computeExtendedSupport(
    scan([
      {
        id: "a",
        typeId: "rds",
        fields: { engine: "mysql", engineVersion: "5.7", vcpus: 4, region: "us-east-1" },
      },
      {
        id: "b",
        typeId: "rds",
        fields: { engine: "mysql", engineVersion: "5.7", vcpus: 2, region: "us-east-1" },
      },
      { id: "c", typeId: "eks", fields: { version: "1.32", region: "eu-west-1" } },
    ]),
    { now: NOW },
  );

  it("gives a sole candidate the billed amount as a monthly run rate", () => {
    const res = applyExtendedSupportBilling(
      feed,
      [
        {
          accountId: "acc",
          accountName: "Prod",
          charges: [
            {
              resourceTypeId: "eks",
              region: "eu-west-1",
              lineItem: "EU-AmazonEKS-Hours:extendedSupport",
              amount: 360,
              currency: "USD",
            },
          ],
        },
      ],
      30,
    );
    const c = res.findings.find((f) => f.resourceId === "c")!;
    expect(c.costBasis).toBe("billed");
    expect(c.monthlySurcharge).toBe(365); // 360 / 30 * 30.4167
    expect(c.listMonthlySurcharge).toBe(365);
    expect(c.billedLineItems).toEqual(["EU-AmazonEKS-Hours:extendedSupport"]);
    expect(res.billing?.accounts).toEqual([
      { accountId: "acc", accountName: "Prod", status: "read" },
    ]);
  });

  it("splits a shared line by list-price weight, narrowed by release", () => {
    const res = applyExtendedSupportBilling(
      feed,
      [
        {
          accountId: "acc",
          accountName: "Prod",
          charges: [
            {
              resourceTypeId: "rds",
              releaseId: "mysql-5.7",
              region: "us-east-1",
              lineItem: "ExtendedSupport:Yr3:MySQL5.7",
              amount: 300,
              currency: "USD",
            },
          ],
        },
      ],
      30,
    );
    const a = res.findings.find((f) => f.resourceId === "a")!;
    const b = res.findings.find((f) => f.resourceId === "b")!;
    expect(a.costBasis).toBe("billed-share");
    expect(b.costBasis).toBe("billed-share");
    // 304.17/mo split 4:2.
    expect(a.monthlySurcharge).toBeCloseTo(202.78, 1);
    expect(b.monthlySurcharge).toBeCloseTo(101.39, 1);
  });

  it("lists lines that match nothing as unattributed, and failures by account", () => {
    const res = applyExtendedSupportBilling(
      feed,
      [
        {
          accountId: "acc",
          accountName: "Prod",
          charges: [{ lineItem: "ExtendedSupport:Yr1-Yr2:Redis5", amount: 30, currency: "USD" }],
        },
        { accountId: "acc2", accountName: "Staging", charges: null, error: "AccessDenied" },
      ],
      30,
    );
    expect(res.billing?.unattributed).toHaveLength(1);
    expect(res.billing?.unattributed[0]!.monthlyAmount).toBeCloseTo(30.42, 1);
    expect(res.billing?.accounts[1]).toEqual({
      accountId: "acc2",
      accountName: "Staging",
      status: "failed",
      error: "AccessDenied",
    });
    // Nothing attributed: every finding keeps list price.
    expect(res.findings.every((f) => f.costBasis === "list-price")).toBe(true);
  });
});

describe("expiry radar integration", () => {
  it("yields the next deadline per resource", () => {
    const items = extendedSupportExpiryItems(
      scan([
        { id: "up", typeId: "eks", fields: { version: "1.34" } },
        { id: "now", typeId: "eks", fields: { version: "1.32" } },
        { id: "eol", typeId: "eks", fields: { version: "1.30" } },
      ]),
      { now: NOW, severity: (d) => expirySeverity(d, 60) },
    );
    const byId = new Map(items.map((i) => [i.resourceId, i]));
    expect(byId.get("up")!.dueAt.slice(0, 10)).toBe("2026-12-02");
    expect(byId.get("up")!.label).toContain("surcharge starts");
    expect(byId.get("now")!.dueAt.slice(0, 10)).toBe("2027-03-23");
    expect(byId.get("now")!.label).toContain("forced upgrade");
    expect(byId.get("eol")!.severity).toBe("expired");
    expect(items.every((i) => i.kind === "extended-support")).toBe(true);
  });

  it("rides computeExpiryFeed when a type declares a calendar", () => {
    const feed = computeExpiryFeed(
      scan([{ id: "up", typeId: "eks", fields: { version: "1.34" } }]),
      {
        now: NOW,
        leadDays: 90,
      },
    );
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.severity).toBe("upcoming");
  });
});

describe("extendedSupportIssueSourceId", () => {
  it("never contains NUL (Postgres text cannot store it)", () => {
    expect(extendedSupportIssueSourceId({ resourceId: "r/1", releaseId: "k8s-1.30" })).toBe(
      "r/1#k8s-1.30",
    );
  });
});
