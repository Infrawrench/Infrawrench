import { afterEach, describe, expect, it, vi } from "vitest";
import { CostSetupError, type CostRow } from "@infrawrench/plugin-base";
import { blendGcpLines, fetchGcpCostData, type GcpCostLine } from "../cost-data";

const range = { fromDate: "2026-07-01", toDate: "2026-07-25" };

function ctx(billingExportTable: string) {
  return {
    project: "consummate-atom-503516-h4",
    token: () => Promise.resolve("token"),
    billingExportTable,
  };
}

describe("fetchGcpCostData setup errors", () => {
  it("asks for the billing export and deep-links to the project's console page", async () => {
    const err = await fetchGcpCostData(ctx(""), range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    const setup = err as CostSetupError;
    expect(setup.message).toMatch(/standard usage cost/);
    expect(setup.helpLink?.url).toBe(
      "https://console.cloud.google.com/billing/export?project=consummate-atom-503516-h4",
    );
  });

  it("rejects a malformed table id with the setup guide", async () => {
    const err = await fetchGcpCostData(ctx("not a table"), range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as CostSetupError).helpLink?.url).toBe(
      "https://cloud.google.com/billing/docs/how-to/export-data-bigquery",
    );
  });

  it("labels the link with the action the user has to take", async () => {
    const err = await fetchGcpCostData(ctx(""), range).catch((e: unknown) => e);
    expect((err as CostSetupError).helpLink?.label).toBe("Enable billing export to BigQuery");
  });

  it("rejects a backticked table id before it reaches the query", async () => {
    const err = await fetchGcpCostData(ctx("p.d.t` UNION SELECT 1 --"), range).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as CostSetupError).message).toMatch(/not a valid project\.dataset\.table/);
  });
});

describe("blendGcpLines", () => {
  const line = (
    over: Partial<GcpCostLine> & { amount: number; project: string; region?: string },
  ): GcpCostLine => ({
    row: {
      date: "2026-07-01",
      service: "Compute Engine",
      region: over.region ?? "us-central1",
      currency: "USD",
      amount: over.amount,
      resourceId: over.project,
      tags: { project: over.project },
    },
    resourceCud: over.resourceCud ?? 0,
    spendCud: over.spendCud ?? 0,
    resourceWeight: over.resourceWeight ?? 0,
    spendWeight: over.spendWeight ?? 0,
  });

  const total = (rows: CostRow[], f: (r: CostRow) => number) => rows.reduce((s, r) => s + f(r), 0);

  it("spreads a resource-based CUD across every eligible project in its region", () => {
    // Project a's 100 of N2 cores were fully covered (credit −100); project b
    // ran 100 of the same SKU uncovered. Same scope, very different bills.
    const rows = blendGcpLines([
      line({ project: "a", amount: 0, resourceCud: -100, resourceWeight: 100 }),
      line({ project: "b", amount: 100, resourceWeight: 100 }),
      // Storage in the same project: not eligible, untouched.
      line({ project: "b", amount: 7 }),
    ]);
    expect(rows.find((r) => r.resourceId === "a")!.blendedAmount).toBeCloseTo(50, 9);
    expect(rows.find((r) => r.resourceId === "b" && r.amount === 100)!.blendedAmount).toBeCloseTo(
      50,
      9,
    );
    expect(rows.find((r) => r.amount === 7)!.blendedAmount).toBeUndefined();
    // The fully covered row is kept even though its net is zero.
    expect(rows).toHaveLength(3);
    expect(total(rows, (r) => r.blendedAmount ?? r.amount)).toBeCloseTo(
      total(rows, (r) => r.amount),
      9,
    );
  });

  it("keeps regional pools apart and pools spend-based CUDs across regions", () => {
    const rows = blendGcpLines([
      line({ project: "a", amount: 10, resourceCud: -30, resourceWeight: 40 }),
      line({ project: "b", amount: 40, region: "europe-west1", resourceWeight: 40 }),
      line({ project: "c", amount: 20, spendCud: -10, spendWeight: 30 }),
      line({ project: "d", amount: 30, region: "asia-east1", spendWeight: 30 }),
    ]);
    // a is alone in its resource pool (b's region got no resource CUD credit
    // of its own, so b's weight is in a different pool with nothing to split).
    expect(rows.find((r) => r.resourceId === "a")!.blendedAmount).toBeCloseTo(10, 9);
    expect(rows.find((r) => r.resourceId === "b")!.blendedAmount).toBeUndefined();
    // Spend pool: −10 over weights 30 and 30.
    expect(rows.find((r) => r.resourceId === "c")!.blendedAmount).toBeCloseTo(25, 9);
    expect(rows.find((r) => r.resourceId === "d")!.blendedAmount).toBeCloseTo(25, 9);
  });

  it("preserves every day's total over generated inputs", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const days = ["2026-07-01", "2026-07-02", "2026-07-03"];
    const regions = ["us-central1", "europe-west1", ""];
    const lines: GcpCostLine[] = Array.from({ length: 300 }, (_, i) => {
      const gross = Math.round(rand() * 10000) / 100;
      const resourceWeight = rand() < 0.5 ? gross : 0;
      const spendWeight = rand() < 0.3 ? gross : 0;
      const resourceCud = resourceWeight && rand() < 0.5 ? -resourceWeight * rand() : 0;
      const spendCud = spendWeight && rand() < 0.5 ? -spendWeight * rand() * 0.3 : 0;
      const l = line({
        project: `p${i}`,
        amount: gross + resourceCud + spendCud,
        region: regions[i % 3]!,
        resourceCud,
        spendCud,
        resourceWeight,
        spendWeight,
      });
      l.row.date = days[i % 3]!;
      return l;
    });
    const rows = blendGcpLines(lines);
    for (const day of days) {
      const ofDay = rows.filter((r) => r.date === day);
      // The host's amortized basis falls back to cash for GCP.
      expect(total(ofDay, (r) => r.blendedAmount ?? r.amount)).toBeCloseTo(
        total(ofDay, (r) => r.amount),
        9,
      );
    }
    expect(rows.some((r) => r.blendedAmount !== undefined)).toBe(true);
  });

  it("drops rows with no money on any basis", () => {
    expect(blendGcpLines([line({ project: "a", amount: 0 })])).toEqual([]);
  });
});

describe("fetchGcpCostData blended query", () => {
  afterEach(() => vi.restoreAllMocks());

  function bqResponse(fields: string[], rows: string[][]) {
    return new Response(
      JSON.stringify({
        jobComplete: true,
        jobReference: { projectId: "p", jobId: "j" },
        schema: { fields: fields.map((name) => ({ name })) },
        rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })),
      }),
      { status: 200 },
    );
  }

  it("selects CUD credits by type and blends them", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bqResponse(
        [
          "day",
          "service",
          "region",
          "project_id",
          "currency",
          "net_cost",
          "cud_resource",
          "cud_spend",
          "weight_resource",
          "weight_spend",
        ],
        [
          ["2026-07-01", "Compute Engine", "us-central1", "a", "USD", "0", "-100", "0", "100", "0"],
          ["2026-07-01", "Compute Engine", "us-central1", "b", "USD", "100", "0", "0", "100", "0"],
        ],
      ),
    );

    const rows = await fetchGcpCostData(ctx("proj.billing.export_v1"), range);

    const query = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body)).query as string;
    expect(query).toContain("c.type = 'COMMITTED_USAGE_DISCOUNT'");
    expect(query).toContain("c.type = 'COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE'");
    expect(query).toContain("sku.id");
    expect(rows.map((r) => r.blendedAmount)).toEqual([50, 50]);
  });

  it("falls back to the original query when the export table rejects the richer one", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Unrecognized name: type", { status: 400 }))
      .mockResolvedValueOnce(
        bqResponse(
          ["day", "service", "region", "project_id", "currency", "net_cost"],
          [["2026-07-01", "Compute Engine", "us-central1", "a", "USD", "12.5"]],
        ),
      );

    const rows = await fetchGcpCostData(ctx("proj.billing.export_v1"), range);

    expect(spy).toHaveBeenCalledTimes(2);
    const fallback = JSON.parse(String((spy.mock.calls[1]![1] as RequestInit).body))
      .query as string;
    expect(fallback).not.toContain("credits.type");
    expect(fallback).not.toContain("c.type");
    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Compute Engine",
        region: "us-central1",
        currency: "USD",
        amount: 12.5,
        resourceId: "a",
        tags: { project: "a" },
      },
    ]);
  });

  it("reports cost_at_list only where every export row carried it", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bqResponse(
        [
          "day",
          "service",
          "region",
          "project_id",
          "currency",
          "net_cost",
          "list_cost",
          "list_missing",
        ],
        [
          ["2026-07-01", "Compute Engine", "us-central1", "proj", "USD", "80", "100", "0"],
          ["2026-07-01", "Cloud Storage", "us-central1", "proj", "USD", "5", "3", "2"],
        ],
      ),
    );
    const rows = await fetchGcpCostData(ctx("p.d.t"), range);
    expect(String(JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body)).query)).toContain(
      "SUM(l.cost_at_list)",
    );
    expect(rows.find((r) => r.service === "Compute Engine")?.listAmount).toBe(100);
    expect(rows.find((r) => r.service === "Cloud Storage")?.listAmount).toBeUndefined();
  });

  it("drops only the list columns on an export table that predates cost_at_list", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Unrecognized name: cost_at_list at [1:200]", { status: 400 }),
      )
      .mockResolvedValueOnce(
        bqResponse(
          ["day", "service", "region", "project_id", "currency", "net_cost"],
          [["2026-07-01", "Compute Engine", "", "proj", "USD", "80"]],
        ),
      );
    const rows = await fetchGcpCostData(ctx("p.d.t"), range);
    expect(spy).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String((spy.mock.calls[1]![1] as RequestInit).body)).query as string;
    expect(retry).not.toContain("cost_at_list");
    // Blending survives: only the column the table lacked was dropped.
    expect(retry).toContain("c.type = 'COMMITTED_USAGE_DISCOUNT'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(80);
    expect(rows[0]!.listAmount).toBeUndefined();
  });

  it("ends at the original query when the table lacks both", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Unrecognized name: type", { status: 400 }))
      .mockResolvedValueOnce(new Response("Unrecognized name: cost_at_list", { status: 400 }))
      .mockResolvedValueOnce(
        bqResponse(
          ["day", "service", "region", "project_id", "currency", "net_cost"],
          [["2026-07-01", "Compute Engine", "", "proj", "USD", "80"]],
        ),
      );
    const rows = await fetchGcpCostData(ctx("p.d.t"), range);
    expect(spy).toHaveBeenCalledTimes(3);
    const last = JSON.parse(String((spy.mock.calls[2]![1] as RequestInit).body)).query as string;
    expect(last).not.toContain("cost_at_list");
    expect(last).not.toContain("c.type");
    expect(rows[0]!.amount).toBe(80);
  });

  it("does not fall back on errors other than a rejected query", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(fetchGcpCostData(ctx("proj.billing.export_v1"), range)).rejects.toThrow(/403/);
  });
});
