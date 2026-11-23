import { describe, expect, it } from "vitest";
import { metricTarget } from "../metrics.js";
import { plugin } from "../plugin.js";

describe("rds capacity", () => {
  it("names series both the MySQL and the PostgreSQL metric sets emit", () => {
    const type = plugin.resourceTypes.find((t) => t.id === "rds-instance")!;
    const declared = (type.capacityMetrics ?? []).map((m) => m.seriesLabel);
    expect(declared).toEqual(["Disk Utilization", "Connection Utilization"]);
    const target = metricTarget("rds-instance", "cn-hangzhou", "rm-1")!;
    for (const specs of [target.specs, target.fallbackSpecs ?? []]) {
      const labels = specs.map((s) => s.label);
      for (const label of declared) expect(labels).toContain(label);
    }
  });
});
