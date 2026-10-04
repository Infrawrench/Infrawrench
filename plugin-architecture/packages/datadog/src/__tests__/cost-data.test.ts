import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import {
  aggregateRows,
  chargesByPricing,
  fetchDatadogCostData,
  fetchDatadogCostSummary,
} from "../cost-data.js";
import { ctxWith, makeHttp } from "./helpers.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");

function entry(date: string, charges: Array<[string, string, number]>, org = "Acme") {
  return {
    type: "cost_by_org",
    id: `${org}-${date}`,
    attributes: {
      org_name: org,
      public_id: `pub-${org}`,
      region: "us",
      date: `${date}T00:00:00+00:00`,
      charges: charges.map(([product_name, charge_type, cost]) => ({
        product_name,
        charge_type,
        cost,
      })),
    },
  };
}

describe("chargesByPricing", () => {
  it("prefers committed/on-demand over total, and uses total when alone", () => {
    const out = chargesByPricing([
      { product_name: "infra_host", charge_type: "committed", cost: 10 },
      { product_name: "infra_host", charge_type: "on_demand", cost: 5 },
      { product_name: "infra_host", charge_type: "total", cost: 15 },
      { product_name: "logs_indexed", charge_type: "total", cost: 7 },
      { product_name: "apm_host", charge_type: "projected_on_demand", cost: 3 },
    ]);
    expect([...out.get("infra_host")!.entries()]).toEqual([
      ["committed", 10],
      ["on_demand", 5],
    ]);
    expect([...out.get("logs_indexed")!.entries()]).toEqual([["total", 7]]);
    expect([...out.get("apm_host")!.entries()]).toEqual([["on_demand", 3]]);
  });
});

describe("aggregateRows", () => {
  it("sums rows whose product ids share a label", () => {
    const rows = aggregateRows([
      { date: "2026-10-01", service: "Indexed Spans", currency: "USD", amount: 1 },
      { date: "2026-10-01", service: "Indexed Spans", currency: "USD", amount: 2 },
    ]);
    expect(rows).toEqual([
      { date: "2026-10-01", service: "Indexed Spans", currency: "USD", amount: 3 },
    ]);
  });
});

describe("fetchDatadogCostData", () => {
  it("differences month-to-date running totals into daily rows, one request per month", async () => {
    const { http, calls } = makeHttp((url) => {
      expect(url.pathname).toBe("/api/v2/usage/estimated_cost");
      const start = url.searchParams.get("start_date");
      if (start === "2026-09-01") {
        return {
          body: {
            data: [
              entry("2026-09-01", [["infra_host", "committed", 10]]),
              entry("2026-09-02", [["infra_host", "committed", 25]]),
              entry("2026-09-30", [
                ["infra_host", "committed", 40],
                ["logs_indexed", "on_demand", 2],
              ]),
            ],
          },
        };
      }
      return {
        body: {
          data: [
            entry("2026-10-01", [["infra_host", "committed", 3]]),
            entry("2026-10-03", [["infra_host", "committed", 9]]),
          ],
        },
      };
    });
    const rows = await fetchDatadogCostData(
      ctxWith(http),
      { fromDate: "2026-09-01", toDate: "2026-10-31" },
      NOW,
    );
    expect(calls.map((c) => c.url.searchParams.get("start_date"))).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(calls[0]!.url.searchParams.get("end_date")).toBe("2026-09-30");
    // `to` is clamped to today.
    expect(calls[1]!.url.searchParams.get("end_date")).toBe("2026-10-04");
    expect(calls[0]!.url.searchParams.get("cost_aggregation")).toBe("cumulative");
    expect(calls[0]!.url.searchParams.get("view")).toBe("sub-org");
    expect(calls[0]!.headers["DD-API-KEY"]).toBe("api-key");
    expect(calls[0]!.headers["DD-APPLICATION-KEY"]).toBe("app-key");

    const byDate = Object.fromEntries(
      rows.map((r) => [`${r.date}|${r.service}`, { amount: r.amount, tags: r.tags }]),
    );
    expect(byDate["2026-09-01|Infrastructure Hosts"]!.amount).toBe(10);
    expect(byDate["2026-09-02|Infrastructure Hosts"]!.amount).toBe(15);
    expect(byDate["2026-09-30|Infrastructure Hosts"]!.amount).toBe(15);
    expect(byDate["2026-09-30|Indexed Logs"]!.amount).toBe(2);
    // The running total restarts on the 1st.
    expect(byDate["2026-10-01|Infrastructure Hosts"]!.amount).toBe(3);
    expect(byDate["2026-10-03|Infrastructure Hosts"]!.amount).toBe(6);
    expect(byDate["2026-09-01|Infrastructure Hosts"]!.tags).toEqual({
      org: "Acme",
      pricing: "committed",
    });
    expect(rows.every((r) => r.currency === "USD" && r.region === "us")).toBe(true);
  });

  it("only emits days inside the range but differences from the 1st", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.searchParams.get("start_date") === "2026-09-01") {
        return {
          body: {
            data: [
              entry("2026-09-28", [["infra_host", "on_demand", 100]]),
              entry("2026-09-29", [["infra_host", "on_demand", 104]]),
            ],
          },
        };
      }
      return { body: { data: [] } };
    });
    const rows = await fetchDatadogCostData(
      ctxWith(http),
      { fromDate: "2026-09-29", toDate: "2026-10-04" },
      NOW,
    );
    expect(calls[0]!.url.searchParams.get("start_date")).toBe("2026-09-01");
    expect(rows).toEqual([
      {
        date: "2026-09-29",
        service: "Infrastructure Hosts",
        region: "us",
        tags: { org: "Acme", pricing: "on_demand" },
        currency: "USD",
        amount: 4,
      },
    ]);
  });

  it("backfills whole months before the estimated window from historical cost", async () => {
    const { http, calls } = makeHttp((url) => {
      expect(url.pathname).toBe("/api/v2/usage/historical_cost");
      return {
        body: {
          data: [
            entry("2026-07-01", [["apm_host", "total", 120]]),
            entry("2026-08-01", [["apm_host", "total", 130]], "Child"),
          ],
        },
      };
    });
    const rows = await fetchDatadogCostData(
      ctxWith(http),
      { fromDate: "2026-07-01", toDate: "2026-08-31" },
      NOW,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("start_month")).toBe("2026-07");
    expect(calls[0]!.url.searchParams.get("end_month")).toBe("2026-08");
    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "APM Hosts",
        region: "us",
        tags: { org: "Acme" },
        currency: "USD",
        amount: 120,
      },
      {
        date: "2026-08-01",
        service: "APM Hosts",
        region: "us",
        tags: { org: "Child" },
        currency: "USD",
        amount: 130,
      },
    ]);
  });

  it("never files a partial old month from an incremental window", async () => {
    const { http, calls } = makeHttp(() => ({ body: { data: [] } }));
    // 35-day restatement window ending today.
    await fetchDatadogCostData(
      ctxWith(http),
      { fromDate: "2026-08-30", toDate: "2026-10-04" },
      NOW,
    );
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v2/usage/estimated_cost",
      "/api/v2/usage/estimated_cost",
    ]);
  });

  it("explains a permission refusal as a setup step", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { errors: ["Forbidden"] } }));
    await expect(
      fetchDatadogCostData(ctxWith(http), { fromDate: "2026-10-01", toDate: "2026-10-03" }, NOW),
    ).rejects.toBeInstanceOf(CostSetupError);
  });

  it("returns nothing for a range entirely in the future", async () => {
    const { http, calls } = makeHttp(() => ({ body: { data: [] } }));
    const rows = await fetchDatadogCostData(
      ctxWith(http),
      { fromDate: "2026-11-01", toDate: "2026-11-30" },
      NOW,
    );
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("fetchDatadogCostSummary", () => {
  it("combines month-to-date and projected cost per org and product", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname.endsWith("/projected_cost")) {
        return {
          body: {
            data: [
              {
                type: "projected_cost",
                attributes: {
                  org_name: "Acme",
                  public_id: "pub-Acme",
                  region: "us",
                  projected_total_cost: 300,
                  charges: [
                    { product_name: "infra_host", charge_type: "projected_committed", cost: 200 },
                    { product_name: "infra_host", charge_type: "projected_on_demand", cost: 100 },
                    { product_name: "infra_host", charge_type: "total", cost: 300 },
                  ],
                },
              },
            ],
          },
        };
      }
      return {
        body: {
          data: [
            {
              ...entry("2026-10-01", [["infra_host", "committed", 80]]),
              attributes: {
                ...entry("2026-10-01", [["infra_host", "committed", 80]]).attributes,
                total_cost: 80,
              },
            },
          ],
        },
      };
    });
    const [org] = await fetchDatadogCostSummary(ctxWith(http));
    expect(org).toMatchObject({
      publicId: "pub-Acme",
      orgName: "Acme",
      monthToDate: 80,
      projected: 300,
      products: [{ product: "Infrastructure Hosts", monthToDate: 80, projected: 300 }],
    });
  });
});
