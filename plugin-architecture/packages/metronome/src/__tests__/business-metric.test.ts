import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessMetricSourceRange } from "@infrawrench/plugin-base";
import { MetronomeClient } from "../client.js";
import { isUtcAligned, useHourlyWindows } from "../business-metric.js";
import { plugin } from "../plugin.js";
import { installFetch, jsonResponse } from "./helpers.js";

const ACCOUNT = "acct-1";
const METRIC = "9570e4f3-d1da-4b95-ba81-bd40ee002727";
const USD = "2714e483-4ff1-48e4-9e25-ac732e8f24f2";
const EUR = "11111111-2222-3333-4444-555555555555";
const C1 = "d7abd0cd-4ae9-4db7-8676-e986a4ebd8dc";
const C2 = "617e39d8-68f4-4592-b8d2-c2bf26a76989";
const C3 = "aaaaaaaa-0000-0000-0000-000000000003";

function client() {
  return new MetronomeClient({ apiToken: "mtr-test" });
}

function range(overrides: Partial<BusinessMetricSourceRange> = {}): BusinessMetricSourceRange {
  return {
    from: "2026-09-01",
    to: "2026-09-02",
    timezone: "UTC",
    maxRows: 50_000,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function usageRow(customer: string, start: string, end: string, value: number | null) {
  return {
    customer_id: customer,
    billable_metric_id: METRIC,
    billable_metric_name: "API calls",
    start_timestamp: start,
    end_timestamp: end,
    value,
  };
}

const CUSTOMERS = [
  { id: C1, name: "Acme", ingest_aliases: ["acme"], custom_fields: {} },
  { id: C2, name: "Globex", ingest_aliases: [], custom_fields: {} },
];
const ARCHIVED = [{ id: C3, name: "Initech", ingest_aliases: [], custom_fields: {} }];

function customersRoute(url: URL) {
  return jsonResponse({
    data: url.searchParams.get("only_archived") === "true" ? ARCHIVED : CUSTOMERS,
    next_page: null,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("declaration", () => {
  it("declares a read-only metric source with the documented field keys", () => {
    const source = plugin.manifest.businessMetricSource!;
    expect(source.kind).toBe("metric");
    expect(source.readOnly).toBe("enforced");
    expect(source.fields.map((f) => f.key)).toEqual([
      "measure",
      "billableMetric",
      "creditType",
      "customer",
      "groupByCustomer",
    ]);
  });
});

describe("usage", () => {
  it("queries day windows in UTC, follows next_page and sums customers into one value per day", async () => {
    const calls = installFetch((route, url) => {
      if (route === `GET /v1/billable-metrics/${METRIC}`) {
        return jsonResponse({ data: { id: METRIC, name: "API calls", aggregation_type: "SUM" } });
      }
      if (route === "POST /v1/usage" && !url.searchParams.get("next_page")) {
        return jsonResponse({
          data: [
            usageRow(C1, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", 10),
            usageRow(C2, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", 5),
          ],
          next_page: "cursor-2",
        });
      }
      if (route === "POST /v1/usage") {
        return jsonResponse({
          data: [
            usageRow(C1, "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", 7),
            usageRow(C2, "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", null),
          ],
          next_page: null,
        });
      }
      throw new Error(`unexpected ${route}`);
    });

    const result = await client().runBusinessMetricSource(
      ACCOUNT,
      { measure: "usage", billableMetric: METRIC, customer: "", groupByCustomer: "no" },
      range(),
    );

    expect(result.points).toEqual([
      { date: "2026-09-01", value: 15 },
      { date: "2026-09-02", value: 7 },
    ]);
    const usageCalls = calls.filter((c) => c.url.includes("/v1/usage"));
    expect(usageCalls).toHaveLength(2);
    expect(usageCalls[0]!.url).toBe("https://api.metronome.com/v1/usage");
    expect(usageCalls[1]!.url).toBe("https://api.metronome.com/v1/usage?next_page=cursor-2");
    expect(usageCalls[0]!.body).toEqual({
      window_size: "day",
      starting_on: "2026-09-01T00:00:00Z",
      ending_before: "2026-09-03T00:00:00Z",
      billable_metrics: [{ id: METRIC }],
    });
    expect(usageCalls[0]!.headers["Authorization"]).toBe("Bearer mtr-test");
  });

  it("filters to one customer and labels each point with the customer name when broken down", async () => {
    const calls = installFetch((route, url) => {
      if (route === `GET /v1/billable-metrics/${METRIC}`) {
        return jsonResponse({ data: { id: METRIC, name: "API calls", aggregation_type: "COUNT" } });
      }
      if (route === "GET /v1/customers") return customersRoute(url);
      if (route === "POST /v1/usage") {
        return jsonResponse({
          data: [
            usageRow(C3, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", 4),
            usageRow(
              "ffffffff-0000-0000-0000-000000000000",
              "2026-09-01T00:00:00Z",
              "2026-09-02T00:00:00Z",
              1,
            ),
          ],
          next_page: null,
        });
      }
      throw new Error(`unexpected ${route}`);
    });

    const result = await client().runBusinessMetricSource(
      ACCOUNT,
      { measure: "usage", billableMetric: METRIC, customer: C3, groupByCustomer: "yes" },
      range({ to: "2026-09-01" }),
    );

    expect(result.points).toEqual([
      { date: "2026-09-01", value: 1, label: "Customer ffffffff" },
      { date: "2026-09-01", value: 4, label: "Initech" },
    ]);
    const usage = calls.find((c) => c.url.includes("/v1/usage"))!;
    expect((usage.body as Record<string, unknown>)["customer_ids"]).toEqual([C3]);
    // Archived customers are looked up too: they keep their usage history.
    expect(calls.some((c) => c.url.includes("only_archived=true"))).toBe(true);
  });

  it("reads hourly windows and sums them into local days for an additive metric outside UTC", async () => {
    const calls = installFetch((route) => {
      if (route === `GET /v1/billable-metrics/${METRIC}`) {
        return jsonResponse({ data: { id: METRIC, name: "API calls", aggregation_type: "sum" } });
      }
      if (route === "POST /v1/usage") {
        return jsonResponse({
          data: [
            // 03:00Z on Sep 1 is 23:00 on Aug 31 in New York: outside the window.
            usageRow(C1, "2026-09-01T03:00:00Z", "2026-09-01T04:00:00Z", 100),
            // 04:00Z is local midnight on Sep 1.
            usageRow(C1, "2026-09-01T04:00:00Z", "2026-09-01T05:00:00Z", 2),
            usageRow(C1, "2026-09-02T03:00:00Z", "2026-09-02T04:00:00Z", 3),
            // 04:00Z on Sep 2 is Sep 2 local, past `to`.
            usageRow(C1, "2026-09-02T04:00:00Z", "2026-09-02T05:00:00Z", 50),
          ],
          next_page: null,
        });
      }
      throw new Error(`unexpected ${route}`);
    });

    const result = await client().runBusinessMetricSource(
      ACCOUNT,
      { measure: "usage", billableMetric: METRIC, groupByCustomer: "no" },
      range({ from: "2026-09-01", to: "2026-09-01", timezone: "America/New_York" }),
    );

    expect(result.points).toEqual([{ date: "2026-09-01", value: 5 }]);
    const body = calls.find((c) => c.url.includes("/v1/usage"))!.body as Record<string, unknown>;
    expect(body["window_size"]).toBe("hour");
    // Widened to the enclosing UTC midnights, which is all the API accepts.
    expect(body["starting_on"]).toBe("2026-09-01T00:00:00Z");
    expect(body["ending_before"]).toBe("2026-09-03T00:00:00Z");
  });

  it("keeps day windows for an aggregation that does not add up across hours", async () => {
    const calls = installFetch((route) => {
      if (route === `GET /v1/billable-metrics/${METRIC}`) {
        return jsonResponse({ data: { id: METRIC, name: "Seats", aggregation_type: "MAX" } });
      }
      if (route === "POST /v1/usage") {
        return jsonResponse({
          data: [usageRow(C1, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", 12)],
          next_page: null,
        });
      }
      throw new Error(`unexpected ${route}`);
    });

    const result = await client().runBusinessMetricSource(
      ACCOUNT,
      { measure: "usage", billableMetric: METRIC },
      range({ to: "2026-09-01", timezone: "Asia/Tokyo" }),
    );
    expect(result.points).toEqual([{ date: "2026-09-01", value: 12 }]);
    const body = calls.find((c) => c.url.includes("/v1/usage"))!.body as Record<string, unknown>;
    expect(body["window_size"]).toBe("day");
  });

  it("throws rather than truncating when the run exceeds maxRows", async () => {
    installFetch((route) => {
      if (route === `GET /v1/billable-metrics/${METRIC}`) {
        return jsonResponse({ data: { id: METRIC, name: "API calls", aggregation_type: "SUM" } });
      }
      return jsonResponse({
        data: [
          usageRow(C1, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", 1),
          usageRow(C1, "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", 1),
        ],
        next_page: null,
      });
    });
    await expect(
      client().runBusinessMetricSource(
        ACCOUNT,
        { measure: "usage", billableMetric: METRIC },
        range({ maxRows: 1 }),
      ),
    ).rejects.toThrow(/more than 1 daily values/);
  });

  it("requires a billable metric", async () => {
    installFetch(() => jsonResponse({}));
    await expect(
      client().runBusinessMetricSource(ACCOUNT, { measure: "usage" }, range()),
    ).rejects.toThrow(/Pick a billable metric/);
  });

  it("fails the run on an API error", async () => {
    installFetch(() => jsonResponse({ message: "Unauthorized" }, 401));
    await expect(
      client().runBusinessMetricSource(
        ACCOUNT,
        { measure: "usage", billableMetric: METRIC },
        range(),
      ),
    ).rejects.toThrow(/Metronome API error 401/);
  });

  it("gives up at the timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((() => new Promise(() => {})) as typeof fetch);
    await expect(
      client().runBusinessMetricSource(
        ACCOUNT,
        { measure: "usage", billableMetric: METRIC },
        range({ timeoutMs: 20 }),
      ),
    ).rejects.toThrow(/did not answer/);
  });
});

describe("revenue", () => {
  function breakdown(
    customer: string,
    day: string,
    total: number,
    creditType = { id: USD, name: "USD (cents)" },
    status = "FINALIZED",
  ) {
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
    return {
      id: `inv-${customer}`,
      customer_id: customer,
      type: "USAGE",
      status,
      credit_type: creditType,
      total,
      breakdown_start_timestamp: `${day}T00:00:00Z`,
      breakdown_end_timestamp: next,
    };
  }

  it("sums daily invoice breakdowns across every customer, in dollars, skipping void invoices", async () => {
    const calls = installFetch((route, url) => {
      if (route === "GET /v1/customers") return customersRoute(url);
      if (route === `GET /v1/customers/${C1}/invoices/breakdowns`) {
        if (!url.searchParams.get("next_page")) {
          return jsonResponse({ data: [breakdown(C1, "2026-09-01", 12_345)], next_page: "p2" });
        }
        return jsonResponse({
          data: [
            breakdown(C1, "2026-09-02", 500),
            breakdown(C1, "2026-09-02", 999_999, undefined, "VOID"),
          ],
          next_page: null,
        });
      }
      if (route === `GET /v1/customers/${C2}/invoices/breakdowns`) {
        return jsonResponse({ data: [breakdown(C2, "2026-09-01", 1_000)], next_page: null });
      }
      if (route === `GET /v1/customers/${C3}/invoices/breakdowns`) {
        return jsonResponse({ data: [], next_page: null });
      }
      throw new Error(`unexpected ${route}`);
    });

    const result = await client().runBusinessMetricSource(
      ACCOUNT,
      { measure: "revenue", creditType: USD, customer: "", groupByCustomer: "no" },
      range(),
    );

    expect(result.points).toEqual([
      { date: "2026-09-01", value: 133.45 },
      { date: "2026-09-02", value: 5 },
    ]);
    const first = new URL(calls.find((c) => c.url.includes(`${C1}/invoices/breakdowns`))!.url);
    expect(first.searchParams.get("window_size")).toBe("day");
    expect(first.searchParams.get("starting_on")).toBe("2026-09-01T00:00:00Z");
    expect(first.searchParams.get("ending_before")).toBe("2026-09-03T00:00:00Z");
    expect(first.searchParams.get("credit_type_id")).toBe(USD);
    expect(result.notes?.[0]).toContain("3 customers in USD");
  });

  it("keeps whole-unit currencies as they are and labels per customer", async () => {
    installFetch((route) => {
      if (route === `GET /v1/customers/${C2}`) return jsonResponse({ data: CUSTOMERS[1] });
      if (route === `GET /v1/customers/${C2}/invoices/breakdowns`) {
        return jsonResponse({
          data: [breakdown(C2, "2026-09-01", 40, { id: EUR, name: "EUR" })],
          next_page: null,
        });
      }
      throw new Error(`unexpected ${route}`);
    });

    const result = await client().runBusinessMetricSource(
      ACCOUNT,
      { measure: "revenue", creditType: EUR, customer: C2, groupByCustomer: "yes" },
      range(),
    );
    expect(result.points).toEqual([{ date: "2026-09-01", value: 40, label: "Globex" }]);
  });
});

describe("options", () => {
  it("lists customers after an All customers choice", async () => {
    installFetch((route, url) => {
      if (route === "GET /v1/customers") return customersRoute(url);
      throw new Error(`unexpected ${route}`);
    });
    const options = await client().listBusinessMetricSourceOptions(ACCOUNT, "customer", {
      measure: "usage",
    });
    expect(options.map((o) => [o.id, o.label])).toEqual([
      ["", "All customers"],
      [C1, "Acme"],
      [C2, "Globex"],
    ]);
  });

  it("lists billable metrics for usage and nothing for revenue", async () => {
    installFetch((route) => {
      if (route === "GET /v1/billable-metrics") {
        return jsonResponse({
          data: [
            {
              id: METRIC,
              name: "Data transfer",
              aggregation_type: "SUM",
              aggregation_key: "bytes",
            },
            { id: "m2", name: "API calls", aggregation_type: "COUNT" },
          ],
          next_page: null,
        });
      }
      throw new Error(`unexpected ${route}`);
    });
    const usage = await client().listBusinessMetricSourceOptions(ACCOUNT, "billableMetric", {
      measure: "usage",
    });
    expect(usage).toEqual([
      { id: "m2", label: "API calls", description: "COUNT" },
      { id: METRIC, label: "Data transfer", description: "SUM of bytes" },
    ]);
    const revenue = await client().listBusinessMetricSourceOptions(ACCOUNT, "billableMetric", {
      measure: "revenue",
    });
    expect(revenue).toEqual([{ id: "", label: "Not used for revenue" }]);
  });

  it("lists pricing units for revenue", async () => {
    installFetch((route) => {
      if (route === "GET /v1/credit-types/list") {
        return jsonResponse({
          data: [
            { id: USD, name: "USD (cents)", is_currency: true },
            { id: "cu", name: "cloud consumption units", is_currency: false },
          ],
          next_page: null,
        });
      }
      throw new Error(`unexpected ${route}`);
    });
    const options = await client().listBusinessMetricSourceOptions(ACCOUNT, "creditType", {
      measure: "revenue",
    });
    expect(options.map((o) => [o.id, o.label])).toEqual([
      ["cu", "cloud consumption units"],
      [USD, "USD"],
    ]);
  });
});

describe("window helpers", () => {
  it("treats UTC as aligned and New York as not", () => {
    expect(isUtcAligned({ from: "2026-09-01", to: "2026-09-03", timezone: "UTC" })).toBe(true);
    expect(
      isUtcAligned({ from: "2026-09-01", to: "2026-09-03", timezone: "America/New_York" }),
    ).toBe(false);
  });

  it("only uses hourly windows for additive metrics", () => {
    expect(useHourlyWindows("SUM", false)).toBe(true);
    expect(useHourlyWindows("count", false)).toBe(true);
    expect(useHourlyWindows("UNIQUE", false)).toBe(false);
    expect(useHourlyWindows(undefined, false)).toBe(false);
    expect(useHourlyWindows("SUM", true)).toBe(false);
  });
});
