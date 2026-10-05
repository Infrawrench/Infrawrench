import { describe, expect, it } from "vitest";
import type { ExtendedSupportFinding } from "@infrawrench/client-core";
import {
  MAX_LISTED_EXTENDED_SUPPORT,
  extendedSupportFindingLine,
  extendedSupportTitle,
  formatExtendedSupportPushBody,
  formatExtendedSupportSlackBody,
  formatExtendedSupportTeamsBody,
  summarizeExtendedSupport,
} from "../extended-support/summary";

function finding(overrides: Partial<ExtendedSupportFinding> = {}): ExtendedSupportFinding {
  return {
    resourceId: "r1",
    pluginId: "aws",
    pluginName: "AWS",
    resourceTypeId: "eks-cluster",
    resourceTypeName: "EKS Cluster",
    accountId: "a1",
    accountName: "Prod",
    displayName: "payments",
    externalId: "payments",
    region: "us-east-1",
    releaseId: "k8s-1.32",
    product: "Amazon EKS",
    engine: null,
    currentVersion: "1.32",
    targetVersion: "1.35",
    status: "surcharged",
    standardSupportEnds: "2026-03-22",
    surchargeStartsOn: "2026-03-23",
    daysUntilSurcharge: -195,
    extendedSupportEnds: "2027-03-22",
    daysUntilForcedUpgrade: 169,
    charged: true,
    quantity: 1,
    unit: "cluster-hour",
    currency: "USD",
    tierLabel: "$0.50",
    monthlySurcharge: 365,
    listMonthlySurcharge: 365,
    costBasis: "billed",
    billedLineItems: ["AmazonEKS-Hours:extendedSupport"],
    nextTier: null,
    priceNote: null,
    pricingUrl: null,
    upgradeUrl: "https://example.com",
    note: null,
    ...overrides,
  };
}

describe("extended-support alert summary", () => {
  it("totals per currency and leads the title with the money", () => {
    const summary = summarizeExtendedSupport([
      finding(),
      finding({
        resourceId: "r2",
        displayName: "db",
        monthlySurcharge: 146,
        costBasis: "list-price",
      }),
      finding({ resourceId: "r3", status: "end-of-life", monthlySurcharge: null, currency: null }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.surcharged).toBe(2);
    expect(summary.endOfLife).toBe(1);
    expect(summary.monthly).toEqual([{ currency: "USD", monthly: 511 }]);
    expect(extendedSupportTitle(summary)).toBe(
      "Extended support: $511/mo in surcharges an upgrade would remove",
    );
  });

  it("falls back to a count when nothing is priced", () => {
    const summary = summarizeExtendedSupport([finding({ monthlySurcharge: null, currency: null })]);
    expect(extendedSupportTitle(summary)).toBe(
      "Extended support: 1 resource past standard support",
    );
  });

  it("names list-price figures as such and caps the body", () => {
    expect(extendedSupportFindingLine(finding({ costBasis: "list-price" }))).toBe(
      "payments: Amazon EKS 1.32 → 1.35, $365/mo at list price",
    );
    const many = Array.from({ length: MAX_LISTED_EXTENDED_SUPPORT + 3 }, (_, i) =>
      finding({ resourceId: `r${i}` }),
    );
    const summary = summarizeExtendedSupport(many);
    expect(summary.omitted).toBe(3);
    expect(formatExtendedSupportSlackBody(summary)).toContain("…and 3 more resources");
    expect(formatExtendedSupportTeamsBody(summary)).not.toContain("\n\n\n\n");
    expect(formatExtendedSupportPushBody(summary)).toContain(`(+${many.length - 1} more)`);
  });

  it("escapes synced names for Slack", () => {
    const body = formatExtendedSupportSlackBody(
      summarizeExtendedSupport([finding({ displayName: "~struck~" })]),
    );
    expect(body).not.toContain("• ~struck~");
  });
});
