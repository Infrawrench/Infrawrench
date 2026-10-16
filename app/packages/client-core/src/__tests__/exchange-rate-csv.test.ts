import { describe, expect, it } from "vitest";
import {
  EXCHANGE_RATE_CSV_LIMITS,
  EXCHANGE_RATE_CSV_TEMPLATE,
  billingPeriodBounds,
  countExchangeRateImportActions,
  isValidIsoDay,
  normalizeRateCell,
  parseExchangeRateCsv,
  sameStatedRate,
} from "../exchange-rate-csv";

describe("parseExchangeRateCsv", () => {
  it("parses the template into three valid rows of each shape", () => {
    const parsed = parseExchangeRateCsv(EXCHANGE_RATE_CSV_TEMPLATE);
    expect(parsed.fileError).toBeNull();
    expect(parsed.rows.map((r) => r.error)).toEqual([null, null, null]);
    expect(parsed.rows.map((r) => r.input)).toEqual([
      {
        fromCurrency: "EUR",
        toCurrency: "USD",
        rate: "1.08",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
      {
        fromCurrency: "GBP",
        toCurrency: "USD",
        rate: "1.27",
        effectiveFrom: "2026-03-01",
        effectiveTo: "2026-03-31",
      },
      {
        fromCurrency: "JPY",
        toCurrency: "USD",
        rate: "0.0067",
        effectiveFrom: "2026-04-01",
        effectiveTo: "2026-04-30",
      },
    ]);
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 3, 4]);
  });

  it("matches header spellings loosely and ignores unknown columns", () => {
    const parsed = parseExchangeRateCsv(
      "From Currency;To Currency;Notes;Exchange Rate;Billing Period\neur;usd;close;1,0850;2026-02\n",
    );
    expect(parsed.fileError).toBeNull();
    expect(parsed.columns).toMatchObject({
      from: "From Currency",
      to: "To Currency",
      rate: "Exchange Rate",
      billing_period: "Billing Period",
    });
    expect(parsed.rows[0]?.input).toEqual({
      fromCurrency: "EUR",
      toCurrency: "USD",
      rate: "1.085",
      effectiveFrom: "2026-02-01",
      effectiveTo: "2026-02-28",
    });
  });

  it("reports every invalid row with its line, without stopping", () => {
    const parsed = parseExchangeRateCsv(
      [
        "from,to,rate,effective_from,effective_to,billing_period",
        "EUR,USD,1.08,2026-01-01,,",
        "EURO,USD,1.08,2026-01-01,,",
        "EUR,EUR,1,2026-01-01,,",
        "GBP,USD,0,2026-01-01,,",
        "GBP,USD,1.2.3,2026-01-01,,",
        "GBP,USD,1.27,2026-02-30,,",
        "GBP,USD,1.27,2026-03-10,2026-03-01,",
        "GBP,USD,1.27,2026-03-01,,2026-03",
        "GBP,USD,1.27,,,2026-13",
        "GBP,USD,1.27,,,",
        "EUR,USD,1.09,2026-01-01,,",
      ].join("\n"),
    );
    expect(parsed.fileError).toBeNull();
    expect(parsed.rows.map((r) => [r.line, r.error])).toEqual([
      [2, null],
      [3, '"EURO" is not a three-letter currency code'],
      [4, "a rate from EUR to itself has no meaning"],
      [5, "rate must be greater than 0"],
      [6, '"1.2.3" is not a decimal number'],
      [7, '"2026-02-30" is not a date (expected YYYY-MM-DD)'],
      [8, "effective_to is before effective_from"],
      [9, "give either a billing period or effective dates, not both"],
      [10, '"2026-13" is not a billing period (expected YYYY-MM)'],
      [11, "needs an effective_from date or a billing_period"],
      [12, "duplicates line 2 (same pair and effective date)"],
    ]);
  });

  it("refuses a file without the required columns as a whole", () => {
    expect(parseExchangeRateCsv("from,to\nEUR,USD\n").fileError).toMatch(/Missing column: rate/);
    expect(parseExchangeRateCsv("from,to,rate\nEUR,USD,1\n").fileError).toMatch(
      /effective_from or billing_period/,
    );
    expect(parseExchangeRateCsv("").fileError).toBe("The file is empty.");
    expect(parseExchangeRateCsv("from,to,rate,period\n").fileError).toMatch(/no rates/);
  });

  it("refuses a file with more rows than one upload takes", () => {
    const lines = ["from,to,rate,effective_from"];
    for (let i = 0; i <= EXCHANGE_RATE_CSV_LIMITS.maxRows; i++) lines.push("EUR,USD,1,2026-01-01");
    expect(parseExchangeRateCsv(lines.join("\n")).fileError).toMatch(/at most/);
  });
});

describe("helpers", () => {
  it("bounds a billing period to its month, leap years included", () => {
    expect(billingPeriodBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(billingPeriodBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(billingPeriodBounds("2026-00")).toBeNull();
    expect(billingPeriodBounds("26-01")).toBeNull();
  });

  it("validates calendar days", () => {
    expect(isValidIsoDay("2026-02-28")).toBe(true);
    expect(isValidIsoDay("2026-02-29")).toBe(false);
    expect(isValidIsoDay("2026-1-01")).toBe(false);
  });

  it("normalizes rate cells without guessing at thousands separators", () => {
    expect(normalizeRateCell("1.0850")).toBe("1.085");
    expect(normalizeRateCell("1,0850")).toBe("1.085");
    expect(normalizeRateCell("007.5")).toBe("7.5");
    expect(normalizeRateCell("0.000039512345678")).toBe("0.0000395123");
    expect(normalizeRateCell("1,085.5")).toBeNull();
    expect(normalizeRateCell("-1")).toBeNull();
    expect(normalizeRateCell("")).toBeNull();
  });

  it("compares stated rates by value, not spelling", () => {
    expect(
      sameStatedRate(
        { rate: "1.0800000000", effectiveTo: null },
        { rate: "1.08", effectiveTo: null },
      ),
    ).toBe(true);
    expect(
      sameStatedRate(
        { rate: "1.08", effectiveTo: "2026-01-31" },
        { rate: "1.08", effectiveTo: null },
      ),
    ).toBe(false);
  });

  it("counts actions", () => {
    expect(
      countExchangeRateImportActions([
        { action: "create" },
        { action: "error" },
        { action: "create" },
      ]),
    ).toEqual({ create: 2, update: 0, unchanged: 0, error: 1 });
  });
});
