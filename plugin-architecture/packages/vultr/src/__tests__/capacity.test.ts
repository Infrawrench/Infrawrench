import { describe, expect, it, vi } from "vitest";
import type { VultrApi } from "../api.js";
import { mapAccount } from "../listers.js";
import { fetchDatabaseMetrics } from "../metrics.js";
import { DatabaseResourceType } from "../resources.js";

describe("bandwidth pool", () => {
  it("stores outbound GB this month against the sum of every credit", () => {
    const account = mapAccount({ name: "acme" }, "acct", {
      current_month_to_date: {
        gb_out: 120,
        instance_bandwidth_credits: 1000,
        free_bandwidth_credits: 2048,
        purchased_bandwidth_credits: 0,
      },
    });
    expect(account.fields["bandwidthGbOut"]).toBe(120);
    expect(account.fields["bandwidthCreditsGb"]).toBe(3048);
  });

  it("leaves both out when the bandwidth read failed", () => {
    const account = mapAccount({ name: "acme" }, "acct", null);
    expect(account.fields["bandwidthGbOut"]).toBeUndefined();
    expect(account.fields["bandwidthCreditsGb"]).toBeUndefined();
  });
});

describe("database disk", () => {
  it("emits the disk share the database type declares as capacity", async () => {
    const api = {
      get: vi.fn(async () => ({
        usage: {
          disk: { current_gb: 12.5, max_gb: 50, percentage: 25 },
          memory: { current_mb: 900, max_mb: 2048, percentage: 44 },
          cpu: { percentage: 3 },
        },
      })),
    } as unknown as VultrApi;
    const series = await fetchDatabaseMetrics(api, "db-1");
    const declared = (DatabaseResourceType.capacityMetrics ?? []).map((m) => m.seriesLabel);
    expect(declared).toEqual(["Disk Used"]);
    expect(series.find((s) => s.label === "Disk Used")?.points[0]?.value).toBe(25);
  });
});
