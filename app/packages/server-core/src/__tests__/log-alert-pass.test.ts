import { beforeEach, describe, expect, it, vi } from "vitest";

// --- capture vars, reset per test -----------------------------------------

let claimRows: Array<{ id: string; claim_token: string }> = [];
let queryRow: Record<string, unknown> | undefined;
let resourceRows: Array<{ id: string; displayName: string; deletedAt: Date | null }> = [];
const completionWrites: Array<Record<string, unknown>> = [];
let completionMatches = true;

const getLogs = vi.fn();
const peerGetLogs = vi.fn();
const getOrgAccountClient = vi.fn();
const getClientForResource = vi.fn();

// --- module mocks (before the SUT import) ----------------------------------

vi.mock("../db/client", () => {
  // `db.select()` serves two call sites: the query-row refetch (select().
  // from(logWorkspaceQueries)...limit(1)) and the stream-name lookup
  // (select({...}).from(resources).where(...)). Distinguish by the table.
  const select = (_shape?: unknown) => ({
    from: (table: { __t?: string }) => {
      if (table.__t === "resources") {
        return { where: () => Promise.resolve(resourceRows) };
      }
      return {
        where: () => ({ limit: () => Promise.resolve(queryRow ? [queryRow] : []) }),
      };
    },
  });
  return {
    db: {
      execute: () => Promise.resolve(claimRows),
      select,
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            completionWrites.push(values);
            return {
              returning: () => Promise.resolve(completionMatches ? [{ id: "q1" }] : []),
            };
          },
        }),
      }),
    },
  };
});

vi.mock("../db/schema", () => ({
  logWorkspaceQueries: { __t: "logWorkspaceQueries", id: "id", nextEvalAt: "nextEvalAt" },
  resources: {
    __t: "resources",
    id: "id",
    displayName: "displayName",
    deletedAt: "deletedAt",
    organizationId: "organizationId",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), {
    raw: () => ({ sql: true }),
  }),
}));

vi.mock("../org-accounts", () => ({
  getOrgAccountClient: (...a: unknown[]) => getOrgAccountClient(...a),
}));
// Sidecar streams resolve their client through the peer path; mocked at the
// same boundary as org-accounts (the real module pulls in the plugin loader).
vi.mock("../peer-clients", () => ({
  getClientForResource: (...a: unknown[]) => getClientForResource(...a),
}));

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number; held?: number } | null | undefined) =>
    (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0,
}));

/** A delivery that reached one Slack channel and one phone. */
function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // The tracked-Slack half of the result. Present by default because
    // `byTransport.slack` is 1 — a result claiming a Slack delivery with no
    // message to show for it is a shape the real function never returns.
    slackMessages: [{ installationId: "inst1", channelId: "C1", ts: "1722700000.000100" }],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

import { runLogAlertPass } from "../log-workspaces/pass";
import { LOG_WORKSPACE_LIMITS } from "@infrawrench/client-core";

// --- fixtures ---------------------------------------------------------------

const NOW = Date.parse("2026-08-03T10:00:00.000Z");

function baseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "q1",
    organizationId: "org-1",
    name: "prod errors",
    resources: [
      {
        resourceId: "res-1",
        accountId: "acc-1",
        pluginId: "kubernetes",
        resourceTypeId: "k8s-pod",
      },
    ],
    search: "error",
    alertEnabled: true,
    nextEvalAt: new Date(NOW),
    lastEvalAt: null,
    lastMatchAt: null,
    lastAlertedAt: null,
    lastEvalError: null,
    lastMatchSample: null,
    createdByUserId: null,
    createdAt: new Date(NOW - 1000),
    updatedAt: new Date(NOW - 1000),
    ...over,
  };
}

function hushLogs() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

beforeEach(() => {
  vi.restoreAllMocks();
  hushLogs();
  claimRows = [{ id: "q1", claim_token: "2026-08-03 10:10:00" }];
  queryRow = baseRow();
  resourceRows = [{ id: "res-1", displayName: "api-pod", deletedAt: null }];
  completionWrites.length = 0;
  completionMatches = true;
  getLogs.mockReset().mockResolvedValue({
    text: "ok line\nERROR boom\n",
    containers: ["app"],
    activeContainer: "app",
  });
  getOrgAccountClient.mockReset().mockResolvedValue({ client: { getLogs } });
  peerGetLogs.mockReset().mockResolvedValue({
    text: "ok line\nERROR pod boom\n",
    containers: ["app"],
    activeContainer: "app",
  });
  getClientForResource.mockReset().mockResolvedValue({ client: { getLogs: peerGetLogs } });
  routeAlert.mockReset().mockResolvedValue(routed());
});

// --- tests ------------------------------------------------------------------

describe("runLogAlertPass — match and dispatch", () => {
  it("fetches a bounded tail, dispatches on match and stamps lastAlertedAt", async () => {
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 1, notified: 1, failed: 0 });

    expect(getLogs).toHaveBeenCalledWith("k8s-pod", "res-1", "acc-1", {
      tailLines: LOG_WORKSPACE_LIMITS.alertTailLines,
    });

    expect(routeAlert).toHaveBeenCalledTimes(1);
    const [event] = routeAlert.mock.calls[0]! as [
      {
        organizationId: string;
        trigger: string;
        title: string;
        pushData: Record<string, unknown>;
      },
    ];
    expect(event.organizationId).toBe("org-1");
    expect(event.trigger).toBe("logMatchAlerts");
    expect(event.title).toBe("Log match: prod errors");
    expect(event.pushData).toEqual({
      type: "log_match",
      orgId: "org-1",
      queryId: "q1",
      matchCount: 1,
    });

    const completion = completionWrites.at(-1)!;
    expect(completion["lastAlertedAt"]).toEqual(new Date(NOW));
    expect(completion["lastMatchAt"]).toEqual(new Date(NOW));
    expect(completion["lastMatchSample"]).toBe("ERROR boom");
    expect(completion["lastEvalError"]).toBeNull();
    expect(completion["nextEvalAt"]).toEqual(
      new Date(NOW + LOG_WORKSPACE_LIMITS.alertEvalIntervalMs),
    );
  });

  it("passes the saved container through to getLogs", async () => {
    queryRow = baseRow({
      resources: [
        {
          resourceId: "res-1",
          accountId: "acc-1",
          pluginId: "kubernetes",
          resourceTypeId: "k8s-pod",
          container: "sidecar",
        },
      ],
    });
    await runLogAlertPass({ now: NOW });
    expect(getLogs).toHaveBeenCalledWith("k8s-pod", "res-1", "acc-1", {
      tailLines: LOG_WORKSPACE_LIMITS.alertTailLines,
      container: "sidecar",
    });
  });

  it("does not stamp lastAlertedAt when no channel delivered", async () => {
    routeAlert.mockResolvedValue(unroutedResult());
    const result = await runLogAlertPass({ now: NOW });
    expect(result.notified).toBe(0);
    const completion = completionWrites.at(-1)!;
    expect(completion["lastAlertedAt"]).toBeUndefined();
    expect(completion["lastMatchAt"]).toEqual(new Date(NOW));
  });
});

describe("runLogAlertPass — cooldown", () => {
  it("suppresses dispatch inside the cooldown window but still records the match", async () => {
    queryRow = baseRow({
      lastAlertedAt: new Date(NOW - LOG_WORKSPACE_LIMITS.alertCooldownMs + 60_000),
    });
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 1, notified: 0, failed: 0 });
    expect(routeAlert).not.toHaveBeenCalled();
    const completion = completionWrites.at(-1)!;
    expect(completion["lastMatchAt"]).toEqual(new Date(NOW));
    expect(completion["lastAlertedAt"]).toBeUndefined();
  });

  it("dispatches again once the cooldown has elapsed", async () => {
    queryRow = baseRow({
      lastAlertedAt: new Date(NOW - LOG_WORKSPACE_LIMITS.alertCooldownMs - 1),
    });
    const result = await runLogAlertPass({ now: NOW });
    expect(result.notified).toBe(1);
    expect(routeAlert).toHaveBeenCalledTimes(1);
  });
});

describe("runLogAlertPass — no match", () => {
  it("records the evaluation without dispatching", async () => {
    getLogs.mockResolvedValue({ text: "all good\n", containers: [], activeContainer: "" });
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 0, notified: 0, failed: 0 });
    expect(routeAlert).not.toHaveBeenCalled();
    const completion = completionWrites.at(-1)!;
    expect(completion["lastEvalAt"]).toEqual(new Date(NOW));
    expect(completion["lastMatchAt"]).toBeUndefined();
  });
});

describe("runLogAlertPass — sidecar streams", () => {
  const sidecarSelector = {
    resourceId: "acc-1:k8s-pod:default:api-0",
    accountId: "acc-1",
    pluginId: "kubernetes",
    resourceTypeId: "k8s-pod",
    parentResourceId: "parent-1",
  };

  it("resolves the client through the peer path and anchors names on the parent", async () => {
    queryRow = baseRow({ resources: [sidecarSelector] });
    resourceRows = [{ id: "parent-1", displayName: "prod-cluster", deletedAt: null }];
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 1, notified: 1, failed: 0 });

    expect(getOrgAccountClient).not.toHaveBeenCalled();
    expect(getClientForResource).toHaveBeenCalledWith("kubernetes", "acc-1", "org-1", "parent-1");
    expect(peerGetLogs).toHaveBeenCalledWith("k8s-pod", "acc-1:k8s-pod:default:api-0", "acc-1", {
      tailLines: LOG_WORKSPACE_LIMITS.alertTailLines,
    });
    // The notification names the stream through its parent, not the raw id.
    const [event] = routeAlert.mock.calls[0]! as unknown as [{ body: string }];
    expect(event.body).toContain("prod-cluster/default:api-0");
  });

  it("reports a gone parent instead of evaluating", async () => {
    queryRow = baseRow({ resources: [sidecarSelector] });
    resourceRows = [{ id: "parent-1", displayName: "prod-cluster", deletedAt: new Date(NOW) }];
    const result = await runLogAlertPass({ now: NOW });
    expect(result.failed).toBe(1);
    expect(getClientForResource).not.toHaveBeenCalled();
    const completion = completionWrites.at(-1)!;
    expect(completion["lastEvalError"]).toContain("Parent resource parent-1 is no longer synced");
  });

  it("reports a vanished peer integration as the stream's error", async () => {
    queryRow = baseRow({ resources: [sidecarSelector] });
    resourceRows = [{ id: "parent-1", displayName: "prod-cluster", deletedAt: null }];
    getClientForResource.mockResolvedValue(null);
    const result = await runLogAlertPass({ now: NOW });
    expect(result.failed).toBe(1);
    const completion = completionWrites.at(-1)!;
    expect(completion["lastEvalError"]).toContain("no longer exposes a kubernetes sidecar");
  });

  it("caches one peer client per parent across a query's streams", async () => {
    queryRow = baseRow({
      resources: [
        sidecarSelector,
        { ...sidecarSelector, resourceId: "acc-1:k8s-pod:default:api-1" },
      ],
    });
    resourceRows = [{ id: "parent-1", displayName: "prod-cluster", deletedAt: null }];
    await runLogAlertPass({ now: NOW });
    expect(getClientForResource).toHaveBeenCalledTimes(1);
    expect(peerGetLogs).toHaveBeenCalledTimes(2);
  });
});

describe("runLogAlertPass — guard rails", () => {
  it("records an error instead of alerting for an empty (match-all) expression", async () => {
    queryRow = baseRow({ search: "   " });
    const result = await runLogAlertPass({ now: NOW });
    expect(result.failed).toBe(1);
    expect(getLogs).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
    expect(completionWrites.at(-1)!["lastEvalError"]).toMatch(/non-empty search/);
  });

  it("records an invalid regex instead of alerting", async () => {
    queryRow = baseRow({ search: "/[unclosed/" });
    const result = await runLogAlertPass({ now: NOW });
    expect(result.failed).toBe(1);
    expect(getLogs).not.toHaveBeenCalled();
    expect(completionWrites.at(-1)!["lastEvalError"]).toMatch(/Invalid regex/);
  });

  it("aggregates per-stream failures into lastEvalError without blocking others", async () => {
    queryRow = baseRow({
      resources: [
        {
          resourceId: "res-1",
          accountId: "acc-1",
          pluginId: "kubernetes",
          resourceTypeId: "k8s-pod",
        },
        {
          resourceId: "res-gone",
          accountId: "acc-1",
          pluginId: "kubernetes",
          resourceTypeId: "k8s-pod",
        },
      ],
    });
    const result = await runLogAlertPass({ now: NOW });
    // res-1 still matched and notified; res-gone is reported.
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 1, notified: 1, failed: 1 });
    expect(String(completionWrites.at(-1)!["lastEvalError"])).toMatch(/no longer synced/);
  });

  it("reports a plugin that no longer supports logs", async () => {
    getOrgAccountClient.mockResolvedValue({ client: {} });
    const result = await runLogAlertPass({ now: NOW });
    expect(result.failed).toBe(1);
    expect(String(completionWrites.at(-1)!["lastEvalError"])).toMatch(/no longer supports logs/);
  });

  it("skips rows whose alert was turned off after the claim", async () => {
    queryRow = baseRow({ alertEnabled: false });
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 1, evaluated: 0, matched: 0, notified: 0, failed: 0 });
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("does nothing when no queries are due", async () => {
    claimRows = [];
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 0, evaluated: 0, matched: 0, notified: 0, failed: 0 });
  });
});
