import { describe, expect, it } from "vitest";
import { CostSetupError, CreditAccessError } from "@infrawrench/plugin-base";
import {
  aggregateCostRows,
  clusterTypeOf,
  fetchAnyscaleCostData,
  usageRowToCost,
} from "../cost-data.js";
import { creditBalances, fetchCredits } from "../credits.js";
import { makeHttp } from "./helpers.js";

const clouds = new Map([
  ["cld_byoc", { name: "prod-aws", region: "us-west-2", hosting: "customer-cloud" as const }],
  [
    "cld_hosted",
    { name: "Anyscale Cloud", region: "us-east-2", hosting: "anyscale-hosted" as const },
  ],
]);

describe("clusterTypeOf", () => {
  it("names the workload from whichever id the row carries", () => {
    expect(clusterTypeOf({ workspace_id: "expwrk_1" })).toBe("Workspace");
    expect(clusterTypeOf({ service_id: "service2_1" })).toBe("Service");
    expect(clusterTypeOf({ job_id: "prodjob_1" })).toBe("Job");
    expect(clusterTypeOf({})).toBe("Cluster");
  });
});

describe("usageRowToCost", () => {
  it("maps dimensions, tags and credits", () => {
    const row = usageRowToCost(
      {
        date: "2026-10-01",
        dollar_value: 12.5,
        anyscale_credits: 12.5,
        cloud_id: "cld_byoc",
        cloud_name: "prod-aws",
        project_name: "ml",
        user_email: "a@example.com",
        job_id: "prodjob_1",
        job_name: "nightly-train",
        cluster_id: "ses_1",
      },
      clouds,
    );
    expect(row).toEqual({
      date: "2026-10-01",
      service: "Job",
      region: "us-west-2",
      resourceId: "prodjob_1",
      tags: {
        clusterType: "job",
        project: "ml",
        cloud: "prod-aws",
        user: "a@example.com",
        workload: "nightly-train",
        hosting: "customer-cloud",
      },
      currency: "USD",
      amount: 12.5,
      usageAmount: 12.5,
      usageUnit: "Anyscale credits",
    });
  });

  it("drops empty rows and rows without a date", () => {
    expect(usageRowToCost({ date: "2026-10-01", dollar_value: 0 }, clouds)).toBeNull();
    expect(usageRowToCost({ dollar_value: 3 }, clouds)).toBeNull();
  });
});

describe("aggregateCostRows", () => {
  it("sums rows that share every dimension", () => {
    const base = { date: "2026-10-01", service: "Workspace", currency: "USD", tags: { a: "b" } };
    expect(
      aggregateCostRows([
        { ...base, amount: 1, usageAmount: 1, usageUnit: "Anyscale credits" },
        { ...base, amount: 2, usageAmount: 2, usageUnit: "Anyscale credits" },
      ]),
    ).toEqual([{ ...base, amount: 3, usageAmount: 3, usageUnit: "Anyscale credits" }]);
  });
});

describe("fetchAnyscaleCostData", () => {
  it("pages the per-cluster usage route and authenticates with the cli_token cookie", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/v2/aggregated_instance_usage/cluster") {
        const token = url.searchParams.get("paging_token");
        return {
          body: token
            ? {
                results: [
                  {
                    date: "2026-10-02",
                    dollar_value: 4,
                    workspace_id: "w1",
                    cloud_id: "cld_hosted",
                  },
                ],
                metadata: {},
              }
            : {
                results: [
                  { date: "2026-10-01", dollar_value: 3, service_id: "s1", cloud_id: "cld_hosted" },
                  { date: "2026-09-30", dollar_value: 9, service_id: "s1" },
                ],
                metadata: { next_paging_token: "p2" },
              },
        };
      }
      if (url.pathname === "/api/v2/clouds/") {
        return {
          body: {
            results: [{ id: "cld_hosted", name: "Hosted", region: "us-east-2", is_aioa: true }],
          },
        };
      }
      return { status: 404 };
    });
    const rows = await fetchAnyscaleCostData(
      { apiKey: "key_1", http },
      { fromDate: "2026-10-01", toDate: "2026-10-02" },
    );
    expect(rows.map((r) => [r.date, r.service, r.amount, r.tags?.["hosting"]])).toEqual([
      ["2026-10-01", "Service", 3, "anyscale-hosted"],
      ["2026-10-02", "Workspace", 4, "anyscale-hosted"],
    ]);
    const usage = calls.filter((c) => c.url.pathname.endsWith("/cluster"));
    expect(usage).toHaveLength(2);
    expect(usage[0]!.method).toBe("POST");
    expect(usage[0]!.body).toMatchObject({
      start_date: "2026-10-01",
      end_date: "2026-10-02",
      group_by_date: true,
    });
    expect(usage[0]!.headers["Cookie"]).toBe("cli_token=key_1");
  });

  it("explains the owner requirement on a 403", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { error: "forbidden" } }));
    await expect(
      fetchAnyscaleCostData(
        { apiKey: "k", http },
        { fromDate: "2026-10-01", toDate: "2026-10-01" },
      ),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("credits", () => {
  it("reports one balance per in-use grant or commit", () => {
    const balances = creditBalances({
      in_use_credits: [
        {
          credit_name: "Trial",
          total_balance_usd: 40,
          total_granted_usd: 100,
          effective_date_start: "2026-09-01",
          effective_date_end: "2026-12-31",
        },
      ],
      in_use_commits: [
        { credit_name: "2026 commit", contract_name: "MSA", total_balance_usd: 9000 },
      ],
      expired_credits: [{ credit_name: "Old", total_balance_usd: 5 }],
    });
    expect(balances).toEqual([
      {
        key: "credit:Trial:2026-09-01",
        label: "Trial",
        remaining: 40,
        currency: "USD",
        granted: 100,
        expiresAt: "2026-12-31T23:59:59Z",
      },
      {
        key: "commit:2026 commit:",
        label: "2026 commit (MSA)",
        remaining: 9000,
        currency: "USD",
      },
    ]);
  });

  it("returns nothing for a pay-as-you-go organization", () => {
    expect(creditBalances({ current_balance_usd: 0 })).toEqual([]);
  });

  it("raises CreditAccessError for a non-owner key", async () => {
    const { http } = makeHttp(() => ({ status: 403 }));
    await expect(fetchCredits({ apiKey: "k", http })).rejects.toBeInstanceOf(CreditAccessError);
  });
});
