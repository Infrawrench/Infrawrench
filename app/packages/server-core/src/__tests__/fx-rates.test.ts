/**
 * The automatic exchange-rate feed and the precedence between it and the
 * org's stated rates. Pure: no database, no network, no clock.
 *
 * The cases that matter most are the silent ones: a weekend with no rate, a
 * stated override the feed quietly beats, a discontinued currency carried
 * forward for years, a cross rate built from two different days.
 */
import { describe, it, expect } from "vitest";
import type { ExchangeRate } from "@infrawrench/client-core";
import {
  buildFxFeedSnapshot,
  feedCurrencies,
  feedRateFor,
  monthEndOf,
  nextFxFetchAt,
  parseEcbXml,
  type FxPublication,
} from "../cost/fx-feed";
import { convertGroups, convertTotals, RateBook } from "../cost/currency-convert";

let seq = 0;
function stated(
  fromCurrency: string,
  toCurrency: string,
  rate: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): ExchangeRate {
  return {
    id: `rate-${++seq}`,
    fromCurrency,
    toCurrency,
    rate,
    effectiveFrom,
    effectiveTo,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// Thursday 2026-10-01 and Friday 2026-10-02 are published; the weekend of
// 3-4 October is not. Monday 2026-10-05 is published.
const PUBLICATIONS: FxPublication[] = [
  { date: "2026-09-30", rates: { USD: "1.1200", GBP: "0.8500", ISK: "137.00" } },
  { date: "2026-10-01", rates: { USD: "1.1250", GBP: "0.8510", ISK: "137.10" } },
  // ISK missing from here on: a currency the publisher stopped quoting.
  { date: "2026-10-02", rates: { USD: "1.1225", GBP: "0.85033" } },
  { date: "2026-10-05", rates: { USD: "1.1300", GBP: "0.8600" } },
];
const feed = buildFxFeedSnapshot(PUBLICATIONS);

describe("parseEcbXml", () => {
  it("reads the daily file, which uses single quotes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='2026-10-02'>
      <Cube currency='USD' rate='1.1225'/>
      <Cube currency='JPY' rate='176.99'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;
    expect(parseEcbXml(xml)).toEqual([
      { date: "2026-10-02", rates: { USD: "1.1225", JPY: "176.99" } },
    ]);
  });

  it("reads the history files, double-quoted and newest first, into oldest first", () => {
    const xml =
      '<Cube><Cube time="2026-10-02"><Cube currency="USD" rate="1.1225"/></Cube>' +
      '<Cube time="2026-10-01"><Cube currency="USD" rate="1.125"/></Cube></Cube>';
    expect(parseEcbXml(xml).map((p) => p.date)).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("fails on a document with no publications rather than storing nothing", () => {
    expect(() => parseEcbXml("<html><body>Service unavailable</body></html>")).toThrow(
      /no reference-rate publications/,
    );
  });
});

describe("feed lookup", () => {
  it("returns the published rate on a publication day", () => {
    expect(feedRateFor(feed, "EUR", "USD", "2026-10-02")).toEqual({
      rate: 1.1225,
      rateDate: "2026-10-02",
    });
  });

  it("carries Friday's rate over the weekend", () => {
    expect(feedRateFor(feed, "EUR", "USD", "2026-10-03")).toEqual({
      rate: 1.1225,
      rateDate: "2026-10-02",
    });
    expect(feedRateFor(feed, "EUR", "USD", "2026-10-04")?.rateDate).toBe("2026-10-02");
    expect(feedRateFor(feed, "EUR", "USD", "2026-10-05")?.rateDate).toBe("2026-10-05");
  });

  it("carries the newest publication past the end of the history", () => {
    expect(feedRateFor(feed, "EUR", "USD", "2026-10-31")?.rateDate).toBe("2026-10-05");
  });

  it("has no rate before the first publication", () => {
    expect(feedRateFor(feed, "EUR", "USD", "2026-09-29")).toBeNull();
  });

  it("does not carry a currency past a publication that dropped it", () => {
    expect(feedRateFor(feed, "ISK", "EUR", "2026-10-01")?.rateDate).toBe("2026-10-01");
    // The 2 October publication exists and has no ISK: no rate, not 1 October's.
    expect(feedRateFor(feed, "ISK", "EUR", "2026-10-02")).toBeNull();
    expect(feedRateFor(feed, "ISK", "EUR", "2026-10-04")).toBeNull();
  });

  it("inverts a EUR quote for conversion into EUR", () => {
    expect(feedRateFor(feed, "USD", "EUR", "2026-10-02")?.rate).toBeCloseTo(1 / 1.1225, 9);
  });

  it("crosses two non-EUR currencies through EUR, from one publication", () => {
    const cross = feedRateFor(feed, "GBP", "USD", "2026-10-03");
    expect(cross?.rateDate).toBe("2026-10-02");
    expect(cross?.rate).toBeCloseTo(1.1225 / 0.85033, 8);
  });

  it("knows nothing about a currency the feed never quoted", () => {
    expect(feedRateFor(feed, "VND", "USD", "2026-10-02")).toBeNull();
  });

  it("lists the newest publication's currencies plus EUR", () => {
    expect(feedCurrencies(feed)).toEqual(["EUR", "GBP", "USD"]);
    expect(feedCurrencies(null)).toEqual([]);
  });

  it("finds month ends, leap years included", () => {
    expect(monthEndOf("2026-10-05")).toBe("2026-10-31");
    expect(monthEndOf("2028-02-03")).toBe("2028-02-29");
    expect(monthEndOf("2026-02-28")).toBe("2026-02-28");
  });
});

describe("RateBook precedence", () => {
  it("a stated rate wins over the feed on the days it covers", () => {
    const book = new RateBook({
      manual: [stated("EUR", "USD", "1.0000", "2026-10-01")],
      feed,
      basis: "daily",
    });
    expect(book.resolve("EUR", "USD", "2026-10-02")).toEqual({
      rate: 1,
      source: "manual",
      effectiveFrom: "2026-10-01",
      manualRateId: expect.any(String),
    });
  });

  it("the feed fills the days before the first stated rate", () => {
    const book = new RateBook({
      manual: [stated("EUR", "USD", "1.0000", "2026-10-02")],
      feed,
      basis: "daily",
    });
    expect(book.resolve("EUR", "USD", "2026-10-01")).toMatchObject({
      source: "ecb",
      rate: 1.125,
      effectiveFrom: "2026-10-01",
    });
  });

  it("an ended stated rate hands the days after it back to the feed", () => {
    const book = new RateBook({
      manual: [stated("EUR", "USD", "1.0000", "2026-10-01", "2026-10-02")],
      feed,
      basis: "daily",
    });
    expect(book.resolve("EUR", "USD", "2026-10-02")?.source).toBe("manual");
    expect(book.resolve("EUR", "USD", "2026-10-03")).toMatchObject({
      source: "ecb",
      effectiveFrom: "2026-10-02",
    });
  });

  it("an ended stated rate does not resurrect an older one", () => {
    const book = new RateBook({
      manual: [
        stated("EUR", "USD", "0.9000", "2026-01-01"),
        stated("EUR", "USD", "1.0000", "2026-10-01", "2026-10-02"),
      ],
      feed: null,
      basis: "daily",
    });
    expect(book.resolve("EUR", "USD", "2026-09-15")?.rate).toBe(0.9);
    expect(book.resolve("EUR", "USD", "2026-10-02")?.rate).toBe(1);
    // Without the feed, past the end date there is no rate at all.
    expect(book.resolve("EUR", "USD", "2026-10-03")).toBeNull();
  });

  it("a stated rate to another currency is not evidence about this one", () => {
    const book = new RateBook({
      manual: [stated("EUR", "GBP", "0.5", "2026-01-01")],
      feed,
      basis: "daily",
    });
    expect(book.resolve("EUR", "USD", "2026-10-02")?.source).toBe("ecb");
  });

  it("month-end basis converts every day of a month at its last day's rate", () => {
    const book = new RateBook({ manual: [], feed, basis: "month_end" });
    // September's last day (the 30th, a publication day) for any September day.
    expect(book.resolve("EUR", "USD", "2026-09-30")?.effectiveFrom).toBe("2026-09-30");
    // October has not ended: the newest publication is carried to the 31st.
    expect(book.resolve("EUR", "USD", "2026-10-01")).toMatchObject({
      effectiveFrom: "2026-10-05",
      rate: 1.13,
    });
  });

  it("month-end basis never overrides a stated rate covering the day", () => {
    const book = new RateBook({
      manual: [stated("EUR", "USD", "1.0000", "2026-10-01", "2026-10-01")],
      feed,
      basis: "month_end",
    });
    expect(book.resolve("EUR", "USD", "2026-10-01")?.source).toBe("manual");
    expect(book.resolve("EUR", "USD", "2026-10-02")?.effectiveFrom).toBe("2026-10-05");
  });

  it("without the feed, a bare rate array behaves exactly as before", () => {
    const book = RateBook.manualOnly([stated("EUR", "USD", "1.1", "2026-01-01")]);
    expect(book.usesFeed).toBe(false);
    expect(book.resolve("EUR", "USD", "2026-10-02")?.rate).toBe(1.1);
    expect(book.resolve("GBP", "USD", "2026-10-02")).toBeNull();
  });

  it("explains a carried-forward cross rate in words", () => {
    const book = new RateBook({ manual: [], feed, basis: "daily" });
    const { text } = book.explain("GBP", "USD", "2026-10-04");
    expect(text).toMatch(/ECB reference rate applies/);
    expect(text).toMatch(/last publication \(2026-10-02\) is carried forward/);
    expect(text).toMatch(/Crossed through EUR/);
  });
});

describe("conversion with the feed", () => {
  const group = (currency: string, points: Array<[string, number]>) => ({
    key: "aws",
    currency,
    points: points.map(([bucket, amount]) => ({ bucket, amount })),
  });

  it("converts each day at its own rate and reports source and span per rate", () => {
    const book = new RateBook({ manual: [], feed, basis: "daily" });
    const result = convertGroups(
      [
        group("EUR", [
          ["2026-10-02", 100],
          ["2026-10-03", 100],
          ["2026-10-04", 100],
          ["2026-10-05", 100],
        ]),
      ],
      "USD",
      book,
    );
    expect(result.groups[0]!.points.map((p) => p.amount)).toEqual([112.25, 112.25, 112.25, 113]);
    expect(result.conversion).toEqual({
      displayCurrency: "USD",
      unconverted: [],
      rateBasis: "daily",
      converted: [
        {
          currency: "EUR",
          rates: [
            {
              effectiveFrom: "2026-10-05",
              rate: 1.13,
              source: "ecb",
              firstDay: "2026-10-05",
              lastDay: "2026-10-05",
            },
            {
              // The weekend days used Friday's publication: one rate, a
              // three-day span.
              effectiveFrom: "2026-10-02",
              rate: 1.1225,
              source: "ecb",
              firstDay: "2026-10-02",
              lastDay: "2026-10-04",
            },
          ],
        },
      ],
    });
  });

  it("mixes stated and feed rates in one series, stated winning where it applies", () => {
    const book = new RateBook({
      manual: [stated("EUR", "USD", "1.0000", "2026-10-02", "2026-10-02")],
      feed,
      basis: "daily",
    });
    const result = convertGroups(
      [
        group("EUR", [
          ["2026-10-01", 100],
          ["2026-10-02", 100],
          ["2026-10-05", 100],
        ]),
      ],
      "USD",
      book,
    );
    expect(result.groups[0]!.points.map((p) => p.amount)).toEqual([112.5, 100, 113]);
    const sources = result.conversion!.converted[0]!.rates.map((r) => r.source);
    expect(sources.sort()).toEqual(["ecb", "ecb", "manual"]);
  });

  it("leaves a currency the feed does not quote unconverted, never dropped", () => {
    const book = new RateBook({ manual: [], feed, basis: "daily" });
    const result = convertGroups(
      [group("EUR", [["2026-10-02", 100]]), group("VND", [["2026-10-02", 1_000_000]])],
      "USD",
      book,
    );
    expect(result.conversion!.unconverted).toEqual(["VND"]);
    expect(result.groups.find((g) => g.currency === "VND")!.points[0]!.amount).toBe(1_000_000);
  });

  it("a manual-only currency converts once the org states a rate", () => {
    const book = new RateBook({
      manual: [stated("VND", "USD", "0.00004", "2026-01-01")],
      feed,
      basis: "daily",
    });
    const result = convertGroups([group("VND", [["2026-10-02", 1_000_000]])], "USD", book);
    expect(result.groups[0]!.points[0]!.amount).toBe(40);
    expect(result.conversion!.converted[0]!.rates[0]!.source).toBe("manual");
  });

  it("converts totals for one day with the same precedence", () => {
    const book = new RateBook({ manual: [], feed, basis: "daily" });
    const result = convertTotals({ EUR: 100, GBP: 100 }, "USD", book, "2026-10-04");
    expect(result.totals.USD).toBeCloseTo(112.25 + (100 * 1.1225) / 0.85033, 4);
    expect(result.conversion!.converted.map((c) => c.rates[0]!.effectiveFrom)).toEqual([
      "2026-10-02",
      "2026-10-02",
    ]);
  });
});

describe("nextFxFetchAt", () => {
  it("waits for today's 15:30 UTC look when it is still ahead", () => {
    expect(nextFxFetchAt(new Date("2026-10-05T09:00:00Z"), "2026-10-02").toISOString()).toBe(
      "2026-10-05T15:30:00.000Z",
    );
  });

  it("re-checks in two hours on a weekday whose publication is late", () => {
    expect(nextFxFetchAt(new Date("2026-10-05T16:00:00Z"), "2026-10-02").toISOString()).toBe(
      "2026-10-05T18:00:00.000Z",
    );
  });

  it("moves to tomorrow once today's publication is stored", () => {
    expect(nextFxFetchAt(new Date("2026-10-05T16:00:00Z"), "2026-10-05").toISOString()).toBe(
      "2026-10-06T15:30:00.000Z",
    );
  });

  it("does not re-check through a weekend", () => {
    expect(nextFxFetchAt(new Date("2026-10-03T16:00:00Z"), "2026-10-02").toISOString()).toBe(
      "2026-10-04T15:30:00.000Z",
    );
  });
});
