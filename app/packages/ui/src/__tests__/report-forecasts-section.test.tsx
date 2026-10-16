import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CostForecast,
  CostForecastResult,
  CostForecastSeries,
} from "@infrawrench/client-core";
import { ReportForecastsSection } from "../cost-reports/ReportForecastsSection.js";
import type { CostReportsClient } from "../cost-reports/types.js";

function series(over: Partial<CostForecastSeries>): CostForecastSeries {
  return {
    forecastId: null,
    name: "Automatic forecast",
    isDefault: false,
    points: [
      { day: "2026-11-01", expected: 100, low: 80, high: 120 },
      { day: "2026-11-02", expected: 110, low: 85, high: 135 },
    ],
    total: { expected: 210, low: 180, high: 240 },
    deltaFromBaseline: 0,
    scenarios: [],
    driver: null,
    warnings: [],
    ...over,
  };
}

const PLAN: CostForecast = {
  id: "f-1",
  reportId: "r-1",
  name: "EU launch",
  description: null,
  scenarioModelIds: ["m-1"],
  driverMetricId: null,
  isDefault: true,
  createdByUserId: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
};

const RESULT: CostForecastResult = {
  reportId: "r-1",
  reportName: "Platform",
  from: "2026-11-01",
  to: "2026-11-02",
  lastObservedDay: "2026-10-31",
  currency: "USD",
  confidenceLevel: 80,
  baseline: series({}),
  forecast: series({ forecastId: "f-1", name: "EU launch", isDefault: true }),
  forecasts: [
    series({
      forecastId: "f-1",
      name: "EU launch",
      isDefault: true,
      total: { expected: 510, low: 480, high: 540 },
      deltaFromBaseline: 300,
      scenarios: [
        { modelId: "m-1", modelName: "Launch", totalDelta: 300, contributions: [], outOfScope: [] },
      ],
    }),
  ],
};

function makeClient(writable: boolean): CostReportsClient {
  return {
    queryCosts: vi.fn(),
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
    listReports: vi.fn(async () => []),
    getReport: vi.fn(),
    listFolders: vi.fn(async () => []),
    listCostForecasts: vi.fn(async () => [PLAN]),
    runCostForecast: vi.fn(async () => RESULT),
    ...(writable
      ? {
          createCostForecast: vi.fn(),
          updateCostForecast: vi.fn(async () => PLAN),
          deleteCostForecast: vi.fn(async () => undefined),
        }
      : {}),
  } as unknown as CostReportsClient;
}

describe("ReportForecastsSection", () => {
  it("compares the automatic forecast with each named one, with their ranges", async () => {
    const client = makeClient(false);
    render(<ReportForecastsSection reportId="r-1" client={client} />);
    expect(await screen.findByText("EU launch")).toBeTruthy();
    expect(screen.getByText("Automatic (trend)")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getAllByText(/\+.*300/).length).toBeGreaterThan(0);
    expect(client.runCostForecast).toHaveBeenCalledWith("r-1", { all: true, confidenceLevel: 80 });
    // Read-only without the writes: no editing controls.
    expect(screen.queryByText("New forecast")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
  });

  it("unsets the default through a full update", async () => {
    const client = makeClient(true);
    render(<ReportForecastsSection reportId="r-1" client={client} />);
    fireEvent.click(await screen.findByText("Unset default"));
    await waitFor(() =>
      expect(client.updateCostForecast).toHaveBeenCalledWith("r-1", "f-1", {
        name: "EU launch",
        description: null,
        scenarioModelIds: ["m-1"],
        driverMetricId: null,
        isDefault: false,
      }),
    );
  });

  it("renders nothing when the host has no forecast reads", () => {
    const { container } = render(
      <ReportForecastsSection
        reportId="r-1"
        client={
          { ...makeClient(false), listCostForecasts: undefined } as unknown as CostReportsClient
        }
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
