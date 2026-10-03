import { describe, it, expect, vi } from "vitest";
import type { Api } from "@neondatabase/api-client";
import { fetchBranchLogs } from "../logs.js";
import { fetchProjectUsageSeries } from "../metrics.js";

function fakeApi(methods: Record<string, unknown>): Api<unknown> {
  return methods as unknown as Api<unknown>;
}

describe("fetchBranchLogs", () => {
  it("queries the branch's logs newest first and prints them oldest first", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        logs: [
          {
            timestamp: "2026-10-03T10:00:02Z",
            message: "connection authorized",
            source: "pg_endpoint",
            severity_text: "info",
            attributes: {},
          },
          {
            timestamp: "2026-10-03T10:00:01Z",
            message: '{"operation":"GET"}',
            source: "storage",
            service_name: "neon-storage",
            severity_text: "warn",
            attributes: {},
          },
        ],
        is_truncated: false,
      },
    });
    const result = await fetchBranchLogs(fakeApi({ request }), "p1", "br-1", {
      tailLines: 50,
      container: "postgres",
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/projects/p1/branches/br-1/logs/query",
        method: "POST",
        body: { since: "24h", limit: 50, sort_order: "desc", source: "pg_endpoint" },
        secure: true,
        type: "application/json",
      }),
    );
    expect(result.containers).toEqual(["all", "postgres", "storage", "functions"]);
    expect(result.activeContainer).toBe("postgres");
    expect(result.text).toBe(
      '2026-10-03T10:00:01Z  WARN  [neon-storage]  {"operation":"GET"}\n' +
        "2026-10-03T10:00:02Z  INFO  [pg_endpoint]  connection authorized\n",
    );
  });

  it("omits the source filter for every source and caps the page at 1000", async () => {
    const request = vi.fn().mockResolvedValue({ data: { logs: [], is_truncated: false } });
    const result = await fetchBranchLogs(fakeApi({ request }), "p1", "br-1", {
      tailLines: 5000,
      container: "nope",
    });
    expect(request.mock.calls[0]![0].body).toEqual({
      since: "24h",
      limit: 1000,
      sort_order: "desc",
    });
    expect(result.activeContainer).toBe("all");
    expect(result.text).toBe("No log records in the last 24h.\n");
  });

  it("explains a branch without telemetry instead of failing", async () => {
    const request = vi.fn().mockRejectedValue({
      response: {
        status: 404,
        data: { code: "LOGS_NOT_AVAILABLE", reason: "telemetry_not_enabled" },
      },
    });
    const result = await fetchBranchLogs(fakeApi({ request }), "p1", "br-1", {});
    expect(result.text).toMatch(/not collecting telemetry/);
  });

  it("rethrows other failures", async () => {
    const request = vi.fn().mockRejectedValue({ response: { status: 500 } });
    await expect(fetchBranchLogs(fakeApi({ request }), "p1", "br-1", {})).rejects.toBeTruthy();
  });
});

describe("project usage series", () => {
  it("asks for and charts snapshot storage and extra branches", async () => {
    const getConsumptionHistoryPerProjectV2 = vi.fn().mockResolvedValue({
      data: {
        projects: [
          {
            project_id: "p1",
            periods: [
              {
                consumption: [
                  {
                    timeframe_start: "2026-10-03T00:00:00Z",
                    metrics: [
                      { metric_name: "snapshot_storage_bytes_month", value: 2 ** 31 },
                      { metric_name: "extra_branches_month", value: 0.5 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const series = await fetchProjectUsageSeries(
      fakeApi({ getConsumptionHistoryPerProjectV2 }),
      "org-1",
      "p1",
    );
    const asked = getConsumptionHistoryPerProjectV2.mock.calls[0]![0].metrics as string[];
    expect(asked).toContain("snapshot_storage_bytes_month");
    expect(asked).toContain("extra_branches_month");
    const at = Date.parse("2026-10-03T00:00:00Z");
    expect(series).toEqual([
      { label: "Snapshot Storage", unit: "GB-month", points: [{ timestamp: at, value: 2 }] },
      { label: "Extra Branches", unit: "branch-months", points: [{ timestamp: at, value: 0.5 }] },
    ]);
  });
});
