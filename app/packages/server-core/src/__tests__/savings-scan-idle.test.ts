import { describe, expect, it, vi } from "vitest";
import type { OrphanListResponse } from "@infrawrench/client-core";

/** `orphanFindings` is pure; its module's database and feed imports are stubbed inert. */
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../alerts/route", () => ({ routeAlert: vi.fn() }));
vi.mock("../savings/orphans", () => ({ listOrphans: vi.fn() }));
vi.mock("../savings/rightsizing", () => ({ listRightsizing: vi.fn() }));

const { orphanFindings } = await import("../github-issues/savings-scan");

const feed: OrphanListResponse = {
  accounts: [
    {
      accountId: "acc-1",
      accountName: "Prod AWS",
      pluginId: "aws",
      pluginName: "AWS",
      resources: [
        {
          id: "res-nat",
          pluginId: "aws",
          resourceTypeId: "nat-gateway",
          resourceTypeName: "NAT Gateway",
          displayName: "egress-nat",
          externalId: "nat-0abc",
          reason: "No traffic through the NAT gateway in 14 days",
          cost: null,
          owner: null,
          lastSyncedAt: null,
          estimate: { monthlyAmount: 32.85, currency: "USD", basis: "list-price" },
          idle: {
            ruleId: "nat-gateway",
            ruleKey: "aws:nat-gateway",
            ruleLabel: "Idle NAT gateway",
            action: "remove",
            lookbackDays: 14,
            evidence: [
              {
                metric: "BytesOutToDestination",
                label: "Bytes sent to destinations",
                statistic: "sum",
                value: 0,
                unit: "bytes",
                threshold: 1_000_000,
                comparison: "atMost",
              },
            ],
            detectedAt: "2026-10-01T00:00:00.000Z",
            evaluatedAt: "2026-10-16T00:00:00.000Z",
            hasResource: true,
          },
        },
        {
          id: "idle:f-2",
          pluginId: "datadog",
          resourceTypeId: "",
          resourceTypeName: "Custom metric",
          displayName: "app.latency",
          externalId: "app.latency",
          reason: "Not queried in 30 days",
          cost: null,
          owner: null,
          lastSyncedAt: null,
          estimate: null,
          idle: {
            ruleId: "unused-custom-metric",
            ruleKey: "datadog:unused-custom-metric",
            ruleLabel: "Unused custom metric",
            action: "reconfigure",
            lookbackDays: 30,
            evidence: [],
            detectedAt: "2026-10-01T00:00:00.000Z",
            evaluatedAt: "2026-10-16T00:00:00.000Z",
            hasResource: false,
          },
        },
      ],
    },
  ],
  totalCount: 2,
  unownedCount: 2,
  costWindowDays: 30,
  generatedAt: "2026-10-16T00:00:00.000Z",
};

describe("orphanFindings with idle rows", () => {
  it("prices from the list-price estimate and says it is one", () => {
    const [nat] = orphanFindings(feed, null);
    expect(nat!.monthly).toEqual({ amount: 32.85, currency: "USD" });
    expect(nat!.idle).toBe(true);
    expect(nat!.body).toContain("at list price (estimate)");
    expect(nat!.title).toBe("egress-nat (NAT Gateway): idle nat gateway");
    const details = nat!.finding.details ?? [];
    expect(details).toContainEqual({ label: "Idle rule", value: "Idle NAT gateway" });
    expect(details).toContainEqual({
      label: "Evidence",
      value: "Bytes sent to destinations (BytesOutToDestination, sum): 0 B, flags at ≤ 1.0 MB",
    });
    expect(nat!.finding.resourceId).toBe("res-nat");
  });

  it("leaves an unpriced non-resource finding unpriced and unrouted by resource", () => {
    const [, metric] = orphanFindings(feed, null);
    expect(metric!.monthly).toBeNull();
    expect(metric!.finding.resourceId).toBeUndefined();
    expect(metric!.sourceId).toBe("idle:f-2");
  });
});
