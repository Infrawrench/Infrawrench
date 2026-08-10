import { describe, expect, it } from "vitest";

import {
  fetchGcpCommitments,
  mapGcpCommitment,
  normalizeGcpCommitmentStatus,
} from "../commitments.js";

describe("normalizeGcpCommitmentStatus", () => {
  it("maps the documented statuses, understating on unknowns", () => {
    expect(normalizeGcpCommitmentStatus("ACTIVE")).toBe("active");
    expect(normalizeGcpCommitmentStatus("NOT_YET_ACTIVE")).toBe("queued");
    expect(normalizeGcpCommitmentStatus("EXPIRED")).toBe("expired");
    expect(normalizeGcpCommitmentStatus("CANCELLED")).toBe("expired");
    expect(normalizeGcpCommitmentStatus("SOMETHING_NEW")).toBe("expired");
  });
});

describe("mapGcpCommitment", () => {
  it("populates unit commitments and omits every money field", () => {
    const record = mapGcpCommitment(
      {
        name: "commitment-1",
        description: "prod steady-state",
        region: "https://www.googleapis.com/compute/v1/projects/p/regions/us-central1",
        plan: "THIRTY_SIX_MONTH",
        status: "ACTIVE",
        startTimestamp: "2026-01-01T00:00:00.000-08:00",
        endTimestamp: "2029-01-01T00:00:00.000-08:00",
        type: "GENERAL_PURPOSE_N2",
        resources: [
          { type: "VCPU", amount: "32" },
          { type: "MEMORY", amount: "131072" },
        ],
      },
      "us-central1",
    )!;
    expect(record.kind).toBe("committed_use");
    expect(record.unitCommitments).toEqual([
      { unit: "VCPU", amount: 32 },
      // The API reports memory in MB; the unit says so instead of converting.
      { unit: "MEMORY_MB", amount: 131072 },
    ]);
    // The aggregated list returns no money of any kind — every money field
    // must be absent, not zero. "Free" and "not reported" are different facts.
    expect(record.currency).toBeUndefined();
    expect(record.upfrontAmount).toBeUndefined();
    expect(record.recurringAmount).toBeUndefined();
    expect(record.hourlyCommitmentAmount).toBeUndefined();
    // termDays from the provider's own plan enum, not the dates.
    expect(record.termDays).toBe(1095);
    expect(record.region).toBe("us-central1");
    expect(record.state).toBe("active");
  });

  it("maps TWELVE_MONTH to 365 days", () => {
    const record = mapGcpCommitment(
      { name: "c", plan: "TWELVE_MONTH", status: "ACTIVE", startTimestamp: "2026-01-01" },
      "europe-west1",
    )!;
    expect(record.termDays).toBe(365);
  });
});

describe("fetchGcpCommitments", () => {
  it("walks the aggregated scopes and follows pageToken", async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown>[] = [
      {
        items: {
          "regions/us-central1": {
            commitments: [{ name: "a", status: "ACTIVE", startTimestamp: "2026-01-01" }],
          },
          // Scopes without commitments carry only a warning entry.
          "regions/us-west1": { warning: { code: "NO_RESULTS_ON_PAGE" } },
        },
        nextPageToken: "page-2",
      },
      {
        items: {
          "regions/europe-west1": {
            commitments: [{ name: "b", status: "EXPIRED", startTimestamp: "2020-01-01" }],
          },
        },
      },
    ];
    const records = await fetchGcpCommitments({
      project: "proj",
      get: async <T>(url: string): Promise<T> => {
        calls.push(url);
        return pages.shift() as T;
      },
    });
    expect(records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(records[0]!.region).toBe("us-central1");
    expect(calls[0]).toContain("/projects/proj/aggregated/commitments");
    expect(calls[1]).toContain("pageToken=page-2");
  });
});
