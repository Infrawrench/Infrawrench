import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError, ListTruncatedError, type CostRow } from "@infrawrench/plugin-base";
import {
  SERVICE,
  billableFraction,
  fetchDepotCostData,
  normalizeUsage,
  priceDay,
  usedInCycle,
} from "../cost-data.js";
import { invoiceLineService, minorUnitsPerMajor, periodDays } from "../invoices.js";
import { resolveRates } from "../rates.js";
import type { WireUsage } from "../api.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const NONE_USED = { builds: 0, actions: 0, compute: 0 };

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

const API = "https://api.depot.dev/";
const USAGE = `${API}depot.core.v1.UsageService/GetUsage`;
const INVOICES = `${API}depot.core.v1.BillingService/ListInvoices`;
const LINES = `${API}depot.core.v1.BillingService/ListInvoiceLineItems`;

/** What a billing route answers: a body, or `failed(status, body)`. */
type BillingAnswer = unknown;
const failed = (status: number, body: unknown) => ({ status, body, failed: true as const });
const isFailure = (a: unknown): a is ReturnType<typeof failed> =>
  typeof a === "object" && a !== null && "failed" in a;

/** A route that has not been deployed: a Connect router's plain 404. */
const NOT_DEPLOYED = () => failed(404, "404 page not found");

interface Billing {
  invoices: (body: Record<string, string>) => BillingAnswer;
  lines?: (body: Record<string, string>) => BillingAnswer;
}

/** No request leaves a test: anything not stubbed by the test itself throws. */
function refuseNetwork() {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    throw new Error(`unexpected request to ${String(url)}`);
  }) as unknown as typeof fetch);
}

/**
 * Stub the Depot API: GetUsage by day, and BillingService as `billing` says (not
 * deployed unless a test says otherwise). Returns the GetUsage calls, with the billing
 * calls on `.billing`. Any other URL throws.
 */
function installUsage(
  byDay: (date: string) => WireUsage,
  status = 200,
  billing: Billing = { invoices: NOT_DEPLOYED, lines: NOT_DEPLOYED },
) {
  const calls: Call[] = [];
  const billingCalls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    const call = {
      url: String(url),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    if (url === INVOICES || url === LINES) {
      billingCalls.push(call);
      const route = url === INVOICES ? billing.invoices : billing.lines;
      if (!route) throw new Error(`unexpected request to ${String(url)}`);
      const answer = route(body);
      if (!isFailure(answer)) return response(answer);
      return typeof answer.body === "string"
        ? ({
            status: answer.status,
            ok: false,
            text: async () => answer.body,
          } as unknown as Response)
        : response(answer.body, answer.status);
    }
    if (url !== USAGE) throw new Error(`unexpected request to ${String(url)}`);
    calls.push(call);
    if (status !== 200) return response({ code: "unauthenticated", message: "bad token" }, status);
    return response(byDay(body["startAt"]!.slice(0, 10)));
  }) as unknown as typeof fetch);
  return Object.assign(calls, { billing: billingCalls });
}

beforeEach(() => refuseNetwork());
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
      NONE_USED,
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
    // 20 billed minutes at 2 vCPUs: $0.00005 per vCPU-second.
    expect(by(SERVICE.sandboxes).amount).toBe(0.12);
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
      // 50 minutes of allowance left: half of today's 100 bills
      { ...NONE_USED, builds: 450 },
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

describe("Depot CI", () => {
  const CI: WireUsage = {
    depotCi: [
      {
        repo: "acme/api",
        workflow: "CI",
        workflowPath: ".depot/workflows/ci.yml",
        runner: "depot-ubuntu-24.04-4",
        attemptCount: 3,
        minutesElapsed: 25,
        vcpuMinutesBilled: 100,
      },
    ],
  };

  it("prices billed vCPU-minutes at the sandbox compute rate", () => {
    const { rates } = resolveRates("usage-only", "");
    const rows = priceDay("2026-10-01", normalizeUsage(CI), rates, NONE_USED, 31, new Map());
    expect(rows).toEqual([
      {
        date: "2026-10-01",
        service: SERVICE.ci,
        tags: { repo: "acme/api", workflow: "CI", runner: "depot-ubuntu-24.04-4" },
        currency: "USD",
        // $0.00005 per vCPU-second
        amount: 0.3,
        usageAmount: 100,
        usageUnit: "vCPU-minutes",
      },
    ]);
  });

  it("draws on the plan's included minutes, measured at 2 vCPUs", async () => {
    // 2,100 vCPU-minutes a day is 1,050 of the Developer plan's 2,000 included minutes.
    installUsage(() => ({
      depotCi: [{ repo: "acme/api", runner: "depot-ubuntu-24.04", vcpuMinutesBilled: 2100 }],
    }));
    const rows = await fetchDepotCostData(ctx("developer"), {
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
    });
    const ci = (date: string) => rows.find((r) => r.date === date && r.service === SERVICE.ci)!;
    expect(ci("2026-10-01").amount).toBe(0);
    // 1,050 before, 950 left: 100 of today's 1,050 minutes bill, 200 vCPU-minutes.
    expect(ci("2026-10-02").amount).toBe(0.6);
    expect(rows.some((r) => r.service === SERVICE.plan)).toBe(true);
  });

  it("draws agent sandboxes on the included sandbox minutes, not at a flat rate (#897)", () => {
    const { rates } = resolveRates("developer", "");
    const day = normalizeUsage({
      agentSandbox: [{ agentType: "claude", sandboxesCount: 2, minutesBilled: 300 }],
    });
    // Inside the Developer plan's 2,000 minutes: usage shows, nothing is charged.
    const inside = priceDay("2026-10-01", day, rates, NONE_USED, 31, new Map());
    expect(inside).toEqual([
      {
        date: "2026-10-01",
        service: SERVICE.sandboxes,
        tags: { agentType: "claude" },
        currency: "USD",
        amount: 0,
        usageAmount: 300,
        usageUnit: "billed minutes",
      },
    ]);
    // 1,900 of the pool used already: 200 of these 300 minutes bill, at 2 vCPUs each.
    const past = priceDay("2026-10-02", day, rates, { ...NONE_USED, compute: 1900 }, 31, new Map());
    expect(past[0]!.amount).toBe(1.2);
  });

  it("shares one pool, and one billable share, between Depot CI and agent sandboxes", () => {
    const { rates } = resolveRates("developer", "");
    const day = normalizeUsage({
      // 200 vCPU-minutes of CI is 100 pool minutes, beside 100 sandbox minutes.
      depotCi: [{ repo: "acme/api", runner: "depot-ubuntu-24.04-4", vcpuMinutesBilled: 200 }],
      agentSandbox: [{ agentType: "claude", minutesBilled: 100 }],
    });
    expect(usedInCycle(day).compute).toBe(200);
    // 1,900 used: half of today's 200 pool minutes bill, for each product.
    const rows = priceDay("2026-10-02", day, rates, { ...NONE_USED, compute: 1900 }, 31, new Map());
    const by = (service: string) => rows.find((r) => r.service === service)!;
    expect(by(SERVICE.ci).amount).toBe(0.3);
    expect(by(SERVICE.sandboxes).amount).toBe(0.3);
  });

  it("reads an answer without the Depot CI list as none", () => {
    expect(normalizeUsage({}).ci).toEqual([]);
  });
});

describe("finalized invoices", () => {
  const SEP_1 = "2026-09-01T00:00:00Z";
  const OCT_1 = "2026-10-01T00:00:00Z";
  const NOV_1 = "2026-11-01T00:00:00Z";
  const sum = (rows: CostRow[]) => rows.reduce((s, r) => s + r.amount, 0);
  const oneBuildADay = () => ({ containerBuild: [{ projectName: "web", minutesBilled: 10 }] });

  // Renewal on Sep 1: August's usage in arrears, September's fee in advance.
  const INV_1 = {
    id: "in_1",
    number: "INV-1",
    status: "paid",
    currency: "usd",
    subscriptionId: "sub_1",
    createdAt: "2026-09-01T01:00:00Z",
    periodStart: "2026-08-01T00:00:00Z",
    periodEnd: SEP_1,
    total: "21000",
  };
  const INV_1_LINES = [
    {
      id: "il_aug",
      description: "250 × Docker build minutes (at $0.04 / month)",
      currency: "usd",
      amount: "1000",
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: SEP_1,
    },
    {
      id: "il_fee_sep",
      description: "1 × Depot Startup (at $200.00 / month)",
      currency: "usd",
      amount: "20000",
      quantity: "1",
      periodStart: SEP_1,
      periodEnd: OCT_1,
    },
  ];
  // Renewal on Oct 1: September's usage, a downgrade credit, October's fee.
  const INV_2 = {
    id: "in_2",
    number: "INV-2",
    status: "paid",
    currency: "usd",
    subscriptionId: "sub_1",
    createdAt: "2026-10-01T01:00:00Z",
    periodStart: SEP_1,
    periodEnd: OCT_1,
    total: "38436",
    discountAmount: "500",
    taxAmount: "2000",
  };
  const INV_2_LINES = [
    {
      id: "il_builds",
      description: "1,234 × Docker build minutes (Tier 2 at $0.04 / month)",
      currency: "usd",
      amount: "4936",
      quantity: "1234",
      unitAmountDecimal: "4",
      periodStart: SEP_1,
      periodEnd: OCT_1,
      discountAmount: "500",
    },
    {
      id: "il_sandbox",
      description: "Sandbox compute",
      currency: "usd",
      amount: "3000",
      periodStart: SEP_1,
      periodEnd: OCT_1,
    },
    {
      id: "il_proration",
      description: "Unused time on Depot Developer after 15 Sep 2026",
      currency: "usd",
      amount: "-1000",
      proration: true,
      periodStart: "2026-09-15T00:00:00Z",
      periodEnd: OCT_1,
    },
    {
      id: "il_actions",
      description: "GitHub Actions runner minutes",
      currency: "usd",
      amount: "10000",
      amountExcludingTax: "10000",
      taxAmount: "2000",
      periodStart: SEP_1,
      periodEnd: OCT_1,
    },
    {
      id: "il_fee_oct",
      description: "1 × Depot Startup (at $200.00 / month)",
      currency: "usd",
      amount: "20000",
      quantity: "1",
      periodStart: OCT_1,
      periodEnd: NOV_1,
    },
  ];
  const BILLING: Billing = {
    invoices: () => ({ invoices: [INV_2, INV_1] }),
    lines: (body) => ({ lineItems: body["invoiceId"] === "in_2" ? INV_2_LINES : INV_1_LINES }),
  };

  it("takes an invoiced cycle from the invoice's lines, not the estimate", async () => {
    const calls = installUsage(oneBuildADay, 200, BILLING);
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-09-01",
      toDate: "2026-10-04",
    });

    // September is settled by INV-2, so only October's usage is read.
    expect(calls.map((c) => c.body["startAt"]!.slice(0, 10))).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    const sep = rows.filter((r) => r.date < "2026-10-01");
    expect(sep.every((r) => r.tags?.["invoice"] !== undefined)).toBe(true);
    // INV-2's September lines, net of discount and with tax, plus INV-1's advance fee.
    expect(sum(sep)).toBeCloseTo(184.36 + 200, 4);
    expect(sum(sep.filter((r) => r.tags?.["invoice"] === "INV-1"))).toBeCloseTo(200, 4);

    const sep10 = (service: string, chargeType?: string) =>
      rows.find(
        (r) =>
          r.date === "2026-09-10" &&
          r.tags?.["invoice"] === "INV-2" &&
          r.service === service &&
          r.chargeType === chargeType,
      );
    expect(sep10(SERVICE.builds)!.amount).toBeCloseTo(49.36 / 30, 5);
    expect(sep10(SERVICE.builds, "credit")!.amount).toBeCloseTo(-5 / 30, 5);
    expect(sep10("Sandbox compute")!.amount).toBe(1);
    expect(sep10(SERVICE.actions)!.amount).toBeCloseTo(100 / 30, 5);
    expect(sep10(SERVICE.actions, "tax")!.amount).toBeCloseTo(20 / 30, 5);
    const proration = rows.filter((r) => r.chargeType === "adjustment");
    expect(proration[0]!.date).toBe("2026-09-15");
    expect(proration).toHaveLength(16);
    expect(sum(proration)).toBeCloseTo(-10, 4);
    expect(proration.every((r) => r.service === SERVICE.plan)).toBe(true);
    // August's usage on INV-1 is outside the window.
    expect(rows.some((r) => r.date < "2026-09-01")).toBe(false);

    // October: usage estimated, the fee from INV-2's advance line rather than estimated too.
    const oct = rows.filter((r) => r.date >= "2026-10-01");
    expect(oct.filter((r) => r.service === SERVICE.builds && !r.tags?.["invoice"])).toHaveLength(4);
    const fee = oct.filter((r) => r.service === SERVICE.plan);
    expect(fee).toHaveLength(4);
    expect(fee.every((r) => r.tags?.["invoice"] === "INV-2")).toBe(true);
    expect(fee[0]!.amount).toBeCloseTo(200 / 31, 5);
  });

  it("still estimates the open cycle, plan fee included, when no invoice bills it", async () => {
    const calls = installUsage(oneBuildADay, 200, {
      invoices: () => ({ invoices: [{ ...INV_2, total: "18436" }] }),
      lines: () => ({ lineItems: INV_2_LINES.filter((l) => l.id !== "il_fee_oct") }),
    });
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-10-01",
      toDate: "2026-10-04",
    });
    expect(calls).toHaveLength(4);
    expect(calls.billing[0]!.body).toEqual({ pageSize: 100 });
    expect(calls.billing[1]!.body).toEqual({ invoiceId: "in_2", pageSize: 100 });
    expect(rows.some((r) => r.tags?.["invoice"])).toBe(false);
    const fee = rows.filter((r) => r.service === SERVICE.plan);
    expect(fee).toHaveLength(4);
    expect(fee[0]!.amount).toBeCloseTo(200 / 31, 5);
  });

  it("sums each invoice to its total, invoice-level discounts and credits included", async () => {
    installUsage(oneBuildADay, 200, {
      invoices: () => ({
        // A $10 coupon on the whole invoice that no line carries.
        invoices: [{ ...INV_2, total: "8500", discountAmount: "1000", taxAmount: "0" }],
      }),
      lines: () => ({
        lineItems: [
          { ...INV_2_LINES[0], discountAmount: undefined, amount: "10000" },
          {
            id: "il_credit",
            description: "Promotional credit",
            amount: "-500",
            periodStart: SEP_1,
            periodEnd: OCT_1,
          },
        ],
      }),
    });
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    });
    expect(sum(rows)).toBeCloseTo(85, 4);
    const adjustment = rows.filter((r) => r.service === SERVICE.invoiceAdjustment);
    expect(adjustment).toHaveLength(30);
    expect(sum(adjustment)).toBeCloseTo(-10, 4);
    expect(adjustment.every((r) => r.chargeType === "adjustment")).toBe(true);
    const credit = rows.filter((r) => r.service === "Promotional credit");
    expect(credit.every((r) => r.chargeType === "credit")).toBe(true);
    expect(sum(credit)).toBeCloseTo(-5, 4);
  });

  it("puts a line with no period on the day the invoice was created", async () => {
    installUsage(oneBuildADay, 200, {
      invoices: () => ({ invoices: [{ ...INV_2, total: "-500" }] }),
      lines: () => ({
        lineItems: [{ id: "il_refund", description: "Refund for outage", amount: "-500" }],
      }),
    });
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
    });
    expect(rows.filter((r) => r.service === "Refund for outage")).toEqual([
      {
        date: "2026-10-01",
        service: "Refund for outage",
        tags: { invoice: "INV-2" },
        currency: "USD",
        chargeType: "refund",
        amount: -5,
      },
    ]);
    // A credit is not a fee for the open cycle: the plan fee is still estimated.
    expect(rows.filter((r) => r.service === SERVICE.plan)).toHaveLength(2);
  });

  it("follows the pages of both lists, past an empty page, and stops at old invoices", async () => {
    const OLD = { ...INV_1, id: "in_old", createdAt: "2025-06-01T00:00:00Z" };
    const pages: Record<string, unknown> = {
      "": { invoices: [], nextPageToken: "p2" },
      p2: { invoices: [INV_2], nextPageToken: "p3" },
      p3: { invoices: [OLD], nextPageToken: "p4" },
    };
    const calls = installUsage(oneBuildADay, 200, {
      invoices: (body) => {
        const page = pages[body["pageToken"] ?? ""];
        if (!page) throw new Error(`read past the bound: ${body["pageToken"]}`);
        return page;
      },
      lines: (body) => {
        if (body["invoiceId"] !== "in_2") throw new Error(`lines of ${body["invoiceId"]}`);
        return body["pageToken"] === "l2"
          ? { lineItems: INV_2_LINES.slice(3) }
          : { lineItems: INV_2_LINES.slice(0, 3), nextPageToken: "l2" };
      },
    });
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-09-01",
      toDate: "2026-10-04",
    });
    const invoiceCalls = calls.billing.filter((c) => c.url === INVOICES);
    expect(invoiceCalls.map((c) => c.body["pageToken"])).toEqual([undefined, "p2", "p3"]);
    expect(invoiceCalls.every((c) => Number(c.body["pageSize"]) === 100)).toBe(true);
    const lineCalls = calls.billing.filter((c) => c.url === LINES);
    expect(lineCalls.map((c) => c.body)).toEqual([
      { invoiceId: "in_2", pageSize: 100 },
      { invoiceId: "in_2", pageSize: 100, pageToken: "l2" },
    ]);
    // Every line from both pages: the September usage and the October fee.
    expect(sum(rows.filter((r) => r.date < "2026-10-01"))).toBeCloseTo(184.36, 4);
    const octFee = rows.filter((r) => r.date >= "2026-10-01" && r.service === SERVICE.plan);
    expect(octFee).toHaveLength(4);
    expect(octFee.every((r) => r.tags?.["invoice"] === "INV-2")).toBe(true);
  });

  it("throws on an invoice list cut short rather than reading it as complete", async () => {
    installUsage(oneBuildADay, 200, {
      invoices: () => ({ invoices: [], nextPageToken: "more" }),
      lines: () => ({ lineItems: [] }),
    });
    await expect(
      fetchDepotCostData(ctx("startup"), { fromDate: "2026-10-01", toDate: "2026-10-01" }),
    ).rejects.toThrow("has more than Infrawrench reads");
  });

  it("carries the invoice's currency in its own minor unit", async () => {
    installUsage(oneBuildADay, 200, {
      invoices: () => ({
        invoices: [
          { ...INV_2, id: "in_eur", number: "EUR-1", currency: "eur", total: "12345" },
          { ...INV_2, id: "in_jpy", number: "JPY-1", currency: "jpy", total: "5000" },
        ],
      }),
      lines: (body) => ({
        lineItems: [
          {
            id: `${body["invoiceId"]}_l`,
            description: "Docker build minutes",
            currency: body["invoiceId"] === "in_eur" ? "eur" : "jpy",
            amount: body["invoiceId"] === "in_eur" ? "12345" : "5000",
            periodStart: SEP_1,
            periodEnd: OCT_1,
          },
        ],
      }),
    });
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    });
    const eur = rows.filter((r) => r.tags?.["invoice"] === "EUR-1");
    const jpy = rows.filter((r) => r.tags?.["invoice"] === "JPY-1");
    expect(eur).toHaveLength(30);
    expect(eur.every((r) => r.currency === "EUR")).toBe(true);
    expect(sum(eur)).toBeCloseTo(123.45, 4);
    expect(jpy.every((r) => r.currency === "JPY")).toBe(true);
    expect(sum(jpy)).toBeCloseTo(5000, 3);
  });

  it("ignores a void invoice, leaving its cycle to the estimate", async () => {
    const calls = installUsage(oneBuildADay, 200, {
      invoices: () => ({ invoices: [{ ...INV_2, status: "void" }] }),
      lines: () => {
        throw new Error("read the lines of a void invoice");
      },
    });
    const rows = await fetchDepotCostData(ctx("startup"), {
      fromDate: "2026-09-29",
      toDate: "2026-09-30",
    });
    expect(calls).toHaveLength(30);
    expect(rows.some((r) => r.tags?.["invoice"])).toBe(false);
    expect(rows.filter((r) => r.service === SERVICE.plan)).toHaveLength(2);
  });

  describe("when the organization cannot read invoices", () => {
    const RANGE = { fromDate: "2026-09-29", toDate: "2026-10-02" };

    it.each([
      ["not deployed (404)", NOT_DEPLOYED],
      ["unimplemented", () => failed(501, { code: "unimplemented", message: "not implemented" })],
      ["permission denied", () => failed(403, { code: "permission_denied", message: "denied" })],
    ])("falls back to the estimate for every cycle: %s", async (_, answer) => {
      installUsage(oneBuildADay);
      const baseline = await fetchDepotCostData(ctx("startup"), RANGE);
      vi.restoreAllMocks();
      refuseNetwork();

      const calls = installUsage(oneBuildADay, 200, { invoices: answer });
      const rows = await fetchDepotCostData(ctx("startup"), RANGE);
      expect(rows).toEqual(baseline);
      expect(calls[0]!.body["startAt"]).toBe("2026-09-01T00:00:00.000Z");
      expect(rows.filter((r) => r.service === SERVICE.plan)).toHaveLength(4);
    });

    it("falls back when the lines are refused too", async () => {
      installUsage(oneBuildADay, 200, {
        invoices: () => ({ invoices: [INV_2] }),
        lines: () => failed(501, { code: "unimplemented", message: "not implemented" }),
      });
      const rows = await fetchDepotCostData(ctx("startup"), RANGE);
      expect(rows.some((r) => r.tags?.["invoice"])).toBe(false);
      expect(rows.filter((r) => r.service === SERVICE.plan)).toHaveLength(4);
    });

    it("fails on any other error, as a failed usage read does", async () => {
      installUsage(oneBuildADay, 200, {
        invoices: () => failed(503, { code: "unavailable", message: "try later" }),
      });
      const err = await fetchDepotCostData(ctx("startup"), RANGE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CostSetupError);
      expect((err as Error).message).toContain("503");

      vi.restoreAllMocks();
      refuseNetwork();
      installUsage(oneBuildADay, 200, {
        invoices: () => failed(401, { code: "unauthenticated", message: "bad token" }),
      });
      await expect(fetchDepotCostData(ctx("startup"), RANGE)).rejects.toBeInstanceOf(
        CostSetupError,
      );
    });
  });
});

describe("invoice lines", () => {
  it("names lines like the estimate's rows where it has one", () => {
    expect(invoiceLineService("1,234 × Docker build minutes (at $0.04 / month)")).toBe(
      SERVICE.builds,
    );
    expect(invoiceLineService("GitHub Actions minutes (Tier 1 at $0.00 / month)")).toBe(
      SERVICE.actions,
    );
    expect(invoiceLineService("macOS runner minutes")).toBe(SERVICE.macos);
    expect(invoiceLineService("Depot CI vCPU minutes")).toBe(SERVICE.ci);
    expect(invoiceLineService("Agent sandbox minutes")).toBe(SERVICE.sandboxes);
    expect(invoiceLineService("Registry storage")).toBe(SERVICE.registry);
    expect(invoiceLineService("Cache storage (GB)")).toBe(SERVICE.cache);
    expect(invoiceLineService("1 × Depot Business (at $1,000.00 / month)")).toBe(SERVICE.plan);
    // No estimate equivalent: the line keeps its own name.
    expect(invoiceLineService("12 × Sandbox compute (at $0.003 / month)")).toBe("Sandbox compute");
    expect(invoiceLineService("Priority support")).toBe("Priority support");
    expect(invoiceLineService(undefined)).toBe(SERVICE.other);
  });

  it("maps a period anchored mid-day onto the same whole days on both sides", () => {
    const days = periodDays("2026-09-15T13:42:00Z", "2026-10-15T13:42:00Z");
    expect(new Date(days[0]!).toISOString().slice(0, 10)).toBe("2026-09-16");
    expect(new Date(days.at(-1)!).toISOString().slice(0, 10)).toBe("2026-10-15");
    expect(days).toHaveLength(30);
    // Stripe's inclusive end, one second before midnight.
    expect(periodDays("2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z")).toHaveLength(30);
    expect(periodDays("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z")).toEqual([]);
  });

  it("knows Stripe's minor units", () => {
    expect(minorUnitsPerMajor("usd")).toBe(100);
    expect(minorUnitsPerMajor("JPY")).toBe(1);
    expect(minorUnitsPerMajor("kwd")).toBe(1000);
  });
});
