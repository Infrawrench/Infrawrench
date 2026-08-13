import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const api = {
  getCurrentUserOrganizations: vi.fn(),
  getConsumptionHistoryPerProjectV2: vi.fn(),
};

vi.mock("@neondatabase/api-client", () => ({
  ConsumptionHistoryGranularity: { Daily: "daily" },
}));

import { fetchNeonCostData } from "../cost-data";
import type { Api } from "@neondatabase/api-client";

/** The two stubbed endpoints stand in for the full generated client. */
const apiClient = api as unknown as Api<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
  api.getCurrentUserOrganizations.mockResolvedValue({
    data: { organizations: [{ id: "org-1", plan: "launch" }] },
  });
  api.getConsumptionHistoryPerProjectV2.mockResolvedValue({
    data: { projects: [], pagination: undefined },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchNeonCostData retention clamping", () => {
  it("clamps a backfill start older than Neon's 60-day retention to 59 days", async () => {
    await fetchNeonCostData(apiClient, { fromDate: "2026-05-08", toDate: "2026-08-06" });
    // 59 days before 2026-08-06 is 2026-06-08; asking for 2026-05-08 would 406.
    expect(api.getConsumptionHistoryPerProjectV2).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-06-08T00:00:00Z", to: "2026-08-06T23:59:59Z" }),
    );
  });

  it("leaves an in-window range untouched", async () => {
    await fetchNeonCostData(apiClient, { fromDate: "2026-08-03", toDate: "2026-08-06" });
    expect(api.getConsumptionHistoryPerProjectV2).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-08-03T00:00:00Z" }),
    );
  });

  it("returns no rows without calling the API when the range is entirely outside retention", async () => {
    const rows = await fetchNeonCostData(apiClient, {
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    expect(rows).toEqual([]);
    expect(api.getConsumptionHistoryPerProjectV2).not.toHaveBeenCalled();
  });

  it("converts consumption metrics to dollar rows inside the window", async () => {
    api.getConsumptionHistoryPerProjectV2.mockResolvedValue({
      data: {
        projects: [
          {
            project_id: "proj-1",
            periods: [
              {
                consumption: [
                  {
                    timeframe_start: "2026-08-05T00:00:00Z",
                    metrics: [{ metric_name: "compute_unit_seconds", value: 7200 }],
                  },
                ],
              },
            ],
          },
        ],
        pagination: undefined,
      },
    });
    const rows = await fetchNeonCostData(apiClient, {
      fromDate: "2026-08-03",
      toDate: "2026-08-06",
    });
    expect(rows).toEqual([
      {
        date: "2026-08-05",
        service: "Compute",
        resourceId: "proj-1",
        currency: "USD",
        amount: (7200 / 3600) * 0.106,
      },
    ]);
  });
});
