import { describe, expect, it } from "vitest";
import { Effect, Exit, Option } from "effect";

import {
  type DisplayFlagValues,
  parseDisplayFlags,
  withPreviousTotal,
} from "../cli/commands/costs";

const flags = (over: Partial<DisplayFlagValues>): DisplayFlagValues => ({
  measure: Option.none(),
  bin: Option.none(),
  unit: Option.none(),
  cumulative: false,
  xAxis: Option.none(),
  ...over,
});

const parse = (over: Partial<DisplayFlagValues>) =>
  Effect.runSyncExit(parseDisplayFlags(flags(over)));

describe("costs/reports axis flags", () => {
  it("parses --x-axis in the --group-by spelling", () => {
    expect(parse({ xAxis: Option.some("tag:team") })).toEqual(
      Exit.succeed({ xAxis: "tag", xAxisTagKey: "team" }),
    );
  });

  it("reads date and none as the date bins, and names the flag in errors", () => {
    expect(parse({ xAxis: Option.some("date") })).toEqual(Exit.succeed({ xAxis: "date" }));
    expect(parse({ xAxis: Option.some("none") })).toEqual(Exit.succeed({ xAxis: "date" }));
    const galaxy = parse({ xAxis: Option.some("galaxy") });
    expect(Exit.isFailure(galaxy) && String(galaxy.cause)).toMatch(/--x-axis/);
  });

  it("parses the display options, each omitted unless given", () => {
    expect(parse({})).toEqual(Exit.succeed({}));
    expect(
      parse({
        measure: Option.some("usage"),
        bin: Option.some("Quarter"),
        unit: Option.some(" Hrs "),
        cumulative: true,
      }),
    ).toEqual(
      Exit.succeed({
        measure: "usage",
        binning: "quarterly",
        usageUnit: "Hrs",
        cumulative: true,
      }),
    );
    const bin = parse({ bin: Option.some("fortnight") });
    expect(Exit.isFailure(bin) && String(bin.cause)).toMatch(/--bin must be one of/);
  });

  it("puts the previous period beside the headline total", () => {
    expect(
      withPreviousTotal("$120.00", {
        series: [],
        currencies: ["USD"],
        totals: { USD: 120 },
        previousTotals: { USD: 100 },
      }),
    ).toBe("$120.00 (prev $100.00, +20.0%)");
    expect(
      withPreviousTotal("$120.00", { series: [], currencies: ["USD"], totals: { USD: 120 } }),
    ).toBe("$120.00");
  });
});
