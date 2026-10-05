import { afterEach, describe, expect, it, vi } from "vitest";
import { MetronomeClient } from "../client.js";
import { installFetch, jsonResponse } from "./helpers.js";

const ACCOUNT = "acct-1";

function client() {
  return new MetronomeClient({ apiToken: "mtr-test" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listResources", () => {
  it("pages through customers with limit=100 and maps them", async () => {
    const calls = installFetch((_route, url) => {
      if (!url.searchParams.get("next_page")) {
        return jsonResponse({
          data: [
            {
              id: "c1",
              name: "Acme",
              ingest_aliases: ["acme@example.com"],
              customer_config: { salesforce_account_id: "0015500001WO1ZiABL" },
              custom_fields: { tier: "gold, annual" },
              created_at: "2024-01-01T00:00:00.000Z",
              updated_at: "2024-02-01T00:00:00.000Z",
            },
          ],
          next_page: "next",
        });
      }
      return jsonResponse({
        data: [{ id: "c2", name: "", ingest_aliases: ["globex"], custom_fields: {} }],
        next_page: null,
      });
    });

    const customers = await client().listResources("customer", ACCOUNT);

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.metronome.com/v1/customers?limit=100",
      "https://api.metronome.com/v1/customers?limit=100&next_page=next",
    ]);
    expect(customers.map((c) => c.displayName)).toEqual(["Acme", "globex"]);
    expect(customers[0]!.id).toBe(`${ACCOUNT}:customer:c1`);
    expect(customers[0]!.fields["salesforceAccountId"]).toBe("0015500001WO1ZiABL");

    const detail = client().renderDetail(customers[0]!);
    const table = detail.sections
      .find((s) => s.title === "Custom Fields")!
      .children.find((n) => n.kind === "table");
    expect(table && table.kind === "table" && table.rows[0]!.cells).toEqual({
      key: "tier",
      value: "gold, annual",
    });
  });

  it("maps billable metrics with their aggregation and filters", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "m1",
            name: "data transfer (GB)",
            aggregation_type: "sum",
            aggregation_key: "bytes",
            event_type_filter: { in_values: ["transfer"] },
            property_filters: [{ name: "region", exists: true, in_values: ["EU", "NA"] }],
            group_keys: [["region"], ["machine_type"]],
          },
        ],
        next_page: null,
      }),
    );
    const [metric] = await client().listResources("billable-metric", ACCOUNT);
    expect(metric!.fields["aggregationType"]).toBe("SUM");
    expect(metric!.fields["groupKeys"]).toBe("region, machine_type");
    const detail = client().renderDetail(metric!);
    expect(detail.sections.map((s) => s.title)).toEqual(["Billable Metric", "Property Filters"]);
  });
});

describe("enrichDetail", () => {
  it("adds recent invoices to a customer and renders totals in whole currency units", async () => {
    const calls = installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "inv1",
            customer_id: "c1",
            type: "USAGE",
            status: "FINALIZED",
            total: 14_392,
            credit_type: { id: "usd", name: "USD (cents)" },
            start_timestamp: "2026-08-01T00:00:00Z",
            end_timestamp: "2026-09-01T00:00:00Z",
          },
        ],
        next_page: null,
      }),
    );
    const base = {
      id: `${ACCOUNT}:customer:c1`,
      pluginId: "metronome",
      resourceTypeId: "customer",
      accountId: ACCOUNT,
      displayName: "Acme",
      externalId: "c1",
      fields: { customerId: "c1", name: "Acme" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const enriched = await client().enrichDetail(base);
    expect(calls[0]!.url).toBe(
      "https://api.metronome.com/v1/customers/c1/invoices?limit=10&sort=date_desc",
    );
    const section = client()
      .renderDetail(enriched)
      .sections.find((s) => s.title === "Recent Invoices")!;
    const table = section.children[0]!;
    expect(table.kind === "table" && table.rows[0]!.cells).toEqual({
      period: "2026-08-01 to 2026-09-01",
      type: "USAGE",
      status: "FINALIZED",
      total: "143.92 USD",
    });
  });
});
