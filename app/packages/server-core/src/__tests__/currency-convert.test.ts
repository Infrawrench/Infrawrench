/**
 * Exhaustive tests for the pure conversion layer. No database, no ClickHouse,
 * no clock — every case here is a function of its arguments, which is the whole
 * reason `cost/currency-convert.ts` holds no db import.
 *
 * The cases that matter most are the ones where getting it wrong is silent:
 * a missing rate that drops a currency, a zero rate that erases spend, an
 * effective date picked from the wrong side of a boundary.
 */
import { describe, it, expect } from "vitest";
import { buildExchangeRateTable, type ExchangeRate } from "@infrawrench/client-core";
import {
  convertGroups,
  convertTotals,
  mergeConvertedGroups,
  parseRate,
  rateForDay,
} from "../cost/currency-convert";

let seq = 0;
function rate(
  fromCurrency: string,
  toCurrency: string,
  value: string,
  effectiveFrom: string,
): ExchangeRate {
  return {
    id: `rate-${++seq}`,
    fromCurrency,
    toCurrency,
    rate: value,
    effectiveFrom,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const group = (key: string, currency: string, points: Array<[string, number]>) => ({
  key,
  currency,
  points: points.map(([bucket, amount]) => ({ bucket, amount })),
});

describe("rateForDay", () => {
  // Sorted descending, the order buildExchangeRateTable produces.
  const rates = [
    rate("EUR", "USD", "1.10", "2026-03-01"),
    rate("EUR", "USD", "1.05", "2026-02-01"),
    rate("EUR", "USD", "1.00", "2026-01-01"),
  ];

  it("picks the latest rate effective on or before the day", () => {
    expect(rateForDay(rates, "2026-02-15")?.rate).toBe("1.05");
  });

  it("treats effective_from as inclusive", () => {
    expect(rateForDay(rates, "2026-02-01")?.rate).toBe("1.05");
  });

  it("uses the previous rate on the day before a change", () => {
    expect(rateForDay(rates, "2026-02-28")?.rate).toBe("1.05");
    expect(rateForDay(rates, "2026-03-01")?.rate).toBe("1.10");
  });

  it("uses the newest rate for any day after the last one", () => {
    expect(rateForDay(rates, "2030-12-31")?.rate).toBe("1.10");
  });

  it("returns null for a day before every stated rate", () => {
    expect(rateForDay(rates, "2025-12-31")).toBeNull();
  });

  it("returns null for an empty table", () => {
    expect(rateForDay([], "2026-02-15")).toBeNull();
  });
});

describe("parseRate", () => {
  it("parses a decimal string", () => {
    expect(parseRate("1.0850000000")).toBe(1.085);
  });

  it.each(["0", "0.0000000000", "-1", "abc", "", "NaN"])(
    "refuses %s rather than treating it as zero",
    (raw) => {
      // A zero rate would erase a currency's spend while reporting it as
      // converted — the silent understatement this feature exists to prevent.
      expect(parseRate(raw)).toBeNull();
    },
  );
});

describe("buildExchangeRateTable", () => {
  it("drops rates pointing at a different display currency", () => {
    const table = buildExchangeRateTable(
      [rate("EUR", "GBP", "0.85", "2026-01-01"), rate("EUR", "USD", "1.10", "2026-01-01")],
      "USD",
    );
    expect(table.get("EUR")).toHaveLength(1);
    expect(table.get("EUR")![0]!.rate).toBe("1.10");
  });

  it("drops a self-rate so nobody can scale the display currency", () => {
    const table = buildExchangeRateTable([rate("USD", "USD", "2", "2026-01-01")], "USD");
    expect(table.has("USD")).toBe(false);
  });

  it("sorts each currency newest effective date first", () => {
    const table = buildExchangeRateTable(
      [
        rate("EUR", "USD", "1.00", "2026-01-01"),
        rate("EUR", "USD", "1.10", "2026-03-01"),
        rate("EUR", "USD", "1.05", "2026-02-01"),
      ],
      "USD",
    );
    expect(table.get("EUR")!.map((r) => r.effectiveFrom)).toEqual([
      "2026-03-01",
      "2026-02-01",
      "2026-01-01",
    ]);
  });
});

describe("convertGroups", () => {
  const eurUsd = [rate("EUR", "USD", "1.10", "2026-01-01")];

  it("is a no-op with no display currency", () => {
    const groups = [group("aws", "EUR", [["2026-02-01", 100]])];
    const result = convertGroups(groups, null, eurUsd);
    expect(result.groups).toBe(groups);
    expect(result.conversion).toBeNull();
  });

  it("is a no-op with a display currency but no rates at all", () => {
    const groups = [group("aws", "USD", [["2026-02-01", 100]])];
    const result = convertGroups(groups, "USD", []);
    expect(result.groups).toBe(groups);
    expect(result.conversion).toEqual({
      displayCurrency: "USD",
      converted: [],
      unconverted: [],
    });
  });

  it("passes spend already in the display currency straight through", () => {
    // Not multiplied by a rate of 1 — passed through, so no rounding can touch it.
    const groups = [group("aws", "USD", [["2026-02-01", 100.005]])];
    const result = convertGroups(groups, "USD", eurUsd);
    expect(result.groups[0]!.points[0]!.amount).toBe(100.005);
    expect(result.conversion!.converted).toEqual([]);
    expect(result.conversion!.unconverted).toEqual([]);
  });

  it("converts a foreign currency and reports the rate applied", () => {
    const result = convertGroups([group("aws", "EUR", [["2026-02-01", 100]])], "USD", eurUsd);
    expect(result.groups[0]!.currency).toBe("USD");
    expect(result.groups[0]!.points[0]!.amount).toBe(110);
    expect(result.conversion).toEqual({
      displayCurrency: "USD",
      converted: [{ currency: "EUR", rates: [{ effectiveFrom: "2026-01-01", rate: 1.1 }] }],
      unconverted: [],
    });
  });

  it("keeps the group's key and every other field", () => {
    const result = convertGroups([group("aws", "EUR", [["2026-02-01", 10]])], "USD", eurUsd);
    expect(result.groups[0]!.key).toBe("aws");
    expect(result.groups[0]!.points[0]!.bucket).toBe("2026-02-01");
  });

  it("converts each day at the rate that applied then", () => {
    const rates = [
      rate("EUR", "USD", "1.00", "2026-01-01"),
      rate("EUR", "USD", "2.00", "2026-02-01"),
    ];
    const result = convertGroups(
      [
        group("aws", "EUR", [
          ["2026-01-15", 100],
          ["2026-02-15", 100],
        ]),
      ],
      "USD",
      rates,
    );
    expect(result.groups[0]!.points.map((p) => p.amount)).toEqual([100, 200]);
    // Both rates are reported, newest first — a total spanning a rate change is
    // a blend, and the reader has to be able to see that.
    expect(result.conversion!.converted[0]!.rates).toEqual([
      { effectiveFrom: "2026-02-01", rate: 2 },
      { effectiveFrom: "2026-01-01", rate: 1 },
    ]);
  });

  it("leaves a currency with no rate unconverted rather than dropping it", () => {
    const result = convertGroups(
      [group("aws", "EUR", [["2026-02-01", 100]]), group("gcp", "SEK", [["2026-02-01", 500]])],
      "USD",
      eurUsd,
    );
    const sek = result.groups.find((g) => g.key === "gcp")!;
    expect(sek.currency).toBe("SEK");
    expect(sek.points[0]!.amount).toBe(500);
    expect(result.conversion!.unconverted).toEqual(["SEK"]);
    expect(result.conversion!.converted.map((c) => c.currency)).toEqual(["EUR"]);
  });

  it("leaves a currency unconverted all-or-nothing when any day predates its rates", () => {
    // Half a converted series is a number that reconciles against nothing.
    const result = convertGroups(
      [
        group("aws", "EUR", [
          ["2025-12-31", 100],
          ["2026-02-01", 100],
        ]),
      ],
      "USD",
      eurUsd,
    );
    expect(result.groups[0]!.currency).toBe("EUR");
    expect(result.groups[0]!.points.map((p) => p.amount)).toEqual([100, 100]);
    expect(result.conversion!.unconverted).toEqual(["EUR"]);
  });

  it("refuses a zero rate rather than erasing the currency's spend", () => {
    const result = convertGroups([group("aws", "EUR", [["2026-02-01", 100]])], "USD", [
      rate("EUR", "USD", "0", "2026-01-01"),
    ]);
    expect(result.groups[0]!.currency).toBe("EUR");
    expect(result.groups[0]!.points[0]!.amount).toBe(100);
    expect(result.conversion!.unconverted).toEqual(["EUR"]);
  });

  it("ignores a rate that points at some other currency", () => {
    const result = convertGroups([group("aws", "EUR", [["2026-02-01", 100]])], "USD", [
      rate("EUR", "GBP", "0.85", "2026-01-01"),
    ]);
    expect(result.conversion!.unconverted).toEqual(["EUR"]);
  });

  it("never inverts a rate to convert the other way", () => {
    // A USD→EUR rate says nothing about EUR→USD as far as this code is
    // concerned: inverting it invents a number the org never stated.
    const result = convertGroups([group("aws", "EUR", [["2026-02-01", 100]])], "USD", [
      rate("USD", "EUR", "0.9091", "2026-01-01"),
    ]);
    expect(result.conversion!.unconverted).toEqual(["EUR"]);
  });

  it("never chains two rates through an intermediate currency", () => {
    const result = convertGroups([group("aws", "GBP", [["2026-02-01", 100]])], "USD", [
      rate("GBP", "EUR", "1.17", "2026-01-01"),
      rate("EUR", "USD", "1.10", "2026-01-01"),
    ]);
    expect(result.conversion!.unconverted).toEqual(["GBP"]);
  });

  it("rounds to six places, not to the cent", () => {
    // Rounding each point to the cent first makes a 90-point total drift; six
    // places is below any minor unit and above the accumulated error.
    const result = convertGroups([group("aws", "EUR", [["2026-02-01", 0.1]])], "USD", [
      rate("EUR", "USD", "1.0000000003", "2026-01-01"),
    ]);
    expect(result.groups[0]!.points[0]!.amount).toBe(0.1);
  });

  it("sorts unconverted currencies for a stable caveat line", () => {
    const result = convertGroups(
      [
        group("a", "SEK", [["2026-02-01", 1]]),
        group("b", "JPY", [["2026-02-01", 1]]),
        group("c", "NOK", [["2026-02-01", 1]]),
      ],
      "USD",
      [],
    );
    expect(result.conversion!.unconverted).toEqual(["JPY", "NOK", "SEK"]);
  });
});

describe("mergeConvertedGroups", () => {
  it("folds two same-key groups that became the same currency", () => {
    const merged = mergeConvertedGroups([
      group("aws", "USD", [
        ["2026-02-01", 10],
        ["2026-02-02", 20],
      ]),
      group("aws", "USD", [["2026-02-02", 5]]),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.points).toEqual([
      { bucket: "2026-02-01", amount: 10 },
      { bucket: "2026-02-02", amount: 25 },
    ]);
  });

  it("keeps groups apart when their currencies still differ", () => {
    const merged = mergeConvertedGroups([
      group("aws", "USD", [["2026-02-01", 10]]),
      group("aws", "SEK", [["2026-02-01", 10]]),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const first = group("aws", "USD", [["2026-02-01", 10]]);
    mergeConvertedGroups([first, group("aws", "USD", [["2026-02-01", 5]])]);
    expect(first.points[0]!.amount).toBe(10);
  });

  it("re-sorts merged points by bucket", () => {
    const merged = mergeConvertedGroups([
      group("aws", "USD", [["2026-02-03", 1]]),
      group("aws", "USD", [["2026-02-01", 1]]),
    ]);
    expect(merged[0]!.points.map((p) => p.bucket)).toEqual(["2026-02-01", "2026-02-03"]);
  });
});

describe("convertTotals", () => {
  const eurUsd = [rate("EUR", "USD", "1.10", "2026-01-01")];

  it("is a no-op with no display currency", () => {
    const totals = { EUR: 100, USD: 50 };
    const result = convertTotals(totals, null, eurUsd, "2026-02-01");
    expect(result.totals).toBe(totals);
    expect(result.conversion).toBeNull();
  });

  it("folds convertible currencies into the display currency", () => {
    const result = convertTotals({ EUR: 100, USD: 50 }, "USD", eurUsd, "2026-02-01");
    expect(result.totals).toEqual({ USD: 160 });
    expect(result.conversion!.converted).toEqual([
      { currency: "EUR", rates: [{ effectiveFrom: "2026-01-01", rate: 1.1 }] },
    ]);
  });

  it("keeps an unconvertible currency as its own entry", () => {
    const result = convertTotals({ EUR: 100, SEK: 500 }, "USD", eurUsd, "2026-02-01");
    expect(result.totals).toEqual({ USD: 110, SEK: 500 });
    expect(result.conversion!.unconverted).toEqual(["SEK"]);
  });

  it("uses the rate in force on the given day", () => {
    const rates = [
      rate("EUR", "USD", "1.00", "2026-01-01"),
      rate("EUR", "USD", "2.00", "2026-02-01"),
    ];
    expect(convertTotals({ EUR: 100 }, "USD", rates, "2026-01-15").totals).toEqual({ USD: 100 });
    expect(convertTotals({ EUR: 100 }, "USD", rates, "2026-02-15").totals).toEqual({ USD: 200 });
  });

  it("leaves everything alone when the day predates every rate", () => {
    const result = convertTotals({ EUR: 100 }, "USD", eurUsd, "2025-06-01");
    expect(result.totals).toEqual({ EUR: 100 });
    expect(result.conversion!.unconverted).toEqual(["EUR"]);
  });

  it("returns an empty total map unchanged, with an empty report", () => {
    const result = convertTotals({}, "USD", eurUsd, "2026-02-01");
    expect(result.totals).toEqual({});
    expect(result.conversion).toEqual({
      displayCurrency: "USD",
      converted: [],
      unconverted: [],
    });
  });
});
