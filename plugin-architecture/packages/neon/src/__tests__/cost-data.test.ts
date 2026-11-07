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
      expect.objectContaining({ from: "2026-06-08T00:00:00Z", to: "2026-08-07T00:00:00Z" }),
    );
  });

  it("asks for a single-day range with an exclusive next-midnight `to`", async () => {
    // Neon rounds `to` down to the day, so an end-of-day bound made from == to
    // and failed the whole request with 400.
    await fetchNeonCostData(apiClient, { fromDate: "2026-07-31", toDate: "2026-07-31" });
    expect(api.getConsumptionHistoryPerProjectV2).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-07-31T00:00:00Z", to: "2026-08-01T00:00:00Z" }),
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

describe("fetchNeonCostData reads every page or fails", () => {
  const range = { fromDate: "2026-08-03", toDate: "2026-08-06" };
  const httpError = (status: number) =>
    Object.assign(new Error(`status ${status}`), { response: { status } });

  it("throws at the page cap instead of dropping the projects past it", async () => {
    api.getConsumptionHistoryPerProjectV2.mockImplementation(async () => ({
      data: { projects: [{ project_id: "p", periods: [] }], pagination: { cursor: "again" } },
    }));
    await expect(fetchNeonCostData(apiClient, range)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(api.getConsumptionHistoryPerProjectV2).toHaveBeenCalledTimes(1000);
  });

  it("refuses a page with no project list instead of reading it as no spend", async () => {
    api.getConsumptionHistoryPerProjectV2.mockResolvedValue({ data: { items: [] } });
    await expect(fetchNeonCostData(apiClient, range)).rejects.toThrow("is not a list");
  });

  it("reads a null project list as no spend", async () => {
    api.getConsumptionHistoryPerProjectV2.mockResolvedValue({ data: { projects: null } });
    await expect(fetchNeonCostData(apiClient, range)).resolves.toEqual([]);
  });

  describe("deriving the organization from projects", () => {
    const listProjects = vi.fn();
    const getOrganization = vi.fn();
    const withProjects = { ...api, listProjects, getOrganization } as unknown as Api<unknown>;

    beforeEach(() => {
      listProjects.mockReset();
      getOrganization.mockReset();
      getOrganization.mockResolvedValue({ data: { id: "org-2", plan: "launch" } });
    });

    it("falls back when the key is refused the organization list", async () => {
      api.getCurrentUserOrganizations.mockRejectedValue(httpError(403));
      listProjects.mockResolvedValue({
        data: { projects: [{ id: "p1", org_id: "org-2" }] },
      });
      await expect(fetchNeonCostData(withProjects, range)).resolves.toEqual([]);
      expect(listProjects).toHaveBeenCalledWith({ limit: 400 });
      expect(api.getConsumptionHistoryPerProjectV2).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: "org-2" }),
      );
    });

    it.each([429, 500, 503])("fails on a %i rather than losing organizations", async (status) => {
      api.getCurrentUserOrganizations.mockRejectedValue(httpError(status));
      await expect(fetchNeonCostData(withProjects, range)).rejects.toMatchObject({
        response: { status },
      });
      expect(listProjects).not.toHaveBeenCalled();
    });

    it("fails on a failure with no status", async () => {
      api.getCurrentUserOrganizations.mockRejectedValue(new Error("socket hang up"));
      await expect(fetchNeonCostData(withProjects, range)).rejects.toThrow("socket hang up");
      expect(listProjects).not.toHaveBeenCalled();
    });

    it("reads organizations past the first 50 pages, and throws at the cap", async () => {
      api.getCurrentUserOrganizations.mockRejectedValue(httpError(403));
      listProjects.mockImplementation(async () => ({
        data: { projects: [{ id: "p", org_id: "org-2" }], pagination: { cursor: "again" } },
      }));
      await expect(fetchNeonCostData(withProjects, range)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(listProjects).toHaveBeenCalledTimes(250);
    });
  });
});
