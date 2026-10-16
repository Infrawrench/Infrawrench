import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COST_GRAPH_CONFIG } from "../cost";
import type { CostApi } from "../cost";
import { UnitCostCard } from "../cost/UnitCostCard";
import type { CostGraphConfig } from "../cost";

const config: CostGraphConfig = {
  ...DEFAULT_COST_GRAPH_CONFIG,
  unitCostMode: "unit_cost",
  unitCostMetricId: "m1",
};

describe("UnitCostCard", () => {
  it("queries once per config, not once per render", async () => {
    // Each response re-renders the card; the query effect must not depend on
    // anything that changes per render (it once listed `gt`, and looped).
    const queryUnitCosts = vi.fn().mockResolvedValue({
      mode: "unit_cost",
      scale: 1,
      series: [],
      buckets: [],
      metric: { id: "m1", name: "Orders" },
      gaps: [],
    });
    const api = { queryUnitCosts } as unknown as CostApi;
    render(<UnitCostCard title="Cost per order" config={config} api={api} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(queryUnitCosts).toHaveBeenCalledTimes(1);
  });

  it("says what is missing when the host cannot query a metric", async () => {
    render(<UnitCostCard title="Cost per order" config={config} api={{} as CostApi} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs a business metric/);
  });
});
