import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `commitments reports` and `commitments report` over results built by
// client-core's own `buildCommitmentReport`, so a change to the shape the
// server sends breaks here as well as in the build. The text output is pinned
// in `cli-effect-files.test.ts`; this file covers the flags, the config the
// ad-hoc query sends, and the refusals.
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

import type {
  CommitmentReport,
  CommitmentReportOptions,
  CommitmentReportResult,
  CommitmentReportRunResult,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { RawResponse, run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const NOW = new Date("2026-11-08T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iw-cli-commitments-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OPTIONS: CommitmentReportOptions = {
  providers: [
    { pluginId: "aws", displayName: "AWS", status: "measured" },
    { pluginId: "gcp", displayName: "Google Cloud", status: "inventory_only" },
  ],
  accounts: [
    { id: "acc-prod", name: "prod", pluginId: "aws" },
    { id: "acc-stage", name: "staging", pluginId: "aws" },
  ],
  services: ["Amazon Elastic Compute Cloud", "Amazon Relational Database Service"],
  regions: ["us-east-1", "eu-west-1"],
  commitments: [
    {
      commitmentId: "arn:aws:savingsplans::1:savingsplan/sp-1",
      accountId: "acc-prod",
      pluginId: "aws",
      kind: "savings_plan",
      description: "Compute Savings Plan",
      state: "active",
    },
  ],
};

// Built from client-core in beforeAll: this test compiles as CommonJS and
// client-core is ESM, so it is imported dynamically.
let report: CommitmentReport;
let result: CommitmentReportResult;
let runResult: CommitmentReportRunResult;
let csvOf: (r: CommitmentReportResult) => string;
beforeAll(async () => {
  const core = await import("@infrawrench/client-core");
  csvOf = core.commitmentReportToCsv;
  report = {
    id: "cr1",
    name: "EC2 coverage",
    description: null,
    config: { ...core.DEFAULT_COMMITMENT_REPORT_CONFIG, groupBy: "service", metric: "utilization" },
    folderId: null,
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const cell = (bucket: string, groupKey: string, covered: number, uncovered: number) => ({
    ...core.emptyCommitmentReportTotals(),
    bucket,
    groupKey,
    currency: "USD",
    covered,
    coveredAll: covered,
    unused: 10,
    uncovered,
    uncoveredEligible: uncovered,
    coveredOnDemand: covered * 1.4,
    coveredMeasured: covered,
  });
  result = core.buildCommitmentReport(
    [
      cell("2026-10-05", "Amazon Elastic Compute Cloud", 300, 100),
      cell("2026-10-12", "Amazon Elastic Compute Cloud", 320, 80),
    ],
    {
      from: "2026-10-05",
      to: "2026-10-18",
      granularity: "weekly",
      groupBy: "service",
      labels: new Map([["Amazon Elastic Compute Cloud", "Amazon Elastic Compute Cloud"]]),
      providers: [{ pluginId: "aws", displayName: "AWS", status: "measured", accountCount: 2 }],
      notices: ["unused_lumped_monthly"],
    },
  );
  runResult = { ...result, reportId: "cr1", name: "EC2 coverage" };
});

/** The body of the one POST to the ad-hoc query, parsed. */
function sentConfig(): unknown {
  const call = vi
    .mocked(fetch)
    .mock.calls.find(([url]) => String(url).endsWith("/commitments/report-query"));
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

describe("commitments reports", () => {
  beforeEach(() => {
    serveRoutes(out, {
      "GET /commitments/reports": [report],
      "POST /commitments/reports/cr1/run": runResult,
    });
  });

  it("refuses --local before any request", async () => {
    expect(await run("commitments", "reports", "--local")).toBe(1);
    expect(out.stderr).toMatch(/Infrawrench Cloud/);
    expect(out.requests).toEqual([]);
  });

  it("lists reports with their chart metric", async () => {
    expect(await run("commitments", "reports")).toBe(0);
    expect(out.stdout).toContain("EC2 coverage");
    expect(out.stdout).toContain("Utilization");
    expect(out.requests).toEqual(["GET /commitments/reports"]);
  });

  it("runs one by name, charting the saved metric unless --metric picks another", async () => {
    expect(await run("commitments", "reports", "ec2")).toBe(0);
    expect(out.requests).toEqual(["GET /commitments/reports", "POST /commitments/reports/cr1/run"]);
    expect(out.stdout).toContain("     Utilization  ");
    expect(out.stdout).toContain("Amazon Elastic Compute Cloud");
    expect(out.stdout).toContain("use monthly granularity");

    out.stdout = "";
    expect(await run("commitments", "reports", "EC2", "coverage", "--metric", "netSavings")).toBe(
      0,
    );
    expect(out.stdout).toContain("     Net savings vs on-demand  ");
  });

  it("refuses a metric it does not know at parse time", async () => {
    expect(await run("commitments", "reports", "ec2", "--metric", "savings")).toBe(2);
    expect(out.stderr).toContain("effectiveSavingsRate");
    expect(out.requests).toEqual([]);
  });

  it("prints the server's result under --json", async () => {
    expect(await run("commitments", "reports", "cr1", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org-1", ...runResult });
  });

  it("writes client-core's CSV to stdout or --out", async () => {
    expect(await run("commitments", "reports", "cr1", "--format", "csv")).toBe(0);
    expect(out.stdout).toBe(csvOf(runResult));

    const path = join(dir, "ec2.csv");
    out.stdout = "";
    expect(await run("commitments", "reports", "cr1", "--format", "csv", "--out", path)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(csvOf(runResult));
    expect(out.stdout).toContain(`Wrote ${path}`);

    expect(await run("commitments", "reports", "cr1", "--format", "pairs-csv")).toBe(2);
    expect(out.stderr).toContain("--format takes csv for commitment reports.");
  });

  it("passes --json through even when the text could not decode it", async () => {
    const reshaped = { ...runResult, series: [{ id: "x", reshaped: true }] };
    serveRoutes(out, {
      "GET /commitments/reports": [report],
      "POST /commitments/reports/cr1/run": reshaped,
    });
    expect(await run("commitments", "reports", "cr1", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org-1", ...reshaped });
    expect(await run("commitments", "reports", "cr1")).toBe(1);
    expect(out.stderr).toContain("malformed response for /commitments/reports/cr1/run");
  });

  it("names a report it cannot find", async () => {
    expect(await run("commitments", "reports", "nope")).toBe(1);
    expect(out.stderr).toContain('No commitment report named "nope"');
  });

  it("renders a grouping and a notice a newer server added, and still writes the CSV", async () => {
    const newer = {
      ...runResult,
      groupBy: "instance_family",
      notices: ["a_future_notice"],
      series: runResult.series.map((s) => ({ ...s, label: "m5" })),
    };
    serveRoutes(out, {
      "GET /commitments/reports": [report],
      "POST /commitments/reports/cr1/run": newer,
    });
    expect(await run("commitments", "reports", "cr1")).toBe(0);
    expect(out.stdout).toContain("by instance_family");
    expect(out.stdout).toContain("a_future_notice");
    expect(out.stdout).toContain("m5");
    out.stdout = "";
    expect(await run("commitments", "reports", "cr1", "--format", "csv")).toBe(0);
    expect(out.stdout).toContain('"m5"');
  });
});

describe("commitments report", () => {
  beforeEach(() => {
    serveRoutes(out, {
      "GET /commitments/report-options": OPTIONS,
      "POST /commitments/report-query": result,
    });
  });

  it("sends the editor's default config without flags, and reads no options", async () => {
    expect(await run("commitments", "report")).toBe(0);
    expect(out.requests).toEqual(["POST /commitments/report-query"]);
    expect(sentConfig()).toEqual({
      version: 1,
      dateRange: { kind: "relative", preset: "90d" },
      granularity: "weekly",
      groupBy: "none",
      filters: {},
      metric: "coverage",
    });
    expect(out.stdout).toContain("Acme");
  });

  it("carries the range, bin, grouping, metric and resolved filters into a canonical config", async () => {
    expect(
      await run(
        "commitments",
        "report",
        "--last",
        "180d",
        "--bin",
        "month",
        "--group-by",
        "commitment_type",
        "--metric",
        "utilization",
        "--provider",
        "AWS",
        "--provider",
        "aws",
        "-a",
        "PROD",
        "--service",
        "amazon elastic compute cloud",
        "--region",
        "us-east-1",
        "--commitment-type",
        "savings_plan",
        "--commitment",
        "compute savings plan",
      ),
    ).toBe(0);
    expect(out.requests).toEqual([
      "GET /commitments/report-options",
      "POST /commitments/report-query",
    ]);
    expect(sentConfig()).toEqual({
      version: 1,
      dateRange: { kind: "absolute", from: "2026-05-13", to: "2026-11-08" },
      granularity: "monthly",
      groupBy: "commitment_type",
      filters: {
        providers: ["aws"],
        commitmentTypes: ["savings_plan"],
        services: ["Amazon Elastic Compute Cloud"],
        accountIds: ["acc-prod"],
        regions: ["us-east-1"],
        commitmentIds: ["arn:aws:savingsplans::1:savingsplan/sp-1"],
      },
      metric: "utilization",
    });
  });

  it("prints the config it sent beside the result under --json", async () => {
    expect(await run("commitments", "report", "--from", "2026-10-01", "--json")).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.org).toBe("org-1");
    expect(printed.config.dateRange).toEqual({
      kind: "absolute",
      from: "2026-10-01",
      to: "2026-11-08",
    });
    expect(printed.series).toEqual(result.series);
  });

  it("writes the CSV", async () => {
    expect(await run("commitments", "report", "--format", "csv")).toBe(0);
    expect(out.stdout).toBe(csvOf(result));
  });

  it("refuses an hourly bin and an unknown grouping at parse time", async () => {
    expect(await run("commitments", "report", "--bin", "hour")).toBe(2);
    expect(await run("commitments", "report", "--group-by", "instance_family")).toBe(2);
    expect(out.requests).toEqual([]);
  });

  it("refuses a window the contract refuses, before sending it", async () => {
    expect(
      await run(
        "commitments",
        "report",
        "--bin",
        "day",
        "--from",
        "2025-01-01",
        "--to",
        "2026-06-30",
      ),
    ).toBe(2);
    expect(out.stderr).toContain("A daily report covers at most 367 days");
    expect(await run("commitments", "report", "--from", "2026-02-30")).toBe(2);
    expect(out.stderr).toContain("calendar day");
    expect(out.requests).toEqual([]);
  });

  it("names the choices when a filter value matches nothing", async () => {
    expect(await run("commitments", "report", "--region", "mars-1")).toBe(1);
    expect(out.stderr).toContain('--region "mars-1" is not a region with commitment data');
    expect(out.stderr).toContain("us-east-1, eu-west-1");
    expect(out.requests).toEqual(["GET /commitments/report-options"]);
  });

  it("reports the server's refusal as a failed request", async () => {
    serveRoutes(out, {
      "POST /commitments/report-query": new RawResponse(400, '{"error":"Invalid"}'),
    });
    expect(await run("commitments", "report")).toBe(1);
    expect(out.stderr).toContain("Cloud request failed: 400 /commitments/report-query");
  });
});
