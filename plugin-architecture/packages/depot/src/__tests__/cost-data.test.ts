import { afterEach, describe, expect, it, vi } from "vitest";
import { CostSetupError, ListTruncatedError, type CostRow } from "@infrawrench/plugin-base";
import {
  SERVICE,
  billableFraction,
  fetchDepotCostData,
  normalizeUsage,
  priceDay,
} from "../cost-data.js";
import { resolveRates } from "../rates.js";
import type { WireUsage } from "../api.js";

const NOW = new Date("2026-10-04T12:00:00Z");

function response(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

interface Call {
  url: string;
  body: Record<string, string>;
  headers: Record<string, string>;
}

function installUsage(byDay: (date: string) => WireUsage, status = 200) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    calls.push({
      url: String(url),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (status !== 200) return response({ code: "unauthenticated", message: "bad token" }, status);
    return response(byDay(body["startAt"]!.slice(0, 10)));
  }) as unknown as typeof fetch);
  return calls;
}

afterEach(() => vi.restoreAllMocks());

const ctx = (plan: string, overrides = "") => ({
  transport: { token: "org-token" },
  rates: resolveRates(plan, overrides).rates,
  projectIdsByName: async () => new Map([["web", "proj-web"]]),
  now: () => NOW,
});

describe("what a failed read leaves behind", () => {
  const RANGE = { fromDate: "2026-10-03", toDate: "2026-10-03" };
  const usage = () => ({ containerBuild: [{ projectName: "web", minutesBilled: 10 }] });
  const failing = (err: Error) => ({
    ...ctx("business"),
    projectIdsByName: async (): Promise<Map<string, string>> => {
      throw err;
    },
  });

  it("does not store rows with no project id over attributed ones when projects fail", async () => {
    installUsage(usage);
    await expect(
      fetchDepotCostData(
        failing(new Error("Depot API error 503 for ListProjects: unavailable")),
        RANGE,
      ),
    ).rejects.toThrow("503");
  });

  it("does not read a project list cut short as no projects", async () => {
    installUsage(usage);
    const truncated = new ListTruncatedError({ vendor: "Depot", path: "x", items: 1, maxPages: 1 });
    await expect(fetchDepotCostData(failing(truncated), RANGE)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("still prices usage for a token refused the project list", async () => {
    installUsage(usage);
    const rows = await fetchDepotCostData(
      failing(new Error("Depot API error 403 for ListProjects: permission_denied")),
      RANGE,
    );
    const build = rows.find((r) => r.service === SERVICE.builds);
    expect(build).toMatchObject({ tags: { project: "web" } });
    expect(build).not.toHaveProperty("resourceId");
  });

  it("fails on a usage answer that is not a usage message", async () => {
    for (const answer of [[], { githubActionsJobs: "oops" }]) {
      vi.restoreAllMocks();
      installUsage(() => answer as unknown as WireUsage);
      await expect(fetchDepotCostData(ctx("business"), RANGE)).rejects.toThrow("is not a list");
    }
  });

  it("fails on a usage answer with no body from the host", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
    await expect(
      fetchDepotCostData(
        { ...ctx("business"), transport: { token: "t", http: { request } } },
        RANGE,
      ),
    ).rejects.toThrow("is not a list");
  });

  it("reads an idle day, which proto3 JSON answers as an empty object", async () => {
    installUsage(() => ({}));
    await expect(fetchDepotCostData(ctx("business"), RANGE)).resolves.toEqual([]);
  });
});

describe("billableFraction", () => {
  it("prices only what crosses the allowance", () => {
    expect(billableFraction(0, 100, 500)).toBe(0);
    expect(billableFraction(450, 100, 500)).toBe(0.5);
    expect(billableFraction(600, 100, 500)).toBe(1);
    expect(billableFraction(0, 100, 0)).toBe(1);
    expect(billableFraction(0, 0, 0)).toBe(0);
  });
});

describe("normalizeUsage", () => {
  it("flags macOS runners and falls back to repo totals without job detail", () => {
    const day = normalizeUsage({
      githubActionsJobs: [
        {
          repo: "acme/api",
          jobs: [
            { workflow: "ci", runner: "depot-ubuntu-24.04", minutesBilled: 10, minutesElapsed: 10 },
            { workflow: "ios", runner: "depot-macos-15", minutesBilled: 5, minutesElapsed: 5 },
          ],
        },
        { repo: "acme/web", total: { jobCount: 2, minutesBilled: 4, minutesElapsed: 4 } },
      ],
    });
    expect(day.actions.map((a) => [a.repo, a.runner, a.macos])).toEqual([
      ["acme/api", "depot-ubuntu-24.04", false],
      ["acme/api", "depot-macos-15", true],
      ["acme/web", "", false],
    ]);
  });
});

describe("priceDay", () => {
  it("prices each product at list rates with no allowance", () => {
    const { rates } = resolveRates("usage-only", "");
    const rows = priceDay(
      "2026-10-01",
      normalizeUsage({
        containerBuild: [{ projectName: "web", buildCount: 3, minutesBilled: 10, minutesSaved: 4 }],
        githubActionsJobs: [
          {
            repo: "acme/api",
            jobs: [
              {
                workflow: "ci",
                runner: "depot-ubuntu-24.04-4",
                minutesBilled: 100,
                minutesElapsed: 50,
              },
              { workflow: "ios", runner: "depot-macos-15", minutesBilled: 10, minutesElapsed: 10 },
            ],
          },
        ],
        storage: [{ storageType: "cache", totalGb: 31 }],
        agentSandbox: [{ agentType: "claude", sandboxesCount: 1, minutesBilled: 20 }],
      }),
      rates,
      0,
      0,
      31,
      new Map([["web", "proj-web"]]),
    );
    const by = (service: string) => rows.find((r) => r.service === service)!;
    expect(by(SERVICE.builds)).toMatchObject({
      resourceId: "proj-web",
      tags: { project: "web" },
      amount: 0.4,
      usageAmount: 10,
    });
    expect(by(SERVICE.actions)).toMatchObject({
      tags: { repo: "acme/api", workflow: "ci", runner: "depot-ubuntu-24.04-4" },
      amount: 0.6,
    });
    expect(by(SERVICE.macos).amount).toBe(0.8);
    expect(by(SERVICE.cache).amount).toBe(0.2);
    expect(by(SERVICE.sandboxes).amount).toBe(0.2);
  });

  it("shares the billable part of a day pro rata across its rows", () => {
    const { rates } = resolveRates("developer", "");
    const rows = priceDay(
      "2026-10-01",
      normalizeUsage({
        containerBuild: [
          { projectName: "web", minutesBilled: 30 },
          { projectName: "api", minutesBilled: 70 },
        ],
      }),
      rates,
      450, // 50 minutes of allowance left: half of today's 100 bills
      0,
      31,
      new Map(),
    );
    expect(rows.map((r) => r.amount)).toEqual([0.6, 1.4]);
    expect(rows.every((r) => r.resourceId === undefined)).toBe(true);
  });
});

describe("fetchDepotCostData", () => {
  it("reads from the start of the cycle so the allowance is applied, and only returns the range", async () => {
    // 200 build minutes every day: the Developer plan's 500 run out on Oct 3.
    const calls = installUsage(() => ({
      containerBuild: [{ projectName: "web", minutesBilled: 200 }],
    }));
    const rows = await fetchDepotCostData(ctx("developer"), {
      fromDate: "2026-10-03",
      toDate: "2026-10-04",
    });
    expect(calls.map((c) => c.body["startAt"]!.slice(0, 10))).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(calls[0]!.url).toBe("https://api.depot.dev/depot.core.v1.UsageService/GetUsage");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer org-token");
    expect(calls[0]!.body["endAt"]).toBe("2026-10-01T23:59:59.999Z");

    const builds = (date: string) =>
      rows.find((r: CostRow) => r.date === date && r.service === SERVICE.builds)!;
    // Oct 3: 400 used before, 100 of 200 billable. Oct 4: all 200 billable.
    expect(builds("2026-10-03").amount).toBe(4);
    expect(builds("2026-10-04").amount).toBe(8);
    expect(rows.some((r) => r.date < "2026-10-03")).toBe(false);
    const plan = rows.filter((r) => r.service === SERVICE.plan);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.amount).toBeCloseTo(20 / 31, 5);
  });

  it("never asks about days after today", async () => {
    const calls = installUsage(() => ({}));
    await fetchDepotCostData(ctx("usage-only"), { fromDate: "2026-10-04", toDate: "2026-10-09" });
    expect(calls).toHaveLength(4);
  });

  it("charges no plan fee in a cycle with no usage", async () => {
    installUsage(() => ({}));
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
    });
    expect(rows).toEqual([]);
  });

  it("turns a rejected token into a setup error", async () => {
    installUsage(() => ({}), 401);
    await expect(
      fetchDepotCostData(ctx("startup"), { fromDate: "2026-10-04", toDate: "2026-10-04" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});
