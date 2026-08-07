import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The config-as-code planner: how a document is matched against what the org
 * already has, and what that produces.
 *
 * The database is mocked out entirely — the planner's job is to turn (current
 * state, document, mode) into a list of changes and a list of deferred writes,
 * and that is pure decision-making. The writes themselves are exercised by the
 * queries they build, not here.
 */

const state = {
  accountNameById: new Map<string, string>(),
  accountIdByName: new Map<string, string>(),
  budgets: [] as unknown[],
  customGraphs: [] as unknown[],
  workflows: [] as unknown[],
  dashboards: [] as unknown[],
  metricAlerts: [] as unknown[],
  probes: [] as unknown[],
  costCentres: [] as unknown[],
  tagPolicy: { requiredTags: [] as unknown[], enforceOnCreate: false },
  alertSettings: {
    costAnomaly: { sigmas: 3, minDeltaCents: 1000, newSourceMinCents: 2500, smsAlerts: "off" },
    drift: {
      notifyCreated: true,
      notifyUpdated: false,
      notifyDeleted: true,
      cooldownMinutes: 60,
      minChanges: 1,
      accounts: [] as string[],
    },
    expiry: { enabled: true, leadDays: 60 },
    posture: { enabled: true },
    digest: {
      enabled: false,
      timezone: "UTC",
      sendDay: 1,
      sendHour: 7,
      narrativeEnabled: false,
      recipients: [] as string[],
    },
  },
};

vi.mock("../org-config/state", () => ({
  loadOrgConfigState: () => Promise.resolve(state),
}));

vi.mock("../../db/client", () => ({
  db: {
    // Only `loadWebhookTokens` reads through `db` at plan time.
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    transaction: (fn: (tx: unknown) => Promise<void>) => fn({}),
  },
}));

vi.mock("../entitlements", () => ({
  requirePaidPlan: vi.fn(() => Promise.resolve()),
  PlanRequiredError: class PlanRequiredError extends Error {},
}));

vi.mock("@infrawrench/server-core/cost/anomaly-settings", () => ({
  normalizeAnomalySettings: (v: unknown) => v,
}));

vi.mock("@infrawrench/server-core/cost/tag-policy", () => ({
  normalizeTagPolicy: (v: unknown) => v,
}));

vi.mock("@infrawrench/server-core/digest/compose", () => ({
  digestWindow: () => ({ weekStart: "2026-08-03" }),
  isValidTimeZone: (tz: string) => tz === "UTC" || tz === "Europe/Berlin",
}));

vi.mock("@infrawrench/server-core/email", () => ({
  normalizeEmailAddress: (raw: string) => raw.trim().toLowerCase(),
}));

const { planOrgConfig, OrgConfigError } = await import("../org-config");
const { parseOrgConfigDocument } = await import("../org-config/schema");

const OPTS = { mode: "merge" as const, userId: "user-1" };

function budget(key: string, name: string, amountCents = 10_000) {
  return {
    key,
    name,
    amountCents,
    currency: "USD",
    filters: [],
    thresholds: [{ type: "actual" as const, percent: 80 }],
  };
}

function reset() {
  state.accountNameById = new Map([["acct-1", "Production"]]);
  state.accountIdByName = new Map([["production", "acct-1"]]);
  state.budgets = [];
  state.customGraphs = [];
  state.workflows = [];
  state.dashboards = [];
  state.metricAlerts = [];
  state.probes = [];
  state.costCentres = [];
  state.tagPolicy = { requiredTags: [], enforceOnCreate: false };
}

beforeEach(reset);

const plan = (doc: unknown, mode: "merge" | "replace" = "merge") =>
  planOrgConfig("org-1", parseOrgConfigDocument(doc), { ...OPTS, mode });

describe("matching by key", () => {
  it("creates what the org doesn't have", async () => {
    const result = await plan({ budgets: [budget("spend", "Cloud spend")] });
    expect(result.changes).toEqual([
      { section: "budgets", key: "spend", name: "Cloud spend", action: "create" },
    ]);
    expect(result.counts).toMatchObject({ create: 1, update: 0, delete: 0, unchanged: 0 });
  });

  it("reports an identical document as entirely unchanged", async () => {
    state.budgets = [{ key: "spend", id: "b1", config: budget("spend", "Cloud spend") }];
    const result = await plan({ budgets: [budget("spend", "Cloud spend")] });
    expect(result.counts).toMatchObject({ create: 0, update: 0, delete: 0, unchanged: 1 });
  });

  it("names the fields that differ on an update", async () => {
    state.budgets = [{ key: "spend", id: "b1", config: budget("spend", "Cloud spend", 10_000) }];
    const result = await plan({ budgets: [budget("spend", "Cloud spend", 25_000)] });
    expect(result.changes[0]).toMatchObject({ action: "update", fields: ["amountCents"] });
  });

  it("treats a rename under the same key as an update, not a replacement", async () => {
    state.budgets = [{ key: "spend", id: "b1", config: budget("spend", "Cloud spend") }];
    const result = await plan({ budgets: [budget("spend", "Total spend")] });
    expect(result.counts).toMatchObject({ create: 0, update: 1, delete: 0 });
    expect(result.changes[0]?.fields).toEqual(["name"]);
  });
});

describe("merge vs replace", () => {
  it("merge leaves entities the document doesn't name alone", async () => {
    state.budgets = [{ key: "old", id: "b1", config: budget("old", "Old budget") }];
    const result = await plan({ budgets: [budget("new", "New budget")] });
    expect(result.counts).toMatchObject({ create: 1, delete: 0 });
  });

  it("replace deletes them", async () => {
    state.budgets = [{ key: "old", id: "b1", config: budget("old", "Old budget") }];
    const result = await plan({ budgets: [budget("new", "New budget")] }, "replace");
    expect(result.counts).toMatchObject({ create: 1, delete: 1 });
    expect(result.changes).toContainEqual({
      section: "budgets",
      key: "old",
      name: "Old budget",
      action: "delete",
    });
  });

  it("replace only touches the sections the document carries", async () => {
    state.budgets = [{ key: "old", id: "b1", config: budget("old", "Old budget") }];
    state.probes = [
      {
        key: "health",
        id: "p1",
        config: {
          key: "health",
          name: "health",
          url: "https://example.com/health",
          method: "GET",
          intervalSeconds: 60,
          timeoutMs: 10_000,
          failureThreshold: 3,
          enabled: true,
        },
      },
    ];
    const result = await plan({ budgets: [] }, "replace");
    expect(result.changes.map((c) => c.section)).toEqual(["budgets"]);
    expect(result.counts.delete).toBe(1);
  });

  it("never deletes the default dashboard, and says why", async () => {
    state.dashboards = [
      { key: "home", id: "d1", config: { key: "home", name: "Home", isDefault: true, cards: [] } },
      {
        key: "spare",
        id: "d2",
        config: { key: "spare", name: "Spare", isDefault: false, cards: [] },
      },
    ];
    const result = await plan({ dashboards: [] }, "replace");
    expect(result.changes.map((c) => c.key)).toEqual(["spare"]);
    expect(result.unresolved[0]).toMatchObject({ section: "dashboards", key: "home" });
    expect(result.unresolved[0]?.detail).toMatch(/default dashboard/);
  });
});

describe("cross-section references", () => {
  it("resolves a budget trigger against a budget created by the same document", async () => {
    const result = await plan({
      budgets: [budget("spend", "Cloud spend")],
      workflows: [
        {
          key: "notify",
          name: "Notify",
          source: "",
          trigger: { kind: "budget", budgetKey: "spend" },
        },
      ],
    });
    expect(result.unresolved).toEqual([]);
    expect(result.counts.create).toBe(2);
  });

  it("falls back to manual and reports a budget trigger nothing satisfies", async () => {
    const result = await plan({
      workflows: [
        {
          key: "notify",
          name: "Notify",
          source: "",
          trigger: { kind: "budget", budgetKey: "missing" },
        },
      ],
    });
    expect(result.counts.create).toBe(1);
    expect(result.unresolved[0]).toMatchObject({ section: "workflows", key: "notify" });
    expect(result.unresolved[0]?.detail).toMatch(/set to manual/);
  });

  it("drops a dashboard card whose workflow the document doesn't define", async () => {
    const result = await plan({
      dashboards: [
        {
          key: "home",
          name: "Home",
          cards: [{ kind: "workflow", workflowKey: "nope" }],
        },
      ],
    });
    expect(result.unresolved[0]?.detail).toMatch(/workflow card names "nope"/);
  });

  it("drops a resource pin for an account this org has not connected", async () => {
    const result = await plan({
      dashboards: [
        {
          key: "home",
          name: "Home",
          cards: [
            {
              kind: "resource",
              pluginId: "gcp",
              resourceTypeId: "gce-instance",
              externalId: "projects/p/instances/i",
              account: "Some Other Org",
            },
          ],
        },
      ],
    });
    expect(result.unresolved[0]?.detail).toMatch(/Some Other Org/);
  });

  it("rejects a widget config the hand-editing route would have rejected", async () => {
    await expect(
      plan({
        dashboards: [
          {
            key: "home",
            name: "Home",
            cards: [{ kind: "widget", widgetKind: "cost_graph", config: { version: 2 } }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(OrgConfigError);
  });
});

describe("alert settings", () => {
  it("reports an unchanged group as unchanged", async () => {
    const result = await plan({ alertSettings: { expiry: { enabled: true, leadDays: 60 } } });
    expect(result.changes).toEqual([
      { section: "alertSettings", key: "expiry", name: "Expiry alerts", action: "unchanged" },
    ]);
  });

  it("updates only the groups the document carries", async () => {
    const result = await plan({
      alertSettings: { expiry: { enabled: false, leadDays: 30 } },
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ action: "update", fields: ["enabled", "leadDays"] });
  });

  it("refuses a drift scope that resolves to nothing, rather than silently widening it", async () => {
    // An empty scope means "every account", so dropping unknown names would
    // turn a three-account scope into org-wide alerting.
    await expect(
      plan({
        alertSettings: {
          drift: {
            notifyCreated: true,
            notifyUpdated: false,
            notifyDeleted: true,
            cooldownMinutes: 60,
            minChanges: 1,
            accounts: ["Ghost Account"],
          },
        },
      }),
    ).rejects.toThrow(/empty scope would mean every account/);
  });

  it("refuses an unknown digest timezone", async () => {
    await expect(
      plan({
        alertSettings: {
          digest: {
            enabled: true,
            timezone: "Mars/Olympus",
            sendDay: 1,
            sendHour: 7,
            narrativeEnabled: false,
            recipients: [],
          },
        },
      }),
    ).rejects.toThrow(/Unknown digest time zone/);
  });
});

describe("probes", () => {
  it("refuses a probe URL the editor would have refused", async () => {
    await expect(
      plan({ probes: [{ key: "health", name: "health", url: "not-a-url" }] }),
    ).rejects.toThrow(/must be absolute/);
  });
});
