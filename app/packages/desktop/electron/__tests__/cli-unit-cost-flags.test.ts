import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../cli/args";
import {
  formatUnitCostRatio,
  parseUnitCostLabelFlag,
  parseUnitCostModeFlag,
  parseUnitCostScaleFlag,
  unitCostRatioLabel,
} from "../cli/format";

describe("unit-costs calculation flags", () => {
  it("parses --label, --split, --scale, --mode and the usage forms", () => {
    const parsed = parseCliArgs([
      "unit-costs",
      "revenue",
      "--label",
      "plan=pro,enterprise",
      "--label",
      "region!=eu",
      "--split",
      "customer",
      "--scale",
      "1k",
      "--mode",
      "raw",
    ]);
    expect(parsed.unitCost.labels).toEqual(["plan=pro,enterprise", "region!=eu"]);
    expect(parsed.unitCost.split).toBe("customer");
    expect(parseUnitCostScaleFlag(parsed.unitCost.scale)).toBe(1000);
    expect(parseUnitCostModeFlag(parsed.unitCost.mode)).toBe("raw_metric");
    expect(parseCliArgs(["unit-costs", "--usage-units"]).unitCost.listUsageUnits).toBe(true);
    expect(parseCliArgs(["unit-costs", "--usage-unit", "GB-Mo"]).unitCost.usageUnit).toBe("GB-Mo");
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
