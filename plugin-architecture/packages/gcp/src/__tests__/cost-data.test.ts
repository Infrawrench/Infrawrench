import { afterEach, describe, expect, it, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { fetchGcpCostData } from "../cost-data";

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

describe("fetchGcpCostData list prices", () => {
  afterEach(() => vi.restoreAllMocks());

  function bqResponse(rows: Array<Array<string | null>>, withList: boolean): Response {
    const fields = ["day", "service", "region", "project_id", "currency", "net_cost"];
    if (withList) fields.push("list_cost", "list_missing");
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

  it("reports cost_at_list only where every export row carried it", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bqResponse(
        [
          ["2026-07-01", "Compute Engine", "us-central1", "proj", "USD", "80", "100", "0"],
          ["2026-07-01", "Cloud Storage", "us-central1", "proj", "USD", "5", "3", "2"],
        ],
        true,
      ),
    );
    const rows = await fetchGcpCostData(ctx("p.d.t"), range);
    expect(String(JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body)).query)).toContain(
      "SUM(cost_at_list)",
    );
    expect(rows.find((r) => r.service === "Compute Engine")?.listAmount).toBe(100);
    expect(rows.find((r) => r.service === "Cloud Storage")?.listAmount).toBeUndefined();
  });

  it("retries without the column on an export table that predates it", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Unrecognized name: cost_at_list at [1:200]", { status: 400 }),
      )
      .mockResolvedValueOnce(
        bqResponse([["2026-07-01", "Compute Engine", "", "proj", "USD", "80"]], false),
      );
    const rows = await fetchGcpCostData(ctx("p.d.t"), range);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(80);
    expect(rows[0]!.listAmount).toBeUndefined();
  });
});
