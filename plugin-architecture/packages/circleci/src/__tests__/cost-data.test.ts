import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import {
  aggregateCredits,
  exportWindow,
  fetchCircleCostData,
  priceCells,
  runUsageExport,
} from "../cost-data.js";
import { parseCsv } from "../csv.js";
import { parseRates } from "../rates.js";
import { ctxWith, gzip, makeHttp, noSleep } from "./helpers.js";

const HEADER =
  '"ORGANIZATION_ID","PROJECT_NAME","WORKFLOW_NAME","JOB_NAME","JOB_RUN_DATE","RESOURCE_CLASS","EXECUTOR","COMPUTE_CREDITS","DLC_CREDITS","USER_CREDITS","STORAGE_CREDITS","NETWORK_CREDITS","LEASE_CREDITS","LEASE_OVERAGE_CREDITS","IPRANGES_CREDITS","TOTAL_CREDITS"';

function csv(rows: string[][]): string {
  return [HEADER, ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\r\n");
}

const ROWS = csv([
  [
    "org",
    "api",
    "build",
    "test",
    "2026-10-01",
    "medium",
    "docker",
    "100",
    "200",
    "0",
    "",
    "",
    "",
    "",
    "",
    "300",
  ],
  [
    "org",
    "api",
    "build",
    "test",
    "2026-10-01",
    "medium",
    "docker",
    "50",
    "0",
    "0",
    "",
    "",
    "",
    "",
    "",
    "50",
  ],
  [
    "org",
    "web",
    "build",
    "lint",
    "2026-10-02",
    "large",
    "machine",
    "40",
    "0",
    "0",
    "5",
    "",
    "",
    "",
    "",
    "50",
  ],
  // A credit kind this collector does not know yet still counts.
  [
    "org",
    "web",
    "build",
    "lint",
    "2026-10-02",
    "large",
    "machine",
    "10",
    "0",
    "0",
    "",
    "",
    "",
    "",
    "",
    "15",
  ],
]);

describe("parseCsv", () => {
  it("handles quotes, embedded commas, doubled quotes and CRLF", () => {
    expect(parseCsv('"A","b c"\r\n"x, y","say ""hi"""\r\n')).toEqual([
      { A: "x, y", "B C": 'say "hi"' },
    ]);
  });

  it("upper-cases headers and strips a BOM", () => {
    expect(parseCsv("﻿project_name,total_credits\napi,5\n")).toEqual([
      { PROJECT_NAME: "api", TOTAL_CREDITS: "5" },
    ]);
  });
});

describe("aggregateCredits", () => {
  it("sums per day, kind, project, resource class and executor", () => {
    const cells = aggregateCredits(parseCsv(ROWS));
    const find = (date: string, service: string, project: string) =>
      cells.find((c) => c.date === date && c.service === service && c.project === project);
    expect(find("2026-10-01", "Compute", "api")?.credits).toBe(150);
    expect(find("2026-10-01", "Docker Layer Caching", "api")?.credits).toBe(200);
    expect(find("2026-10-02", "Storage", "web")?.credits).toBe(5);
    expect(find("2026-10-02", "Other", "web")?.credits).toBe(10);
    expect(find("2026-10-02", "Compute", "web")).toMatchObject({
      resourceClass: "large",
      executor: "machine",
      credits: 50,
    });
  });
});

describe("priceCells", () => {
  it("prices every credit when nothing is included", () => {
    const rows = priceCells(
      aggregateCredits(parseCsv(ROWS)),
      parseRates({}),
      "2026-10-01",
      "2026-10-31",
    );
    const compute = rows.find((r) => r.date === "2026-10-01" && r.service === "Compute");
    expect(compute).toMatchObject({
      currency: "USD",
      amount: 0.09,
      usageAmount: 150,
      usageUnit: "Credits",
      tags: { project: "api", resource_class: "medium", executor: "docker" },
    });
    const total = rows.reduce((s, r) => s + r.amount, 0);
    expect(total).toBeCloseTo(415 * 0.0006, 6);
  });

  it("is free until the month passes the included credits", () => {
    const rates = parseRates({ pricePerCredit: "0.001", includedCreditsPerMonth: "400" });
    const rows = priceCells(aggregateCredits(parseCsv(ROWS)), rates, "2026-10-01", "2026-10-31");
    const day1 = rows.filter((r) => r.date === "2026-10-01").reduce((s, r) => s + r.amount, 0);
    const day2 = rows.filter((r) => r.date === "2026-10-02").reduce((s, r) => s + r.amount, 0);
    // 350 credits on day 1 (all inside the allowance), 65 on day 2 (15 billable).
    expect(day1).toBe(0);
    expect(day2).toBeCloseTo(0.015, 6);
    // Usage is still reported in full.
    expect(rows.reduce((s, r) => s + (r.usageAmount ?? 0), 0)).toBe(415);
  });

  it("drops days outside the range", () => {
    const rows = priceCells(
      aggregateCredits(parseCsv(ROWS)),
      parseRates({}),
      "2026-10-02",
      "2026-10-02",
    );
    expect(new Set(rows.map((r) => r.date))).toEqual(new Set(["2026-10-02"]));
  });
});

describe("exportWindow", () => {
  const now = Date.parse("2026-10-04T12:34:56Z");

  it("covers the chunk's whole days and stops at now", () => {
    const w = exportWindow({ fromDate: "2026-10-01", toDate: "2026-10-04" }, parseRates({}), now)!;
    expect(w.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-04T12:34:00.000Z");
  });

  it("starts on the 1st when credits are included", () => {
    const w = exportWindow(
      { fromDate: "2026-09-20", toDate: "2026-09-30" },
      parseRates({ includedCreditsPerMonth: "30000" }),
      now,
    )!;
    expect(w.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("never reaches further back than the API allows", () => {
    const w = exportWindow({ fromDate: "2025-01-01", toDate: "2025-01-31" }, parseRates({}), now);
    expect(w).toBeUndefined();
  });
});

describe("runUsageExport", () => {
  it("starts a job, polls until complete and merges gzipped files", async () => {
    const part1 = await gzip(
      csv([
        ROWS.split("\r\n")[1]!
          .split(",")
          .map((c) => c.replace(/"/g, "")),
      ]),
    );
    const part2 = new TextEncoder().encode(
      csv([
        [
          "org",
          "web",
          "b",
          "j",
          "2026-10-02",
          "small",
          "docker",
          "5",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "5",
        ],
      ]),
    );
    let polls = 0;
    const { http, calls } = makeHttp((call) => {
      if (call.url.hostname === "exports.example.com") {
        return { raw: call.url.pathname === "/1.csv.gz" ? part1 : part2 };
      }
      expect(call.headers["Circle-Token"]).toBe("TEST_TOKEN");
      if (call.method === "POST") {
        expect(call.url.pathname).toBe("/api/v2/organizations/org-1/usage_export_job");
        expect(call.body).toEqual({
          start: "2026-10-01T00:00:00.000Z",
          end: "2026-10-03T00:00:00.000Z",
        });
        return {
          status: 201,
          body: { usage_export_job_id: "job-1", state: "created", download_urls: [] },
        };
      }
      expect(call.url.pathname).toBe("/api/v2/organizations/org-1/usage_export_job/job-1");
      polls++;
      if (polls === 1) return { status: 429, body: { message: "Rate limit exceeded." } };
      if (polls === 2)
        return { usage_export_job_id: "job-1", state: "processing", download_urls: [] };
      return {
        usage_export_job_id: "job-1",
        state: "completed",
        download_urls: [
          "https://exports.example.com/1.csv.gz",
          "https://exports.example.com/2.csv",
        ],
      };
    });
    const rows = await runUsageExport(
      ctxWith(http),
      "org-1",
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-03T00:00:00Z"),
      { sleep: noSleep },
    );
    expect(rows.map((r) => r["PROJECT_NAME"])).toEqual(["api", "web"]);
    // Presigned downloads carry no token.
    const download = calls.find((c) => c.url.hostname === "exports.example.com");
    expect(download?.headers["Circle-Token"]).toBeUndefined();
  });

  it("reports a failed export with its reason", async () => {
    const { http } = makeHttp((call) =>
      call.method === "POST"
        ? { usage_export_job_id: "j", state: "created", download_urls: [] }
        : { usage_export_job_id: "j", state: "failed", download_urls: [], error_reason: "too big" },
    );
    await expect(
      runUsageExport(ctxWith(http), "o", new Date(0), new Date(86_400_000), { sleep: noSleep }),
    ).rejects.toThrow(/failed: too big/);
  });

  it("gives up after the wait budget", async () => {
    const { http } = makeHttp(() => ({
      usage_export_job_id: "j",
      state: "processing",
      download_urls: [],
    }));
    await expect(
      runUsageExport(ctxWith(http), "o", new Date(0), new Date(86_400_000), {
        sleep: noSleep,
        pollDelaysMs: [1000],
        maxWaitMs: 3000,
      }),
    ).rejects.toThrow(/did not finish in time/);
  });

  it("explains a rate-limited start", async () => {
    const { http } = makeHttp(() => ({ status: 429, body: { message: "Rate limit exceeded." } }));
    await expect(
      runUsageExport(ctxWith(http), "o", new Date(0), new Date(86_400_000), { sleep: noSleep }),
    ).rejects.toThrow(/10 exports an hour/);
  });
});

describe("fetchCircleCostData", () => {
  it("turns a refused export into a setup error", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { message: "Forbidden" } }));
    await expect(
      fetchCircleCostData(
        ctxWith(http),
        "o",
        parseRates({}),
        { fromDate: "2026-10-01", toDate: "2026-10-03" },
        { sleep: noSleep, nowMs: Date.parse("2026-10-04T00:00:00Z") },
      ),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});
