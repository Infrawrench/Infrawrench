import { describe, expect, it } from "vitest";
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
