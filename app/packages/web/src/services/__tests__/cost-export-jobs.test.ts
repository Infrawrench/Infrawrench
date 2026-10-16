import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service's own rules: request validation before anything is stored, the
 * report's scope frozen into the job, and the unit-cost columns a report export
 * gains. The database and every reader are mocked; the claim and the writer are
 * exercised by the real-database suite's shape (one UPDATE … SKIP LOCKED) and by
 * the route tests.
 */
const inserted: unknown[] = [];
const activeRows: Array<{ id: string }> = [];

vi.mock("@infrawrench/server-core/db/client", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(activeRows),
  };
  return {
    db: {
      select: () => chain,
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return {
            returning: () =>
              Promise.resolve([
                {
                  ...v,
                  status: "queued",
                  progress: 0,
                  rowCount: 0,
                  byteCount: 0,
                  chunkCount: 0,
                  error: null,
                  attempts: 0,
                  leaseUntil: null,
                  startedAt: null,
                  finishedAt: null,
                  expiresAt: null,
                  createdAt: new Date("2026-04-01T00:00:00Z"),
                  updatedAt: new Date("2026-04-01T00:00:00Z"),
                },
              ]),
          };
        },
      }),
    },
  };
});
vi.mock("@infrawrench/server-core/cost/visibility", () => ({ resolveCostVisibility: vi.fn() }));
vi.mock("@infrawrench/server-core/cost-exports/run", () => ({ costCollectionWatermark: vi.fn() }));
vi.mock("@infrawrench/server-core/cost-exports/focus", () => ({}));
vi.mock("@infrawrench/server-core/cost-exports/rows", () => ({}));

class MockCostQueryError extends Error {}
const mockResolveFilters = vi.fn();
vi.mock("../cost-query", () => ({
  CostQueryError: MockCostQueryError,
  daySpan: (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
  resolveCostRequestFilters: (...args: unknown[]) => mockResolveFilters(...args),
}));
const mockGetReport = vi.fn();
vi.mock("../cost-reports", () => ({ getCostReport: (...a: unknown[]) => mockGetReport(...a) }));
const mockGetMetric = vi.fn();
vi.mock("../business-metrics", () => ({
  getBusinessMetric: (...a: unknown[]) => mockGetMetric(...a),
}));
vi.mock("../unit-cost-query", () => ({
  runUnitCostQuery: vi.fn(),
  runUsageUnitCostQuery: vi.fn(),
}));

const { createCostExportJob, nativeLines, CostExportJobError } =
  await import("../cost-export-jobs");

const principal = { userId: "user-1", apiKeyId: null, agentRegistrationId: null };

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  activeRows.length = 0;
  mockResolveFilters.mockResolvedValue([{ dimension: "provider", op: "in", values: ["aws"] }]);
});

describe("createCostExportJob", () => {
  it("needs exactly one of a report and a query", async () => {
    await expect(createCostExportJob("org-1", principal, { format: "csv" })).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      createCostExportJob("org-1", principal, { format: "csv", reportId: "r", query: {} }),
    ).rejects.toThrow(/exactly one/);
  });

  it("needs a range for an ad-hoc query, and caps its span", async () => {
    await expect(
      createCostExportJob("org-1", principal, { format: "csv", query: {} }),
    ).rejects.toThrow(/needs from and to/);
    await expect(
      createCostExportJob("org-1", principal, {
        format: "csv",
        query: {},
        from: "2023-01-01",
        to: "2026-01-01",
      }),
    ).rejects.toThrow(/at most 731 days/);
  });

  it("refuses an unknown dimension by name", async () => {
    await expect(
      createCostExportJob("org-1", principal, {
        format: "csv",
        query: { dimensions: ["service", "colour"] },
        from: "2026-01-01",
        to: "2026-01-31",
      }),
    ).rejects.toThrow(/Unknown dimension: colour/);
  });

  it("answers 404 for a report the caller cannot see", async () => {
    mockGetReport.mockResolvedValue(null);
    const err = await createCostExportJob("org-1", principal, {
      format: "csv",
      reportId: "r",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostExportJobError);
    expect((err as InstanceType<typeof CostExportJobError>).status).toBe(404);
  });

  it("caps the jobs one person has running at once", async () => {
    activeRows.push({ id: "a" }, { id: "b" }, { id: "c" });
    const err = await createCostExportJob("org-1", principal, {
      format: "csv",
      query: {},
      from: "2026-01-01",
      to: "2026-01-31",
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof CostExportJobError>).status).toBe(409);
  });

  it("freezes a report's scope, group-by and unit cost into the job", async () => {
    mockGetReport.mockResolvedValue({
      id: "r1",
      name: "Prod spend",
      config: {
        title: "",
        dateRange: { kind: "absolute", from: "2026-01-01", to: "2026-03-31" },
        binning: "daily",
        groupBy: "service",
        filters: [{ dimension: "provider", op: "in", values: ["aws"] }],
        savedFilterId: "sf-1",
        topN: 5,
        chartType: "line",
        comparePreviousPeriod: false,
        showForecast: false,
        costBasis: "amortized",
        unitCostMetricId: "metric-1",
        unitCostScale: 1000,
      },
    });
    mockGetMetric.mockResolvedValue({ id: "metric-1", key: "orders" });
    const job = await createCostExportJob("org-1", principal, {
      format: "csv",
      reportId: "r1",
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(mockResolveFilters).toHaveBeenCalledWith("org-1", {
      filters: [{ dimension: "provider", op: "in", values: ["aws"] }],
      savedFilterId: "sf-1",
    });
    expect(inserted[0]).toMatchObject({
      createdByUserId: "user-1",
      fromDay: "2026-02-01",
      toDay: "2026-02-28",
      format: "csv",
      focusVersion: null,
      source: {
        kind: "report",
        reportId: "r1",
        reportName: "Prod spend",
        costBasis: "amortized",
        dimensions: ["service"],
        unitCost: { metricId: "metric-1", metricName: "orders", mode: "unit_cost", scale: 1000 },
      },
    });
    expect(job).toMatchObject({
      status: "queued",
      fileName: "costs-prod-spend-2026-02-01-to-2026-02-28.csv",
      source: { unitCostMetric: "orders" },
      downloadUrl: null,
    });
  });

  it("defaults a FOCUS job to the latest version", async () => {
    await createCostExportJob("org-1", principal, {
      format: "focus",
      query: {},
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(inserted[0]).toMatchObject({
      focusVersion: "1.4",
      contentType: "text/csv; charset=utf-8",
    });
  });
});

describe("nativeLines", () => {
  async function collect(it: AsyncIterable<string>): Promise<string> {
    let out = "";
    for await (const line of it) out += line;
    return out;
  }
  async function* rows() {
    yield {
      day: "2026-02-01",
      service: "EC2",
      currency: "USD",
      amount: 10,
      usage_amount: 0,
      usage_unit: "",
    };
    yield {
      day: "2026-02-02",
      service: "EC2",
      currency: "USD",
      amount: 4,
      usage_amount: 0,
      usage_unit: "",
    };
  }
  const columns = { dimensions: ["service"], tagColumns: [] };
  const stamp = { exportedAt: "2026-03-01T00:00:00.000Z", collectionWatermark: "2026-02-28" };

  it("appends each day's unit cost across the report scope, and the reason where there is none", async () => {
    const lookup = new Map([
      [
        "2026-02-01|USD",
        {
          unit_cost_metric: "orders",
          unit_cost_mode: "unit_cost",
          unit_cost_scope_cost: 30,
          unit_cost_metric_value: 60,
          unit_cost_value: 0.5,
          unit_cost_gap: null,
        },
      ],
    ]);
    const csv = await collect(
      nativeLines(rows(), columns, stamp, "csv", { lookup, failure: null }, "orders"),
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "day,service,currency,amount,usage_amount,usage_unit,exported_at,collection_watermark," +
        "unit_cost_metric,unit_cost_mode,unit_cost_scope_cost,unit_cost_metric_value,unit_cost_value,unit_cost_gap",
    );
    expect(lines[1]).toBe(
      "2026-02-01,EC2,USD,10,0,,2026-03-01T00:00:00.000Z,2026-02-28,orders,unit_cost,30,60,0.5,",
    );
    // No unit cost that day: empty value, never 0, with the reason.
    expect(lines[2]).toBe(
      "2026-02-02,EC2,USD,4,0,,2026-03-01T00:00:00.000Z,2026-02-28,orders,,,,,no_unit_cost",
    );
  });

  it("writes the plain layout when the report has no unit cost, and NDJSON with nulls", async () => {
    const csv = await collect(nativeLines(rows(), columns, stamp, "csv", null, null));
    expect(csv.split("\n")[0]).toBe(
      "day,service,currency,amount,usage_amount,usage_unit,exported_at,collection_watermark",
    );
    const nd = await collect(
      nativeLines(
        rows(),
        columns,
        stamp,
        "ndjson",
        { lookup: new Map(), failure: "unavailable" },
        "orders",
      ),
    );
    const first = JSON.parse(nd.split("\n")[0]!);
    expect(first).toMatchObject({
      day: "2026-02-01",
      unit_cost_value: null,
      unit_cost_gap: "unavailable",
    });
  });
});
