import { describe, expect, it } from "vitest";
import {
  applyCsvMappingOverrides,
  buildCustomCostRows,
  detectCsvMapping,
  detectDateFormat,
  focusChargeType,
  isFocusHeader,
  overlappingCustomCostUploads,
  parseCostDate,
  parseCostNumber,
  parseCsv,
  parseTagsCell,
  uploadCustomCostRows,
  type CustomCostUpload,
} from "../custom-costs";

describe("parseCsv", () => {
  it("handles BOM, CRLF, quotes with embedded delimiters, newlines and doubled quotes", () => {
    const table = parseCsv('﻿Date,Note,Cost\r\n2026-07-01,"a, ""b""\nc",10\r\n\r\n');
    expect(table.headers).toEqual(["Date", "Note", "Cost"]);
    expect(table.rows).toEqual([["2026-07-01", 'a, "b"\nc', "10"]]);
  });

  it("detects semicolon and tab delimiters and pads short rows", () => {
    expect(parseCsv("a;b;c\n1;2").rows).toEqual([["1", "2", ""]]);
    expect(parseCsv("a\tb\n1\t2").delimiter).toBe("\t");
  });
});

describe("value parsing", () => {
  it("parses dates in the supported shapes", () => {
    expect(parseCostDate("2026-07-01")).toBe("2026-07-01");
    expect(parseCostDate("2026-07-01T23:00:00Z")).toBe("2026-07-01");
    expect(parseCostDate("2026-07-01T23:00:00-02:00")).toBe("2026-07-02");
    expect(parseCostDate("2026-07")).toBe("2026-07-01");
    expect(parseCostDate("20260701")).toBe("2026-07-01");
    expect(parseCostDate("7/1/2026", "mdy")).toBe("2026-07-01");
    expect(parseCostDate("1/7/2026", "dmy")).toBe("2026-07-01");
    expect(parseCostDate("2026-02-30")).toBeNull();
    expect(parseCostDate("yesterday")).toBeNull();
  });

  it("detects day-first and month-first columns, and says when it cannot tell", () => {
    expect(detectDateFormat(["13/01/2026"])).toEqual({ format: "dmy", ambiguous: false });
    expect(detectDateFormat(["01/13/2026"])).toEqual({ format: "mdy", ambiguous: false });
    expect(detectDateFormat(["01/02/2026"]).ambiguous).toBe(true);
    expect(detectDateFormat(["2026-01-02"]).ambiguous).toBe(false);
  });

  it("parses money in common locales and accounting notation", () => {
    expect(parseCostNumber("1,234.56")).toBe(1234.56);
    expect(parseCostNumber("1.234,56")).toBe(1234.56);
    expect(parseCostNumber("12,5")).toBe(12.5);
    expect(parseCostNumber("$ 1,000")).toBe(1000);
    expect(parseCostNumber("(12.50)")).toBe(-12.5);
    expect(parseCostNumber("-3 USD")).toBe(-3);
    expect(parseCostNumber("1.5e-4")).toBe(0.00015);
    expect(parseCostNumber("n/a")).toBeNull();
  });

  it("parses JSON and key=value tags", () => {
    expect(parseTagsCell('{"team":"data","n":3}')).toEqual({ team: "data", n: "3" });
    expect(parseTagsCell("team=data; env:prod")).toEqual({ team: "data", env: "prod" });
    expect(parseTagsCell("garbage")).toBeNull();
  });
});

describe("mapping", () => {
  it("auto-detects common headers without claiming a column twice", () => {
    const m = detectCsvMapping(["Usage Date", "Service Name", "Cost", "Currency", "Total", "Tags"]);
    expect(m.date).toBe(0);
    expect(m.service).toBe(1);
    expect(m.cost).toBe(2);
    expect(m.currency).toBe(3);
    expect(m.tags).toBe(5);
    expect(m.region).toBeNull();
  });

  it("applies field=Column overrides by name, case-insensitively, or by number", () => {
    const headers = ["Day", "Spend", "Team"];
    const m = applyCsvMappingOverrides(headers, detectCsvMapping(headers), ["cost=spend", "tag=3"]);
    expect(m.cost).toBe(1);
    expect(m.tagColumns).toEqual([2]);
    expect(() => applyCsvMappingOverrides(headers, m, ["bogus=Day"])).toThrow(/Unknown field/);
    expect(() => applyCsvMappingOverrides(headers, m, ["date=Nope"])).toThrow(/No column/);
  });
});

describe("buildCustomCostRows (csv)", () => {
  it("aggregates lines on the table's dedupe key and reports bad lines by file line", () => {
    const table = parseCsv(
      [
        "Date,Service,Cost,Team",
        "2026-07-01,Colo,10,infra",
        "2026-07-01,Colo,5.5,infra",
        "2026-07-02,Colo,oops,infra",
        "2026-07-02,Colo,1,data",
      ].join("\n"),
    );
    const mapping = detectCsvMapping(table.headers);
    mapping.tagColumns = [3];
    const result = buildCustomCostRows(
      table,
      { format: "csv", mapping },
      { defaultCurrency: "usd" },
    );
    expect(result.rows).toEqual([
      {
        date: "2026-07-01",
        currency: "USD",
        amount: 15.5,
        service: "Colo",
        tags: { Team: "infra" },
      },
      { date: "2026-07-02", currency: "USD", amount: 1, service: "Colo", tags: { Team: "data" } },
    ]);
    expect(result.errors).toEqual([{ line: 4, message: 'Unreadable cost "oops".' }]);
    expect(result.fromDate).toBe("2026-07-01");
    expect(result.toDate).toBe("2026-07-02");
    expect(result.totals).toEqual({ USD: 16.5 });
  });

  it("requires a currency from the file or the source default", () => {
    const table = parseCsv("Date,Cost\n2026-07-01,1");
    const result = buildCustomCostRows(table, {
      format: "csv",
      mapping: detectCsvMapping(table.headers),
    });
    expect(result.rows).toEqual([]);
    expect(result.errors[0]?.message).toMatch(/No currency/);
  });

  it("rejects reserved tag keys per line", () => {
    const table = parseCsv('Date,Cost,Currency,Tags\n2026-07-01,1,EUR,"{""infrawrench:x"":""y""}"');
    const result = buildCustomCostRows(table, {
      format: "csv",
      mapping: detectCsvMapping(table.headers),
    });
    expect(result.errors[0]?.message).toMatch(/reserved/);
  });
});

describe("buildCustomCostRows (focus)", () => {
  const header = [
    "BilledCost",
    "EffectiveCost",
    "BillingCurrency",
    "ChargePeriodStart",
    "ChargePeriodEnd",
    "ChargeCategory",
    "ServiceName",
    "RegionId",
    "SubAccountName",
    "ConsumedQuantity",
    "ConsumedUnit",
    "CommitmentDiscountId",
    "Tags",
  ].join(",");

  it("recognises the header and maps hourly rows onto days with charge types", () => {
    const text = [
      header,
      '1.5,1.0,USD,2026-07-01T00:00:00Z,2026-07-01T01:00:00Z,Usage,Compute,us-east-1,prod,1,Hours,ri-1,"{""team"":""web""}"',
      '1.5,1.0,USD,2026-07-01T01:00:00Z,2026-07-01T02:00:00Z,Usage,Compute,us-east-1,prod,1,Hours,ri-1,"{""team"":""web""}"',
      "100,0,USD,2026-07-01T00:00:00Z,2026-07-02T00:00:00Z,Purchase,Compute,,prod,,,ri-1,",
      "-4,-4,USD,2026-07-01T00:00:00Z,2026-07-02T00:00:00Z,Credit,,,prod,,,,",
      "0,0,USD,2026-07-01T00:00:00Z,2026-07-02T00:00:00Z,Usage,Free,,prod,,,,",
    ].join("\n");
    const table = parseCsv(text);
    expect(isFocusHeader(table.headers)).toBe(true);
    const result = buildCustomCostRows(table, { format: "focus" });
    expect(result.errors).toEqual([]);
    expect(result.rows).toContainEqual({
      date: "2026-07-01",
      currency: "USD",
      amount: 3,
      amortizedAmount: 2,
      service: "Compute",
      region: "us-east-1",
      subAccount: "prod",
      tags: { team: "web" },
      usageAmount: 2,
      usageUnit: "Hours",
      chargeType: "commitment_covered_usage",
      commitmentId: "ri-1",
    });
    expect(result.rows.find((r) => r.chargeType === "commitment_fee")?.amortizedAmount).toBe(0);
    expect(result.rows.find((r) => r.chargeType === "credit")?.amount).toBe(-4);
    // The all-zero Free row is dropped as noise.
    expect(result.rows).toHaveLength(3);
  });

  it("maps every FOCUS charge category", () => {
    expect(focusChargeType("Usage", "")).toBe("usage");
    expect(focusChargeType("Purchase", "")).toBe("other");
    expect(focusChargeType("Tax", "")).toBe("tax");
    expect(focusChargeType("Adjustment", "")).toBe("adjustment");
  });
});

describe("overlaps and uploading", () => {
  const upload = (over: Partial<CustomCostUpload>): CustomCostUpload => ({
    id: "u1",
    sourceId: "s1",
    fileName: null,
    format: "csv",
    mode: "append",
    status: "complete",
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
    rowCount: 10,
    totals: {},
    uploadedBy: null,
    via: "web",
    createdAt: "",
    completedAt: null,
    ...over,
  });

  it("finds live uploads whose range intersects", () => {
    const uploads = [
      upload({ id: "a" }),
      upload({ id: "b", fromDate: "2026-08-01", toDate: "2026-08-31" }),
      upload({ id: "c", status: "replaced" }),
    ];
    expect(
      overlappingCustomCostUploads(uploads, "2026-07-31", "2026-08-02").map((u) => u.id),
    ).toEqual(["a", "b"]);
  });

  it("creates, chunks, and completes", async () => {
    const calls: Array<[string, unknown]> = [];
    const transport = {
      async post<T>(path: string, body: unknown): Promise<T> {
        calls.push([path, body]);
        return { id: "up1" } as T;
      },
    };
    const rows = Array.from({ length: 5001 }, () => ({
      date: "2026-07-01",
      currency: "USD",
      amount: 1,
    }));
    await uploadCustomCostRows({
      transport,
      basePath: "/x",
      rows,
      format: "csv",
      mode: "replace",
      via: "cli",
    });
    expect(calls.map((c) => c[0])).toEqual([
      "/x/uploads",
      "/x/uploads/up1/rows",
      "/x/uploads/up1/rows",
      "/x/uploads/up1/complete",
    ]);
    expect(calls[0]![1]).toMatchObject({ mode: "replace", fromDate: "2026-07-01" });
  });
});
