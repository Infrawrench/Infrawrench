import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import type { CostGraphConfig, CostQueryResponse } from "../cost/config.js";
import type { CostApi } from "../cost/types.js";

/**
 * The card's headline total is money, and the slot it sits in is next to the
 * title. Anything falsy-but-renderable landing there — a `0`, an empty amount —
 * reads as a real figure to whoever screenshots the card, so the slot has to
 * draw the total or draw nothing at all.
 */

const CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "absolute", from: "2026-07-13", to: "2026-07-14" },
  groupBy: "provider",
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

describe("CostGraphCard headline total", () => {
  it("draws nothing beside the title when the period has no totals", async () => {
    const api = makeApi({ series: [], currencies: [], totals: {} });
    render(<CostGraphCard title="Spend" config={CONFIG} api={api} />);

    // Wait for the query to settle — before that there is trivially no total.
    expect(await screen.findByText("No cost data for this period yet")).toBeInTheDocument();

    const heading = screen.getByRole("heading", { name: "Spend" });
    // The title's row holds the title and nothing else: no empty amount, and
    // above all no bare number the reader could mistake for spend.
    expect(heading.parentElement?.textContent).toBe("Spend");
  });

  it("draws the total beside the title when there is one", async () => {
    const api = makeApi({
      series: [
        {
          key: "aws",
          label: "AWS",
          currency: "USD",
          points: [
            { bucket: "2026-07-13", amount: 250 },
            { bucket: "2026-07-14", amount: 350 },
          ],
        },
      ],
      currencies: ["USD"],
      totals: { USD: 600 },
    });
    render(<CostGraphCard title="Spend" config={CONFIG} api={api} />);

    await waitFor(() => {
      const heading = screen.getByRole("heading", { name: "Spend" });
      expect(heading.parentElement?.textContent).toMatch(/600/);
    });
  });
});
