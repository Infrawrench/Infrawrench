import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../cli/args";
import { parseDisplayFlags, withPreviousTotal } from "../cli/commands/costs";

describe("costs/reports axis flags", () => {
  it("parses --x-axis in the --group-by spelling, --segment-by-date and --compare", () => {
    const parsed = parseCliArgs([
      "costs",
      "--x-axis",
      "tag:team",
      "--segment-by-date",
      "--compare",
    ]);
    expect(parsed.range.xAxis).toBe("tag:team");
    expect(parsed.range.segmentByDate).toBe(true);
    expect(parsed.range.compare).toBe(true);
    expect(parseDisplayFlags(parsed.range)).toEqual({ xAxis: "tag", xAxisTagKey: "team" });
  });

  it("reads date and none as the date bins, and names the flag in errors", () => {
    expect(parseDisplayFlags(parseCliArgs(["reports", "x", "--x-axis", "date"]).range)).toEqual({
      xAxis: "date",
    });
    expect(parseDisplayFlags(parseCliArgs(["costs", "--x-axis", "none"]).range)).toEqual({
      xAxis: "date",
    });
    expect(() => parseDisplayFlags(parseCliArgs(["costs", "--x-axis", "galaxy"]).range)).toThrow(
      /--x-axis/,
    );
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
