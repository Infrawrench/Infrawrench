import { describe, expect, it, vi } from "vitest";
import type { RunwayRow } from "@infrawrench/client-core";

vi.mock("../db/client", () => ({ db: {} }));

import { capacityReadings } from "../capacity/record";
import { runwayLines, runwayRowLine, runwayTitle, summarizeRunway } from "../capacity/summary";

const GiB = 1024 ** 3;

const plugin = {
  resourceTypes: [
    {
      id: "volume",
      fields: [
        { key: "name", label: "Name" },
        {
          key: "usedBytes",
          label: "Used",
          usage: { limit: { field: "sizeGb", scale: GiB }, unit: "bytes" },
        },
        { key: "sizeGb", label: "Size" },
        {
          key: "hours",
          label: "Compute hours",
          usage: {
            limit: { plan: { field: "plan", allowances: { free: 100 } } },
            cycle: { period: "monthly" as const },
          },
        },
        { key: "plan", label: "Plan" },
      ],
      outputs: [],
      capacityMetrics: [{ seriesLabel: "Disk %", limit: { constant: 100 } }],
    },
    { id: "other", fields: [{ key: "x", label: "X" }], outputs: [] },
  ],
} as never;

describe("capacityReadings", () => {
  it("reads declared field usages and their limits from synced fields", () => {
    const readings = capacityReadings(plugin, [
      {
        id: "v1",
        resourceTypeId: "volume",
        fields: { usedBytes: 3 * GiB, sizeGb: "10", hours: "40", plan: "Free" },
      },
      // No limit: no reading. Unparseable usage: no reading.
      {
        id: "v2",
        resourceTypeId: "volume",
        fields: { usedBytes: GiB, hours: "lots", plan: "pro" },
      },
      { id: "o1", resourceTypeId: "other", fields: { x: 1 } },
    ]);
    expect(readings).toEqual([
      { resourceId: "v1", capacityKey: "usedBytes", used: 3 * GiB, limit: 10 * GiB },
      { resourceId: "v1", capacityKey: "hours", used: 40, limit: 100 },
    ]);
  });

  it("never records metric usages, which the metrics writer already stores", () => {
    const readings = capacityReadings(plugin, [
      { id: "v1", resourceTypeId: "volume", fields: {}, resolvedOutputs: { "Disk %": 50 } },
    ]);
    expect(readings).toEqual([]);
  });
});

function row(overrides: Partial<RunwayRow>): RunwayRow {
  return {
    key: "usedBytes",
    resourceId: "r1",
    resourceName: "orders-db",
    resourceTypeId: "volume",
    accountId: "a1",
    accountName: "prod",
    pluginId: "fly",
    label: "Storage",
    unit: "bytes",
    used: 9.2 * GiB,
    limit: 10 * GiB,
    utilization: 0.92,
    limitSource: "provider",
    plan: null,
    kind: "runway",
    source: "field",
    observedAt: "2026-11-18T12:00:00.000Z",
    forecast: {
      perDay: GiB / 8,
      daysLeft: 6.4,
      fullAt: null,
      method: "trend",
      confidence: "ok",
      points: 100,
    },
    cycle: null,
    status: "critical",
    ...overrides,
  };
}

describe("runway alert message", () => {
  const settings = { runwayDays: 14, allowanceThreshold: 0.8 };

  it("names the resource, the amounts and the countdown", () => {
    expect(runwayRowLine(row({}))).toBe(
      "prod · orders-db · Storage: 9.2 GiB of 10.0 GiB, full in 6 days",
    );
    expect(
      runwayRowLine(
        row({
          label: "Emails",
          unit: "emails",
          used: 41_000,
          limit: 50_000,
          kind: "allowance",
          limitSource: "plan",
          plan: "Foundation",
          cycle: {
            start: "2026-11-01T00:00:00.000Z",
            end: "2026-12-01T00:00:00.000Z",
            projectedUsed: 71_000,
            projectedUtilization: 1.42,
          },
        }),
      ),
    ).toBe(
      "prod · orders-db · Emails: 41,000 emails of 50,000 emails (Foundation plan), 71,000 emails projected by 2026-12-01",
    );
  });

  it("leads with what is already full", () => {
    const summary = summarizeRunway(
      [row({ status: "full", used: 10 * GiB }), row({}), row({ kind: "allowance" })],
      settings,
    );
    expect(summary).toMatchObject({ total: 3, full: 1, runningOut: 1, allowances: 1 });
    expect(runwayTitle(summary)).toBe("Capacity runway: 1 resource limit reached, 2 running out");
    expect(runwayLines(summary, (s) => `*${s}*`).slice(0, 2)).toEqual([
      "*3 resource limits* at or heading for capacity",
      "1 at the limit · 1 within 14 days · 1 monthly allowance running out",
    ]);
  });
});
