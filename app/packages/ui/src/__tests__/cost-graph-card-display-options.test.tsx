import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import type { CostGraphConfig, CostQueryResponse } from "../cost/config.js";
import type { CostApi } from "../cost/types.js";

/**
 * The display options on the card: the table view renders real table
 * semantics, and a count or usage card never wears a currency sign.
 */

const CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "table",
  binning: "quarterly",
  dateRange: { kind: "absolute", from: "2026-01-01", to: "2026-09-30" },
  groupBy: "service",
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: false,
};

function makeApi(response: CostQueryResponse): CostApi {
  return {
    queryCosts: vi.fn(async () => response),
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
  } as unknown as CostApi;
}

describe("CostGraphCard display options", () => {
  it("renders the table view with a row per bucket and quarter labels", async () => {
    const api = makeApi({
      series: [
        {
          key: "ec2",
          label: "EC2",
          currency: "USD",
          points: [
            { bucket: "2026-04-01", amount: 100 },
            { bucket: "2026-07-01", amount: 200 },
          ],
        },
        {
          key: "s3",
          label: "S3",
          currency: "USD",
          points: [{ bucket: "2026-07-01", amount: 50 }],
        },
      ],
      currencies: ["USD"],
      totals: { USD: 350 },
    });
    render(<CostGraphCard title="Spend" config={CONFIG} api={api} />);

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    // Header plus one row per quarter.
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole("rowheader")).toHaveTextContent("Q2 2026");
    expect(within(rows[2]!).getByRole("rowheader")).toHaveTextContent("Q3 2026");
    expect(within(table).getByRole("columnheader", { name: "Total" })).toBeInTheDocument();
  });

  it("prints a count without a currency and says what it counts", async () => {
    const api = makeApi({
      series: [
        {
          key: "",
          label: "Service count",
          currency: "",
          points: [
            { bucket: "2026-04-01", amount: 12 },
            { bucket: "2026-07-01", amount: 14 },
          ],
        },
      ],
      currencies: [""],
      totals: { "": 17 },
      measure: "count",
    });
    render(
      <CostGraphCard title="Services billed" config={{ ...CONFIG, measure: "count" }} api={api} />,
    );

    expect(await screen.findByText(/Distinct values with nonzero cost/)).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "Services billed" });
    expect(heading.parentElement?.textContent).toBe("Services billed17");
  });
});
