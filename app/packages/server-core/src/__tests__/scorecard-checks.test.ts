import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../alerts/route", () => ({ routeAlert: vi.fn() }));

import {
  defaultScorecardInput,
  type ResourceVulnerabilitySummary,
  type Scorecard,
  type Service,
  type ServiceMember,
} from "@infrawrench/client-core";
import { scorecardCheckEvaluator } from "../scorecards/checks";
import { scoreService } from "../scorecards/eval";
import type { ServiceSignals } from "../service-catalog/signals";

function service(over: Partial<Service> = {}): Service {
  return {
    id: "svc-1",
    name: "Checkout API",
    slug: "checkout-api",
    description: null,
    tier: 1,
    ownerTeam: null,
    ownerUserIds: [],
    owners: [],
    links: [],
    onCallScheduleId: null,
    onCallScheduleName: null,
    sloIds: [],
    runbookIds: [],
    rules: [],
    monthlyBudget: null,
    budgetCurrency: null,
    memberCount: 1,
    scores: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

const member: ServiceMember = {
  resourceId: "r-1",
  accountId: "a-1",
  accountName: "prod",
  pluginId: "aws",
  resourceTypeId: "rds-instance",
  resourceName: "checkout-db",
  externalId: "db-1",
  source: "manual",
  ruleIndex: null,
  owner: null,
  missing: false,
};

/** Every feed empty and healthy unless overridden. */
function signals(over: Partial<Record<keyof ServiceSignals, unknown>> = {}): ServiceSignals {
  const base = {
    organizationId: "org-1",
    now: Date.parse("2026-10-12T00:00:00Z"),
    posture: async () => ({ findings: [], totalCount: 0, counts: {}, dismissed: [] }),
    orphans: async () => ({ accounts: [], totalCount: 0, unownedCount: 0, costWindowDays: 0 }),
    backups: async () => ({ findings: [], resources: [] }),
    drills: async () => ({ rows: [] }),
    slos: async () => [],
    runbooks: async () => [],
    tagPolicy: async () => ({ requiredTags: [], enforceOnCreate: false }),
    onCallSchedule: async () => null,
    onCallNow: async () => null,
    resourceSpend: async () => new Map(),
    // No scanner has reported and no deploys were recorded: both later feeds
    // leave their checks not applicable.
    extension: async (key: string) =>
      key === "vulnerabilities"
        ? { scanning: false, atOrAbove: () => new Map() }
        : key.startsWith("dora-service:")
          ? new Map()
          : null,
  };
  return { ...base, ...over } as unknown as ServiceSignals;
}

const ctx = (
  svc: Service,
  sig: ServiceSignals,
  fields = new Map<string, Record<string, unknown>>(),
) => ({
  service: svc,
  members: [member],
  memberFields: fields,
  signals: sig,
});

const run = (
  type: string,
  context: Parameters<NonNullable<ReturnType<typeof scorecardCheckEvaluator>>>[0],
  params: Record<string, number | string[]> = {},
) => scorecardCheckEvaluator(type)!(context, params);

describe("scorecard checks", () => {
  it("has_owner passes on a team or a member, fails on neither", async () => {
    expect((await run("has_owner", ctx(service(), signals()), {})).status).toBe("fail");
    expect(
      (await run("has_owner", ctx(service({ ownerTeam: "Payments" }), signals()), {})).status,
    ).toBe("pass");
  });

  it("has_on_call fails on a disabled schedule", async () => {
    const sig = signals({ onCallSchedule: async () => ({ name: "Payments", enabled: false }) });
    const out = await run("has_on_call", ctx(service({ onCallScheduleId: "s-1" }), sig), {});
    expect(out.status).toBe("fail");
    expect(out.detail).toMatch(/disabled/);
  });

  it("slo_within_budget fails on a spent budget and passes with budget left", async () => {
    const slo = (budgetRemaining: number | null) => ({
      id: "slo-1",
      name: "Checkout availability",
      enabled: true,
      budgetRemaining,
    });
    const svc = service({ sloIds: ["slo-1"] });
    expect(
      (await run("slo_within_budget", ctx(svc, signals({ slos: async () => [slo(0.4)] })), {}))
        .status,
    ).toBe("pass");
    expect(
      (await run("slo_within_budget", ctx(svc, signals({ slos: async () => [slo(-0.1)] })), {}))
        .status,
    ).toBe("fail");
    expect(
      (
        await run("slo_within_budget", ctx(svc, signals({ slos: async () => [slo(0.4)] })), {
          minBudgetRemainingPercent: 50,
        })
      ).status,
    ).toBe("fail");
  });

  it("backups_verified is not applicable without stateful members", async () => {
    const out = await run("backups_verified", ctx(service(), signals()), {});
    expect(out.status).toBe("not_applicable");
  });

  it("backups_verified wants a verified drill for every stateful member", async () => {
    const sig = signals({
      backups: async () => ({
        findings: [],
        resources: [{ resourceId: "r-1", state: "protected" }],
      }),
      drills: async () => ({ rows: [{ resourceId: "r-1", standing: "stale" }] }),
    });
    expect((await run("backups_verified", ctx(service(), sig), {})).status).toBe("fail");
  });

  it("reports a feed that could not be read as an error", async () => {
    const out = await run("no_orphans", ctx(service(), signals({ orphans: async () => null })), {});
    expect(out.status).toBe("error");
  });

  it("required_tags falls back to the org tag policy and skips untaggable members", async () => {
    const sig = signals({
      tagPolicy: async () => ({ requiredTags: [{ key: "team" }], enforceOnCreate: false }),
    });
    expect((await run("required_tags", ctx(service(), sig), {})).status).toBe("not_applicable");
    const tagged = new Map([["r-1", { tags: { Team: "payments" } }]]);
    expect((await run("required_tags", ctx(service(), sig, tagged), {})).status).toBe("pass");
    expect(
      (
        await run("required_tags", ctx(service(), sig, tagged), {
          tags: ["env"],
        })
      ).status,
    ).toBe("fail");
  });

  it("cost_within_budget sums only the budget's currency", async () => {
    const sig = signals({
      resourceSpend: async () =>
        new Map([
          [
            "a-1 db-1",
            [
              { amount: 80, currency: "USD" },
              { amount: 500, currency: "EUR" },
            ],
          ],
        ]),
    });
    const svc = service({ monthlyBudget: 100, budgetCurrency: "USD" });
    const out = await run("cost_within_budget", ctx(svc, sig), {});
    expect(out.status).toBe("pass");
    expect(out.detail).toMatch(/other currencies/);
  });
});

describe("vulnerability and delivery checks", () => {
  const vulnSummary = (
    over: Partial<ResourceVulnerabilitySummary>,
  ): ResourceVulnerabilitySummary => ({
    resourceId: "r-1",
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    advisories: [],
    kev: false,
    ...over,
  });

  /** A vulnerability feed stub: `rows` are the summaries at "low" and above. */
  const vulnFeed = (scanning: boolean, rows: ReturnType<typeof vulnSummary>[]) => {
    const asked: string[] = [];
    return {
      asked,
      sig: signals({
        extension: async (key: string) =>
          key === "vulnerabilities"
            ? {
                scanning,
                atOrAbove: (min: string) => {
                  asked.push(min);
                  return new Map(rows.map((r) => [r.resourceId, r]));
                },
              }
            : null,
      }),
    };
  };

  it("no_critical_vulnerabilities is not applicable until a scanner has reported", async () => {
    const { sig } = vulnFeed(false, []);
    const out = await run("no_critical_vulnerabilities", ctx(service(), sig));
    expect(out.status).toBe("not_applicable");
  });

  it("no_critical_vulnerabilities fails on a critical by default and ignores a high", async () => {
    const critical = vulnFeed(true, [vulnSummary({ critical: 2, advisories: ["CVE-2026-1"] })]);
    const out = await run("no_critical_vulnerabilities", ctx(service(), critical.sig));
    expect(out.status).toBe("fail");
    expect(out.detail).toMatch(/1 running member with 2 open vulnerabilities at critical/);
    expect(out.detail).toMatch(/CVE-2026-1/);
    expect(critical.asked).toEqual(["critical"]);

    const high = vulnFeed(true, [vulnSummary({ high: 3 })]);
    expect((await run("no_critical_vulnerabilities", ctx(service(), high.sig))).status).toBe(
      "pass",
    );
    expect(
      (
        await run("no_critical_vulnerabilities", ctx(service(), high.sig), {
          severities: ["critical", "high"],
        })
      ).status,
    ).toBe("fail");
    expect(high.asked).toContain("high");
  });

  it("no_critical_vulnerabilities ignores resources that are not members", async () => {
    const { sig } = vulnFeed(true, [vulnSummary({ resourceId: "r-other", critical: 1 })]);
    expect((await run("no_critical_vulnerabilities", ctx(service(), sig))).status).toBe("pass");
  });

  it("no_critical_vulnerabilities reports an unreadable feed as an error", async () => {
    const down = signals({ extension: async () => null });
    expect((await run("no_critical_vulnerabilities", ctx(service(), down))).status).toBe("error");
  });

  const cfrFeed = (byService: Map<string | null, unknown> | null) => {
    const keys: string[] = [];
    return {
      keys,
      sig: signals({
        extension: async (key: string) => {
          keys.push(key);
          return byService;
        },
      }),
    };
  };
  const summary = (changes: number, failures: number) => ({
    changeFailureRate: {
      value: changes > 0 ? failures / changes : null,
      band: null,
      sample: changes,
      changes,
      failures,
    },
  });

  it("change_failure_rate is not applicable without production changes", async () => {
    const { sig } = cfrFeed(new Map([["svc-other", summary(10, 5)]]));
    const out = await run("change_failure_rate", ctx(service(), sig));
    expect(out.status).toBe("not_applicable");
  });

  it("change_failure_rate compares the service's rate to the threshold", async () => {
    const { sig, keys } = cfrFeed(new Map([["svc-1", summary(20, 3)]]));
    expect((await run("change_failure_rate", ctx(service(), sig))).status).toBe("pass");
    const tight = await run("change_failure_rate", ctx(service(), sig), {
      maxFailureRatePercent: 10,
      windowDays: 7,
    });
    expect(tight.status).toBe("fail");
    expect(tight.detail).toMatch(/3 of 20 production changes failed in 7 days \(15%/);
    // One load per window, shared by every service in the evaluation.
    expect(keys).toEqual(["dora-service:30", "dora-service:7"]);
  });

  it("change_failure_rate reports an unreadable feed as an error", async () => {
    const { sig } = cfrFeed(null);
    expect((await run("change_failure_rate", ctx(service(), sig))).status).toBe("error");
  });
});

describe("scoreService", () => {
  it("scores the default scorecard and assigns a level", async () => {
    const card: Scorecard = {
      ...defaultScorecardInput(),
      id: "sc-1",
      isDefault: true,
      lastEvaluatedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const result = await scoreService(
      card,
      service({ ownerTeam: "Payments" }),
      [member],
      new Map(),
      signals(),
    );
    // Applicable: owner (2, pass), on-call (2, fail), SLO (2, fail), runbook
    // (1, fail), posture (2, pass), orphans (1, pass). Backups, tags and cost
    // are not applicable, and so are vulnerabilities and change failure rate
    // with no scanner and no deploys. 5 of 10.
    expect(result.score).toBe(50);
    expect(result.level).toBe("bronze");
    expect(result.checks.find((c) => c.type === "backups_verified")?.status).toBe("not_applicable");
  });
});
