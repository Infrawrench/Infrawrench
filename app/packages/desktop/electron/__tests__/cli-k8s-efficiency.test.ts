import { describe, expect, it } from "vitest";
import { parseEfficiencyGroupBy } from "../cli/commands/k8s-efficiency";

describe("k8s-efficiency --group-by", () => {
  it("accepts the fixed groupings", () => {
    expect(parseEfficiencyGroupBy("namespace")).toEqual({ groupBy: "namespace" });
    expect(parseEfficiencyGroupBy("node_pool")).toEqual({ groupBy: "node_pool" });
    expect(parseEfficiencyGroupBy("category")).toEqual({ groupBy: "category" });
  });

  it("treats anything else as a label key", () => {
    expect(parseEfficiencyGroupBy("k8s_pod_label:team")).toEqual({
      groupBy: "label",
      groupByLabelKey: "k8s_pod_label:team",
    });
    expect(parseEfficiencyGroupBy("tag:capacity_type")).toEqual({
      groupBy: "label",
      groupByLabelKey: "capacity_type",
    });
  });

  it("refuses an empty value", () => {
    expect(() => parseEfficiencyGroupBy("  ")).toThrow(/needs a value/);
  });
});
