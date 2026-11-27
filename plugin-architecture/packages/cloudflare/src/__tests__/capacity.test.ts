import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapD1Database } from "../clients/d1-client.js";
import { fetchMetricSeries } from "../metric-series.js";
import { plugin } from "../plugin.js";
import { makeApi } from "./_helpers.js";

function type(id: string) {
  const t = plugin.resourceTypes.find((r) => r.id === id);
  if (!t) throw new Error(id);
  return t;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("capacity", () => {
  it("stores a D1 database's file size against the per-database cap", () => {
    const db = mapD1Database(
      {
        uuid: "d1-uuid",
        name: "app",
        version: "production",
        num_tables: 12,
        file_size: 2_500_000_000,
        created_at: "2026-01-01T00:00:00Z",
      },
      "acct",
    );
    const [decl] = capacityDeclarations(type("d1-database"));
    expect(decl!.valueKey).toBe("fileSize");
    expect(Number(db.fields["fileSize"])).toBe(2_500_000_000);
    expect(resolveCapacityLimit(decl!.declaration.limit, db.fields)!.limit).toBe(10_000_000_000);
  });

  it("leaves a D1 database's size empty when the response has none", () => {
    const db = mapD1Database({ uuid: "d1-uuid", name: "app" }, "acct");
    expect(db.fields["fileSize"]).toBe("");
  });

  it("declares the queue backlog series the metrics code emits", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            accounts: [
              {
                queueMessageOperationsAdaptiveGroups: [],
                queueBacklogAdaptiveGroups: [
                  {
                    avg: { messages: 40, bytes: 4096 },
                    dimensions: { datetimeHour: "2026-11-23T00:00:00Z" },
                  },
                ],
              },
            ],
          },
        },
      }),
    })) as never;
    const series = await fetchMetricSeries(makeApi(), "queue", "acct:queue:q1", "acct", {
      startMs: Date.now() - 48 * 3_600_000,
      endMs: Date.now(),
    });
    const labels = series.map((s) => s.label);
    for (const m of type("queue").capacityMetrics ?? []) expect(labels).toContain(m.seriesLabel);
  });
});
