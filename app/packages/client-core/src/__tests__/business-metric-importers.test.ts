import { describe, expect, it } from "vitest";

import {
  aggregateBusinessMetricPoints,
  csvRowsToMetricValues,
  guessCsvMapping,
  parseMetricCsv,
  parseCsvDay,
  parseCsvNumber,
} from "../business-metric-importers";

describe("aggregateBusinessMetricPoints", () => {
  const points = [
    { date: "2026-07-01", value: 2 },
    { date: "2026-07-01", value: 4 },
    { date: "2026-07-02", value: 5 },
    { date: "2026-07-01", value: 1, label: "acme" },
  ];

  it("sums by default, per day and label", () => {
    expect(aggregateBusinessMetricPoints(points, "sum")).toEqual([
      { date: "2026-07-01", value: 6 },
      { date: "2026-07-01", value: 1, label: "acme" },
      { date: "2026-07-02", value: 5 },
    ]);
  });

  it("supports average, min, max, last and count", () => {
    const day1 = (agg: Parameters<typeof aggregateBusinessMetricPoints>[1]) =>
      aggregateBusinessMetricPoints(points, agg).find((v) => v.date === "2026-07-01" && !v.label)
        ?.value;
    expect(day1("average")).toBe(3);
    expect(day1("min")).toBe(2);
    expect(day1("max")).toBe(4);
    expect(day1("last")).toBe(4);
    expect(day1("count")).toBe(2);
  });

  it("returns nothing for no points, so a run writes no days rather than zeros", () => {
    expect(aggregateBusinessMetricPoints([], "sum")).toEqual([]);
  });
});

describe("CSV upload", () => {
  it("parses quoted cells, doubled quotes, CRLF and blank lines", () => {
    expect(parseMetricCsv('day,value,label\r\n2026-07-01,"1,204","Acme ""EU"""\r\n\r\n')).toEqual([
      ["day", "value", "label"],
      ["2026-07-01", "1,204", 'Acme "EU"'],
    ]);
  });

  it("sniffs semicolon and tab delimiters", () => {
    expect(parseMetricCsv("day;value\n2026-07-01;3")[1]).toEqual(["2026-07-01", "3"]);
    expect(parseMetricCsv("day\tvalue\n2026-07-01\t3")[1]).toEqual(["2026-07-01", "3"]);
  });

  it("reads dates in the chosen format and refuses impossible ones", () => {
    expect(parseCsvDay("2026-07-01", "auto")).toBe("2026-07-01");
    expect(parseCsvDay("2026-07-01T12:00:00Z", "auto")).toBe("2026-07-01");
    expect(parseCsvDay("07/01/2026", "auto")).toBeNull();
    expect(parseCsvDay("07/01/2026", "mdy")).toBe("2026-07-01");
    expect(parseCsvDay("07/01/2026", "dmy")).toBe("2026-01-07");
    expect(parseCsvDay("2026-02-30", "auto")).toBeNull();
  });

  it("reads numbers with separators and a currency sign", () => {
    expect(parseCsvNumber("$1,204.50")).toBe(1204.5);
    expect(parseCsvNumber(" 12 000 ")).toBe(12000);
    expect(parseCsvNumber("n/a")).toBeNull();
    expect(parseCsvNumber("")).toBeNull();
  });

  it("guesses the mapping from common header names", () => {
    expect(guessCsvMapping(["Date", "Customer", "Count"])).toEqual({ date: 0, value: 2, label: 1 });
    expect(guessCsvMapping(["a", "b"])).toBeNull();
  });

  it("maps rows and reports unreadable ones by spreadsheet line", () => {
    const result = csvRowsToMetricValues(
      [
        ["2026-07-01", "10", "acme"],
        ["yesterday", "3", ""],
        ["2026-07-02", "lots", ""],
        ["2026-07-02", "4", ""],
      ],
      { date: 0, value: 1, label: 2 },
      "auto",
    );
    expect(result.values).toEqual([
      { date: "2026-07-01", value: 10, label: "acme" },
      { date: "2026-07-02", value: 4 },
    ]);
    expect(result.errors.map((e) => e.row)).toEqual([3, 4]);
  });
});
