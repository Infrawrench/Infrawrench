import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const fetches = vi.hoisted(() => ({ orgFetch: vi.fn() }));
vi.mock("../cli/context", () => ({
  CliError: class CliError extends Error {
    constructor(
      message: string,
      readonly exitCode = 1,
    ) {
      super(message);
    }
  },
  orgFetch: fetches.orgFetch,
  resolveOrg: async () => ({ id: "org-1", displayName: "Acme" }),
}));

import type { NetworkFlowReport, NetworkFlowReportRunResult } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { parseCliArgs } from "../cli/args";
import { cmdNetworkReports } from "../cli/commands/network-reports";
import type { CliContext } from "../cli/context";
import { setColorEnabled } from "../cli/output";

beforeAll(() => setColorEnabled(false));

// Built from client-core in beforeAll: this test compiles as CommonJS and
// client-core is ESM, so it is imported dynamically.
let report: NetworkFlowReport;
let result: NetworkFlowReportRunResult;
beforeAll(async () => {
  const core = await import("@infrawrench/client-core");
  report = {
    id: "r1",
    name: "Egress by VPC",
    description: null,
    config: { ...core.DEFAULT_NETWORK_FLOW_REPORT_CONFIG, groupBy: "network" },
    folderId: null,
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const figures = { ...core.emptyNetworkFlowReportTotals(), bytes: 2e9, estimatedCost: 0.18 };
  result = {
    ...core.buildNetworkFlowReport({
      from: "2026-10-01",
      to: "2026-10-02",
      granularity: "daily",
      groupBy: "network",
      metric: "both",
      overallCells: [{ bucket: "2026-10-01", groupKey: "", currency: "USD", ...figures }],
      seriesCells: [],
      groups: [{ groupKey: "vpc-1", label: "vpc-1", currency: "USD", pairCount: 3, ...figures }],
      topTalkers: [],
      topN: 25,
    }),
    reportId: "r1",
    name: "Egress by VPC",
  };
});

function ctx(overrides: Partial<CliContext["flags"]> = {}): CliContext {
  return { flags: { output: "text", ...overrides } } as unknown as CliContext;
}

let out: string[] = [];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    out.push(String(line ?? ""));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  fetches.orgFetch.mockReset();
  fetches.orgFetch.mockImplementation(async (_org: string, path: string) =>
    path === "/network-flows/reports" ? [report] : result,
  );
});
afterEach(() => vi.restoreAllMocks());

describe("network-reports", () => {
  it("parses --format and --out", () => {
    const parsed = parseCliArgs([
      "network-reports",
      "Egress by VPC",
      "--format",
      "pairs-csv",
      "--out",
      "x.csv",
    ]);
    expect(parsed.positionals).toEqual(["network-reports", "Egress by VPC"]);
    expect(parsed.exportFlags.format).toBe("pairs-csv");
    expect(parsed.exportFlags.out).toBe("x.csv");
  });

  it("refuses --local", async () => {
    await expect(cmdNetworkReports(ctx({ local: true }), "", {})).rejects.toThrow(/Cloud/);
  });

  it("lists reports", async () => {
    await cmdNetworkReports(ctx(), "", {});
    expect(out.join("\n")).toContain("Egress by VPC");
  });

  it("runs a report by name, printing estimates and the group table", async () => {
    await cmdNetworkReports(ctx(), "egress", {});
    expect(fetches.orgFetch).toHaveBeenCalledWith("org-1", "/network-flows/reports/r1/run", {
      method: "POST",
      body: "{}",
    });
    const text = out.join("\n");
    expect(text).toContain("Estimated from flow logs");
    expect(text).toContain("vpc-1");
    expect(text).toContain("2.0 GB");
  });

  it("prints the server's result for --json", async () => {
    await cmdNetworkReports(ctx({ output: "json" }), "r1", {});
    expect(JSON.parse(out.join(""))).toMatchObject({ org: "org-1", reportId: "r1" });
  });

  it("writes the series CSV and refuses an unknown format", async () => {
    await cmdNetworkReports(ctx(), "r1", { format: "csv" });
    expect(out.join("")).toContain('"bucket","group","currency","bytes","estimated_cost"');
    await expect(cmdNetworkReports(ctx(), "r1", { format: "pdf" })).rejects.toThrow(/pairs-csv/);
  });
});
