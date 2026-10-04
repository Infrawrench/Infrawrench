import { describe, expect, it } from "vitest";
import {
  TemporalCostCollector,
  amountsInCents,
  billingReportRows,
  csvRecords,
  estimateFromUsage,
  parseCsv,
  parseTags,
} from "../cost-data.js";
import { actionsCost, planCost, ratesFromCredentials } from "../pricing.js";
import { ctxWith, makeHttp } from "./helpers.js";

const HEADER =
  "BillingAccountID,BillingAccountName,BillingCurrency,BillingPeriodEnd,BillingPeriodStart,ChargeCategory,ChargeDescription,ChargeFrequency,ChargePeriodEnd,ChargePeriodStart,ContractedCost,ContractedUnitPrice,InvoiceID,InvoiceIssuer,PricingQuantity,PricingUnit,Provider,Publisher,ResourceID,ResourceName,ResourceType,ServiceCategory,ServiceName,ServiceSubcategory,SKUID,SKUMeter,Tags";

function row(o: Record<string, string>): string {
  const cols = HEADER.split(",");
  return cols
    .map((c) => {
      const v = o[c] ?? "";
      return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(",");
}

const CSV = [
  HEADER,
  row({
    BillingCurrency: "USD",
    ChargeCategory: "Usage",
    ChargeDescription: "Actions - Tier 1",
    ChargePeriodStart: "2026-10-01T00:00:00.000Z",
    ContractedCost: "100.00",
    ContractedUnitPrice: "50.00",
    PricingQuantity: "2",
    PricingUnit: "1 Million Actions",
    ResourceID: "prod.a2dd6",
    ResourceType: "Namespace",
    ServiceSubcategory: "Actions",
    SKUMeter: "Actions",
    Tags: '{"$tmprl_project":["p-1"],"team":["core"]}',
  }),
  row({
    BillingCurrency: "USD",
    ChargeCategory: "Usage",
    ChargeDescription: "Actions - Tier 2",
    ChargePeriodStart: "2026-10-01T00:00:00.000Z",
    ContractedCost: "45.00",
    ContractedUnitPrice: "45.00",
    PricingQuantity: "1",
    PricingUnit: "1 Million Actions",
    ResourceID: "prod.a2dd6",
    ResourceType: "Namespace",
    ServiceSubcategory: "Actions",
    SKUMeter: "Actions",
    Tags: '{"$tmprl_project":["p-1"],"team":["core"]}',
  }),
  row({
    BillingCurrency: "USD",
    ChargeCategory: "Usage",
    ChargeDescription: "Business plan",
    ChargePeriodStart: "2026-10-02T00:00:00.000Z",
    ContractedCost: "16.13",
    ServiceSubcategory: "Plan",
  }),
  row({
    BillingCurrency: "USD",
    ChargeCategory: "Credit",
    ChargeDescription: "Promotional credit",
    ChargePeriodStart: "2026-10-02T00:00:00.000Z",
    ContractedCost: "-20.00",
    ServiceSubcategory: "Credits",
  }),
].join("\r\n");

describe("CSV parsing", () => {
  it("handles quoted fields with commas, doubled quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("maps headers to records", () => {
    const recs = csvRecords(CSV);
    expect(recs).toHaveLength(4);
    expect(recs[0]?.["ResourceID"]).toBe("prod.a2dd6");
    expect(recs[0]?.["Tags"]).toContain("$tmprl_project");
  });

  it("parses tags, renaming the project tag", () => {
    expect(parseTags('{"$tmprl_project":["p-1"],"env":["prod","x"]}')).toEqual({
      temporal_project: "p-1",
      env: "prod",
    });
    expect(parseTags("not json")).toEqual({});
  });
});

describe("billingReportRows", () => {
  it("merges tiers into one row per namespace, service and day, with region and tags", () => {
    const rows = billingReportRows(
      CSV,
      new Map([["prod.a2dd6", { region: "aws-us-east-1" }]]),
      false,
    );
    const actions = rows.find((r) => r.service === "Actions");
    expect(actions).toMatchObject({
      date: "2026-10-01",
      resourceId: "prod.a2dd6",
      region: "aws-us-east-1",
      currency: "USD",
      amount: 145,
      usageAmount: 3,
      usageUnit: "1 Million Actions",
      tags: { temporal_project: "p-1", team: "core", cost_source: "billed" },
    });
    expect(actions?.chargeType).toBeUndefined();
    expect(rows.find((r) => r.service === "Plan")?.chargeType).toBe("support");
    expect(rows.find((r) => r.service === "Credits")).toMatchObject({
      chargeType: "credit",
      amount: -20,
    });
  });

  it("dates monthly reports to the first of the month", () => {
    const rows = billingReportRows(CSV, new Map(), true);
    expect(new Set(rows.map((r) => r.date))).toEqual(new Set(["2026-10-01"]));
  });

  it("detects amounts in cents from the unit price", () => {
    const cents = CSV.replace("100.00,50.00", "10000,5000");
    expect(amountsInCents(csvRecords(cents))).toBe(true);
    expect(amountsInCents(csvRecords(CSV))).toBe(false);
    const rows = billingReportRows(cents, new Map(), false);
    expect(rows.find((r) => r.service === "Actions")?.amount).toBeCloseTo(100.45);
  });
});

describe("pricing", () => {
  const business = ratesFromCredentials({});
  it("applies volume tiers across the month on Business", () => {
    // 11.25M actions: the pricing page's own worked example, $525.
    expect(actionsCost(0, 11_250_000, business)).toBeCloseTo(525);
    expect(actionsCost(5_000_000, 6_000_000, business)).toBeCloseTo(45);
  });

  it("is flat on Developer and with an override", () => {
    expect(actionsCost(0, 11_250_000, ratesFromCredentials({ plan: "developer" }))).toBeCloseTo(
      562.5,
    );
    expect(
      actionsCost(0, 2_000_000, ratesFromCredentials({ actionsPricePerMillion: "20" })),
    ).toBeCloseTo(40);
  });

  it("charges the greater of the Business minimum (pro rata) and 10%", () => {
    expect(planCost(6000, 31, 31, business)).toBeCloseTo(600);
    expect(planCost(100, 31, 31, business)).toBeCloseTo(500);
    expect(planCost(100, 10, 31, business)).toBeCloseTo(161.29, 1);
    expect(planCost(100, 31, 31, ratesFromCredentials({ plan: "enterprise" }))).toBe(0);
  });

  it("rejects a malformed rate", () => {
    expect(() => ratesFromCredentials({ activeStoragePricePerGbh: "cheap" })).toThrow();
  });
});

const GB_HOUR = 1e9 * 3600;

function usageRoute(url: URL) {
  if (url.pathname === "/cloud/usage") {
    return {
      body: {
        summaries: [
          {
            startTime: "2026-10-01T00:00:00Z",
            recordGroups: [
              {
                groupBys: [{ key: "GROUP_BY_KEY_NAMESPACE", value: "prod.a2dd6" }],
                records: [
                  { type: "RECORD_TYPE_ACTIONS", unit: "RECORD_UNIT_NUMBER", value: 1_000_000 },
                  {
                    type: "RECORD_TYPE_ACTIVE_STORAGE",
                    unit: "RECORD_UNIT_BYTE_SECONDS",
                    value: 10 * GB_HOUR,
                  },
                  {
                    type: "RECORD_TYPE_RETAINED_STORAGE",
                    unit: "RECORD_UNIT_BYTE_SECONDS",
                    value: 100 * GB_HOUR,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  }
  return { status: 404, body: {} };
}

describe("estimateFromUsage", () => {
  it("prices actions and storage per namespace and adds a plan row", async () => {
    const { http, calls } = makeHttp((url) => usageRoute(url));
    const rows = await estimateFromUsage(
      ctxWith(http),
      { fromDate: "2026-10-01", toDate: "2026-10-03" },
      ratesFromCredentials({ plan: "developer" }),
      new Map([["prod.a2dd6", { region: "aws-us-east-1", tags: { team: "core" } }]]),
      "2026-10-03",
    );
    expect(calls[0]?.url.searchParams.get("startTimeInclusive")).toBe("2026-10-01T00:00:00Z");
    expect(calls[0]?.url.searchParams.get("endTimeExclusive")).toBe("2026-10-04T00:00:00Z");
    const by = (s: string) => rows.find((r) => r.service === s);
    expect(by("Actions")?.amount).toBeCloseTo(50);
    expect(by("Active Storage")?.amount).toBeCloseTo(0.42);
    expect(by("Retained Storage")?.amount).toBeCloseTo(0.105);
    expect(by("Actions")?.tags).toEqual({ team: "core", cost_source: "estimated" });
    expect(by("Actions")?.region).toBe("aws-us-east-1");
    expect(by("Plan")).toMatchObject({ chargeType: "support" });
    expect(by("Plan")?.amount).toBeCloseTo(5.0525);
  });

  it("returns nothing outside the 90-day usage window", async () => {
    const { http, calls } = makeHttp((url) => usageRoute(url));
    const rows = await estimateFromUsage(
      ctxWith(http),
      { fromDate: "2026-01-01", toDate: "2026-01-31" },
      ratesFromCredentials({}),
      new Map(),
      "2026-10-03",
    );
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

const FAST = { timeoutMs: 1000, initialPollMs: 1, maxPollMs: 2 };

describe("TemporalCostCollector", () => {
  it("generates one daily report per pass and filters it per chunk", async () => {
    let created = 0;
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === "/cloud/billing-reports" && method === "POST") {
        created++;
        return { body: { billingReportId: "br-1" } };
      }
      if (url.pathname === "/cloud/billing-reports/br-1") {
        return {
          body: {
            billingReport: {
              id: "br-1",
              state: "BILLING_REPORT_STATE_GENERATED",
              downloadInfo: [{ url: "https://download.example/report.csv" }],
            },
          },
        };
      }
      if (url.host === "download.example") return { text: CSV };
      return { status: 404, body: {} };
    });
    const collector = new TemporalCostCollector(
      ctxWith(http),
      ratesFromCredentials({}),
      async () => new Map(),
      FAST,
      () => new Date("2026-10-15T12:00:00Z"),
    );
    const a = await collector.fetch({ fromDate: "2026-09-10", toDate: "2026-09-30" });
    const b = await collector.fetch({ fromDate: "2026-10-01", toDate: "2026-10-15" });
    expect(a).toEqual([]);
    expect(b.length).toBeGreaterThan(0);
    expect(created).toBe(1);
    const create = calls.find((c) => c.method === "POST");
    expect(create?.body).toMatchObject({
      spec: {
        startTimeInclusive: "2026-08-01T00:00:00Z",
        endTimeExclusive: "2026-11-01T00:00:00Z",
        granularity: "BILLING_REPORT_GRANULARITY_DAILY",
      },
    });
    expect(create?.headers["Authorization"]).toBe("Bearer api-key");
  });

  it("falls back to estimated usage when the key cannot create reports", async () => {
    const { http } = makeHttp((url, method) => {
      if (url.pathname === "/cloud/billing-reports" && method === "POST") {
        return { status: 403, body: { message: "permission denied" } };
      }
      return usageRoute(url);
    });
    const collector = new TemporalCostCollector(
      ctxWith(http),
      ratesFromCredentials({}),
      async () => new Map(),
      FAST,
      () => new Date("2026-10-03T12:00:00Z"),
    );
    const rows = await collector.fetch({ fromDate: "2026-10-01", toDate: "2026-10-03" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tags?.["cost_source"] === "estimated")).toBe(true);
  });

  it("uses a monthly report for months older than the daily window", async () => {
    const bodies: unknown[] = [];
    const { http } = makeHttp((url, method, body) => {
      if (url.pathname === "/cloud/billing-reports" && method === "POST") {
        bodies.push(body);
        return { body: { billingReportId: `br-${bodies.length}` } };
      }
      if (url.pathname.startsWith("/cloud/billing-reports/")) {
        return {
          body: {
            billingReport: {
              state: "BILLING_REPORT_STATE_GENERATED",
              downloadInfo: [{ url: "https://download.example/r.csv" }],
            },
          },
        };
      }
      return { text: HEADER };
    });
    const collector = new TemporalCostCollector(
      ctxWith(http),
      ratesFromCredentials({}),
      async () => new Map(),
      FAST,
      () => new Date("2026-10-15T12:00:00Z"),
    );
    await collector.fetch({ fromDate: "2026-03-01", toDate: "2026-03-31" });
    await collector.fetch({ fromDate: "2026-04-01", toDate: "2026-04-30" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      spec: {
        startTimeInclusive: "2026-03-01T00:00:00Z",
        endTimeExclusive: "2026-08-01T00:00:00Z",
        granularity: "BILLING_REPORT_GRANULARITY_MONTHLY",
      },
    });
  });
});
