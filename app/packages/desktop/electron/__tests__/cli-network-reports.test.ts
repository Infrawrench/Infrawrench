import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `network-reports` over a result built by client-core's own
// `buildNetworkFlowReport`, so a change to the shape the server sends breaks
// here as well as in the build. The command's other paths are pinned in
// `cli-effect-files.test.ts`.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org-1", displayName: "Acme", role: "admin" }]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true })),
  setTokenStoreReadOnly: vi.fn(),
}));

import type { NetworkFlowReport, NetworkFlowReportRunResult } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

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

beforeEach(() => {
  serveRoutes(out, {
    "GET /network-flows/reports": [report],
    "POST /network-flows/reports/r1/run": result,
  });
});

describe("network-reports", () => {
  it("refuses --local", async () => {
    expect(await run("network-reports", "--local")).toBe(1);
    expect(out.stderr).toMatch(/Cloud/);
    expect(out.requests).toEqual([]);
  });

  it("lists reports", async () => {
    expect(await run("network-reports")).toBe(0);
    expect(out.stdout).toContain("Egress by VPC");
  });

  it("runs a report by name, printing estimates and the group table", async () => {
    expect(await run("network-reports", "egress")).toBe(0);
    expect(out.requests).toEqual([
      "GET /network-flows/reports",
      "POST /network-flows/reports/r1/run",
    ]);
    expect(out.stdout).toContain("Estimated from flow logs");
    expect(out.stdout).toContain("vpc-1");
    expect(out.stdout).toContain("2.0 GB");
  });

  it("prints the server's result for --json", async () => {
    expect(await run("network-reports", "r1", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org-1", ...result });
  });

  it("writes the series CSV and refuses an unknown format", async () => {
    expect(await run("network-reports", "r1", "--format", "csv")).toBe(0);
    expect(out.stdout).toContain('"bucket","group","currency","bytes","estimated_cost"');
    expect(await run("network-reports", "r1", "--format", "pdf")).toBe(2);
    expect(out.stderr).toMatch(/pairs-csv/);
  });
});
