import { describe, expect, it, vi } from "vitest";
import { CrusoeApi, CrusoeApiError } from "../api.js";
import {
  aggregateRows,
  detectColumns,
  fetchCrusoeCostData,
  mapIntelligenceCosts,
  parseBillingCsv,
  parseCsvDate,
  parseMoney,
} from "../cost-data.js";
import { normalizeHeader, parseCsv } from "../csv.js";

const ctx = {
  organizationId: "org-1",
  organizationName: "Acme",
  projectNames: new Map([["p-1", "training"]]),
  multipleOrgs: false,
};

describe("csv", () => {
  it("parses quotes, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n3,4')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["3", "4"],
    ]);
  });

  it("normalises header spellings", () => {
    expect(normalizeHeader("Product Line")).toBe("product_line");
    expect(normalizeHeader("productLine")).toBe("product_line");
    expect(normalizeHeader("Cost (USD)")).toBe("cost");
  });
});

describe("column detection", () => {
  it("finds columns by name, not position", () => {
    const cols = detectColumns(["Region", "Cost (USD)", "Date", "Product Line", "Project ID"]);
    expect(cols).toMatchObject({ region: 0, cost: 1, date: 2, product: 3, project: 4 });
  });

  it("parses dates and money in the common spellings", () => {
    expect(parseCsvDate("2026-03-04T00:00:00Z")).toBe("2026-03-04");
    expect(parseCsvDate("3/4/2026")).toBe("2026-03-04");
    expect(parseCsvDate("soon")).toBeNull();
    expect(parseMoney("$1,234.50")).toBe(1234.5);
    expect(parseMoney("(12.00)")).toBe(-12);
    expect(parseMoney("")).toBeNaN();
  });
});

describe("parseBillingCsv", () => {
  it("maps rows to cost rows with project names as tags", () => {
    const csv = [
      "Date,Project ID,Product Line,Region,Resource ID,Resource Name,Quantity,Unit,Cost",
      "2026-09-01,p-1,h100-80gb-sxm-ib,us-east1,vm-1,trainer,24,instance-hours,$1,200.00",
    ].join("\n");
    const out = parseBillingCsv(csv.replace("$1,200.00", '"$1,200.00"'), ctx);
    expect(out.hasDateColumn).toBe(true);
    expect(out.rows).toEqual([
      {
        date: "2026-09-01",
        service: "h100-80gb-sxm-ib",
        region: "us-east1",
        resourceId: "p-1/vm-1",
        tags: { project: "training", resource_name: "trainer" },
        currency: "USD",
        amount: 1200,
        usageAmount: 24,
        usageUnit: "instance-hours",
      },
    ]);
  });

  it("refuses a CSV with rows but no cost column, naming the headers", () => {
    expect(() => parseBillingCsv("Date,Thing\n2026-01-01,x", ctx)).toThrow(/headers: Date, Thing/);
  });

  it("reports a missing date column so the caller can ask day by day", () => {
    const out = parseBillingCsv("Product,Cost\nl40s,5", ctx);
    expect(out).toEqual({ rows: [], hasDateColumn: false });
    const dated = parseBillingCsv("Product,Cost\nl40s,5", { ...ctx, fallbackDate: "2026-02-02" });
    expect(dated.rows[0]).toMatchObject({ date: "2026-02-02", service: "l40s", amount: 5 });
  });

  it("treats a header-only export as no spend", () => {
    expect(parseBillingCsv("Date,Cost\n", ctx).rows).toEqual([]);
    expect(parseBillingCsv("", ctx).rows).toEqual([]);
  });
});

describe("intelligence billing", () => {
  it("keeps rows inside the range only", () => {
    const rows = mapIntelligenceCosts(
      {
        data: [
          { date: "2026-08-31", cost: 1, resource_type: "llama" },
          {
            date: "2026-09-01",
            cost: 2.5,
            resource_type: "llama",
            project_id: "p-1",
            quantity: 10,
          },
        ],
      },
      { fromDate: "2026-09-01", toDate: "2026-09-30" },
      ctx,
    );
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        service: "Serverless Inference",
        tags: { project: "training", model: "llama" },
        currency: "USD",
        amount: 2.5,
        usageAmount: 10,
      },
    ]);
  });
});

describe("aggregateRows", () => {
  it("sums rows that share a host key", () => {
    const out = aggregateRows([
      { date: "2026-01-01", service: "a", currency: "USD", amount: 1.1, usageAmount: 1 },
      { date: "2026-01-01", service: "a", currency: "USD", amount: 2.2, usageAmount: 2 },
      { date: "2026-01-01", service: "b", currency: "USD", amount: 5 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ amount: 3.3, usageAmount: 3 });
  });
});

function fakeApi(handlers: Record<string, (q: unknown) => string | Error>): CrusoeApi {
  const api = new CrusoeApi(
    { accessKeyId: "a", secretKey: "c2VjcmV0", monitoringToken: "", caCert: "" },
    undefined,
  );
  vi.spyOn(api, "requestText").mockImplementation(async (path, opts) => {
    const h = handlers[path];
    if (!h) throw new CrusoeApiError(404, path, "{}");
    const out = h(opts?.query);
    if (out instanceof Error) throw out;
    return out;
  });
  return api;
}

describe("fetchCrusoeCostData", () => {
  const range = { fromDate: "2026-09-01", toDate: "2026-09-02" };

  it("combines the CSV export with intelligence billing", async () => {
    const api = fakeApi({
      "/organizations/org-1/billing/export-productline": () =>
        "Date,Product Line,Cost\n2026-09-01,a40,3",
      "/organizations/org-1/billing/costs": () =>
        JSON.stringify({ data: [{ date: "2026-09-02", cost: 1, resource_type: "m" }] }),
    });
    const rows = await fetchCrusoeCostData(api, [{ id: "org-1", name: "Acme" }], new Map(), range);
    expect(rows.map((r) => [r.date, r.service, r.amount])).toEqual([
      ["2026-09-01", "a40", 3],
      ["2026-09-02", "Serverless Inference", 1],
    ]);
  });

  it("falls back to one request per day when the export has no date column", async () => {
    const days: string[] = [];
    const api = fakeApi({
      "/organizations/org-1/billing/export-productline": (q) => {
        const query = q as { start_date: string; end_date: string };
        if (query.start_date !== query.end_date) return "Product,Cost\na40,9";
        days.push(query.start_date);
        return "Product,Cost\na40,4";
      },
    });
    const rows = await fetchCrusoeCostData(api, [{ id: "org-1" }], new Map(), range);
    expect(days).toEqual(["2026-09-01", "2026-09-02"]);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("raises a setup error when every organization refuses billing access", async () => {
    const api = fakeApi({
      "/organizations/org-1/billing/export-productline": () =>
        new CrusoeApiError(403, "/x", '{"message":"permission denied"}'),
    });
    await expect(
      fetchCrusoeCostData(api, [{ id: "org-1", name: "Acme" }], new Map(), range),
    ).rejects.toMatchObject({ name: "CostSetupError" });
  });

  it("raises a setup error for a key with no organization", async () => {
    await expect(fetchCrusoeCostData(fakeApi({}), [], new Map(), range)).rejects.toMatchObject({
      name: "CostSetupError",
    });
  });

  it("propagates server errors so the pass is retried", async () => {
    const api = fakeApi({
      "/organizations/org-1/billing/export-productline": () =>
        new CrusoeApiError(500, "/x", "boom"),
    });
    await expect(fetchCrusoeCostData(api, [{ id: "org-1" }], new Map(), range)).rejects.toThrow(
      /500/,
    );
  });
});
