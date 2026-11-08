import { describe, expect, it } from "vitest";

import {
  formatUnitCostRatio,
  parseUnitCostLabelFlag,
  parseUnitCostModeFlag,
  parseUnitCostScaleFlag,
  unitCostRatioLabel,
} from "../cli/format";

describe("unit-costs calculation flags", () => {
  it("parses --scale and --mode in their short and long spellings", () => {
    expect(parseUnitCostScaleFlag("1k")).toBe(1000);
    expect(parseUnitCostScaleFlag("1000000")).toBe(1_000_000);
    expect(parseUnitCostModeFlag("raw")).toBe("raw_metric");
    expect(parseUnitCostModeFlag("usage-unit-cost")).toBe("usage_unit_cost");
    expect(parseUnitCostModeFlag(undefined)).toBeNull();
  });

  it("reads key=values as `in` and key!=values as `not_in`", () => {
    expect(parseUnitCostLabelFlag("Plan=pro, enterprise")).toEqual({
      key: "plan",
      op: "in",
      values: ["pro", "enterprise"],
    });
    expect(parseUnitCostLabelFlag("region!=eu")).toEqual({
      key: "region",
      op: "not_in",
      values: ["eu"],
    });
    expect(() => parseUnitCostLabelFlag("nope")).toThrow(/key=value/);
  });

  it("rejects an unknown scale or mode", () => {
    expect(() => parseUnitCostScaleFlag("7")).toThrow(/--scale/);
    expect(() => parseUnitCostModeFlag("ratio")).toThrow(/--mode/);
  });

  it("labels a scaled column and keeps the gap a dash in raw mode", () => {
    expect(unitCostRatioLabel("unit_cost", "USD", "request", 1000000)).toBe("USD/1M request");
    expect(unitCostRatioLabel("raw_metric", "USD", "signup", 1000)).toBe("1K signup");
    expect(formatUnitCostRatio(null, "raw_metric")).toBe("—");
    expect(formatUnitCostRatio(0, "raw_metric")).toBe("0");
  });
});
