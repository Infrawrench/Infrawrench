import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../alerts/route", () => ({ routeAlert: vi.fn() }));

import {
  defaultScorecardInput,
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
    extension: async () => null,
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
    // are not applicable. 5 of 10.
    expect(result.score).toBe(50);
    expect(result.level).toBe("bronze");
    expect(result.checks.find((c) => c.type === "backups_verified")?.status).toBe("not_applicable");
  });
});
