import { describe, expect, it } from "vitest";

import {
  businessMetricLabelsFromKey,
  businessMetricLabelsKey,
  unitCostQueryForConfig,
  unitCostUnitLabel,
} from "../business-metrics";
import { DEFAULT_COST_GRAPH_CONFIG } from "../costs";

describe("businessMetricLabelsKey", () => {
  it("is empty for no labels, so unlabelled rows keep the old restatement key", () => {
    expect(businessMetricLabelsKey({})).toBe("");
    expect(businessMetricLabelsKey({ plan: "  " })).toBe("");
  });

  it("is order- and case-insensitive on keys", () => {
    expect(businessMetricLabelsKey({ Plan: "pro", customer: "acme" })).toBe(
      businessMetricLabelsKey({ customer: "acme", plan: "pro" }),
    );
  });

  it("stores a lone default label as its bare value and round-trips it", () => {
    expect(businessMetricLabelsKey({ label: "acme" })).toBe("acme");
    expect(businessMetricLabelsFromKey("acme")).toEqual({ label: "acme" });
    const key = businessMetricLabelsKey({ customer: "acme", plan: "pro" });
    expect(businessMetricLabelsFromKey(key)).toEqual({ customer: "acme", plan: "pro" });
  });
});

describe("unit-cost config and labels", () => {
  it("carries scale, label filters and split into the request, and drops scale for margin", () => {
    const request = unitCostQueryForConfig({
      ...DEFAULT_COST_GRAPH_CONFIG,
      unitCostMetricId: "m1",
      unitCostScale: 1000,
      unitCostGroupByLabel: "customer",
      unitCostLabelFilters: [{ key: "plan", op: "in", values: ["pro"] }],
    });
    expect(request.scale).toBe(1000);
    expect(request.groupByLabel).toBe("customer");
    expect(request.labelFilters).toEqual([{ key: "plan", op: "in", values: ["pro"] }]);
    const margin = unitCostQueryForConfig({
      ...DEFAULT_COST_GRAPH_CONFIG,
      unitCostMetricId: "m1",
      unitCostMode: "margin",
      unitCostScale: 1000,
    });
    expect(margin.scale).toBeUndefined();
  });

  it("names a scaled unit and a usage unit", () => {
    expect(unitCostUnitLabel({ unit: "request" }, "unit_cost", "USD", 1000)).toBe(
      "USD per 1K request",
    );
    expect(unitCostUnitLabel(null, "usage_unit_cost", "USD", 1, "GB-Mo")).toBe("USD per GB-Mo");
    expect(unitCostUnitLabel({ unit: "signup" }, "raw_metric", "USD", 1000)).toBe("1K signup");
  });
});
