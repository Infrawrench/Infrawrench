import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Validation and restatement for business-metric values.
 *
 * The invariant worth protecting is the same one `cost-ingest.ts` protects, by
 * a different mechanism: **re-reporting a day replaces it rather than adding to
 * it**. For cost rows that falls out of the ReplacingMergeTree key; here it is a
 * `(metric_id, day)` unique index and an `ON CONFLICT DO UPDATE`. An ingest
 * that accumulated would double every number the first time a nightly job
 * retried, and nothing about the resulting chart would look wrong — which is
 * exactly why it is asserted rather than assumed.
 */

vi.mock("../db/schema", () => ({
  businessMetrics: {
    __t: "business_metrics",
    id: "id",
    key: "key",
    organizationId: "organization_id",
    deletedAt: "deleted_at",
  },
  businessMetricValues: {
    __t: "business_metric_values",
    metricId: "metric_id",
    day: "day",
    value: "value",
  },
}));

/** The last `.values(...)` payload and the conflict clause it was given. */
let inserted: Array<Record<string, unknown>> = [];
let conflict: Record<string, unknown> | null = null;

const db = {
  insert: () => ({
    values: (rows: Array<Record<string, unknown>>) => {
      inserted = rows;
      return {
        onConflictDoUpdate: (clause: Record<string, unknown>) => {
          conflict = clause;
          return Promise.resolve(undefined);
        },
      };
    },
  }),
};
vi.mock("../db/client", () => ({ db }));

let mod: typeof import("../cost/metric-ingest");

async function write(values: unknown[], maxValues = 100) {
  return mod.ingestMetricValues({
    organizationId: "org1",
    metricId: "metric1",
    values: values as never,
    source: {
      errorPrefix: "test.write",
      source: "api",
      userId: "user1",
      maxValues,
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  inserted = [];
  conflict = null;
  mod = await import("../cost/metric-ingest");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestMetricValues — restatement", () => {
  it("upserts on (metric, day) so re-reporting a day replaces it", async () => {
    await write([{ date: "2026-07-01", value: 10 }]);
    // The conflict target *is* the restatement guarantee: without it the write
    // would append a second row for the same day and every reader would see the
    // number twice.
    expect(conflict?.["target"]).toEqual(["metric_id", "day"]);
    expect(conflict?.["set"]).toMatchObject({ value: expect.anything() });
  });

  it("collapses a duplicated day within one batch, last write winning", async () => {
    // Postgres refuses an ON CONFLICT DO UPDATE whose own rows collide, so a
    // batch naming a day twice would otherwise fail the whole write with an
    // error naming none of the caller's concepts.
    const result = await write([
      { date: "2026-07-01", value: 10 },
      { date: "2026-07-02", value: 20 },
      { date: "2026-07-01", value: 99 },
    ]);
    expect(result.written).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(inserted.find((r) => r["day"] === "2026-07-01")?.["value"]).toBe(99);
  });

  it("counts restatements as written — the caller did report those days", async () => {
    const result = await write([
      { date: "2026-07-01", value: 1 },
      { date: "2026-07-02", value: 2 },
    ]);
    expect(result.written).toBe(2);
  });

  it("stamps the source and the acting user on every row", async () => {
    await write([{ date: "2026-07-01", value: 1 }]);
    expect(inserted[0]).toMatchObject({
      organizationId: "org1",
      metricId: "metric1",
      source: "api",
      updatedByUserId: "user1",
    });
  });
});

describe("ingestMetricValues — validation", () => {
  it("writes nothing at all when any row is invalid", async () => {
    await expect(
      write([
        { date: "2026-07-01", value: 1 },
        { date: "not-a-day", value: 2 },
      ]),
    ).rejects.toThrow(/value 1 has an invalid date/);
    // Half a month restated is worse than a rejected batch.
    expect(inserted).toEqual([]);
  });

  it("rejects a date that is not a real calendar day", async () => {
    // `new Date("2026-02-30")` silently rolls over to March 1st, so a bare NaN
    // check would let a nonsense date through as a plausible one.
    await expect(write([{ date: "2026-02-30", value: 1 }])).rejects.toThrow(/invalid date/);
  });

  it("rejects a non-finite value", async () => {
    await expect(write([{ date: "2026-07-01", value: Number.NaN }])).rejects.toThrow(
      /non-finite value/,
    );
    await expect(write([{ date: "2026-07-01", value: "12" }])).rejects.toThrow(/non-finite value/);
  });

  it("accepts zero and negative values — the reader decides they are unusable", async () => {
    // Storing them is right; *dividing* by them is what `computeUnitCosts`
    // refuses, and it says so per bucket rather than silently dropping the day.
    const result = await write([
      { date: "2026-07-01", value: 0 },
      { date: "2026-07-02", value: -5 },
    ]);
    expect(result.written).toBe(2);
  });

  it("refuses a batch larger than the caller's cap, naming the cap", async () => {
    const values = Array.from({ length: 4 }, (_, i) => ({
      date: `2026-07-0${i + 1}`,
      value: i,
    }));
    await expect(write(values, 3)).rejects.toThrow(/at most 3 values per call \(got 4\)/);
  });

  it("writes nothing for an empty batch rather than issuing an empty insert", async () => {
    const result = await write([]);
    expect(result.written).toBe(0);
    expect(inserted).toEqual([]);
  });
});
