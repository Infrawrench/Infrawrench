import { beforeEach, describe, expect, it, vi } from "vitest";

const mockList = vi.fn();
const mockRun = vi.fn();
vi.mock("../../services/commitment-reports", () => ({
  listCommitmentReports: (...args: unknown[]) => mockList(...args),
  runSavedCommitmentReport: (...args: unknown[]) => mockRun(...args),
}));

const { commitmentReportTools } = await import("../commitment-reports");

const auth = { userId: "u1", organizationId: "org-1", source: "chat" as const };
const tool = (name: string) => commitmentReportTools().find((t) => t.name === name)!;
const text = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

const metrics = {
  coverage: 0.5,
  eligibleCoverage: 0.8,
  utilization: 0.9,
  effectiveSavingsRate: 0.1,
  netSavings: 10,
  onDemandRemainder: 50,
  commitmentCost: 55,
  usedCommitmentCost: 50,
  unusedCommitmentCost: 5,
  onDemandEquivalent: 65,
  savingsMeasuredShare: 1,
};
const series = (groupKey: string, buckets: number) => ({
  id: `${groupKey}\u0000USD`,
  groupKey,
  label: groupKey || "USD",
  currency: "USD",
  points: Array.from({ length: buckets }, (_, i) => ({
    bucket: `b${i}`,
    totals: {},
    metrics,
  })),
  total: { totals: {}, metrics },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("commitment report tools", () => {
  it("are read-only and gated on costs:read", () => {
    for (const t of commitmentReportTools()) {
      expect(t.risk).toBe("read");
      expect(t.permission).toBe("costs:read");
    }
  });

  it("lists definitions", async () => {
    mockList.mockResolvedValue([
      {
        id: "r1",
        name: "Coverage",
        description: null,
        config: { version: 1 },
        folderId: null,
        createdByUserId: "u1",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
    const result = await tool("list_commitment_reports").handler({}, auth);
    expect(mockList).toHaveBeenCalledWith("org-1");
    expect(text(result)).toEqual([
      {
        id: "r1",
        name: "Coverage",
        description: null,
        config: { version: 1 },
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
  });

  it("runs a report and trims it for a model", async () => {
    mockRun.mockResolvedValue({
      reportId: "r1",
      name: "Coverage",
      from: "2026-01-01",
      to: "2026-03-01",
      granularity: "daily",
      groupBy: "service",
      buckets: [],
      series: Array.from({ length: 55 }, (_, i) => series(`svc-${i}`, 70)),
      overall: [series("", 70)],
      providers: [],
      notices: ["partial_savings_measurement"],
    });
    const out = text(await tool("run_commitment_report").handler({ reportId: "r1" }, auth));
    expect(mockRun).toHaveBeenCalledWith("org-1", "r1");
    expect(out.overall[0].trend).toHaveLength(60);
    expect(out.overall[0].trend[0]).toEqual({ bucket: "b10", ...metrics });
    expect(out.overall[0].trendBucketsOmitted).toBe(10);
    expect(out.groups).toHaveLength(50);
    expect(out.groups[0]).toEqual({
      groupKey: "svc-0",
      label: "svc-0",
      currency: "USD",
      ...metrics,
    });
    expect(out.groupsOmitted).toBe(5);
    expect(out.notices).toEqual(["partial_savings_measurement"]);
  });

  it("says when the report is not there", async () => {
    mockRun.mockResolvedValue(null);
    const result = await tool("run_commitment_report").handler({ reportId: "nope" }, auth);
    expect(result.isError).toBe(true);
  });
});
