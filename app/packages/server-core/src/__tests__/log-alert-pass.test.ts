import { beforeEach, describe, expect, it, vi } from "vitest";

// --- capture vars, reset per test -----------------------------------------

let claimRows: Array<{ id: string; claim_token: string }> = [];
let queryRow: Record<string, unknown> | undefined;
let resourceRows: Array<{ id: string; displayName: string; deletedAt: Date | null }> = [];
const completionWrites: Array<Record<string, unknown>> = [];
let completionMatches = true;

const getLogs = vi.fn();
const getOrgAccountClient = vi.fn();
const sendPushToOrg = vi.fn();
const sendSlackToOrg = vi.fn();
const sendMsTeamsToOrg = vi.fn();

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
vi.mock("../push/dispatch", () => ({
  sendPushToOrg: (...a: unknown[]) => sendPushToOrg(...a),
}));
vi.mock("../slack", () => ({
  sendSlackToOrg: (...a: unknown[]) => sendSlackToOrg(...a),
}));
vi.mock("../msteams", () => ({
  sendMsTeamsToOrg: (...a: unknown[]) => sendMsTeamsToOrg(...a),
}));

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
  sendPushToOrg.mockReset().mockResolvedValue({ attempted: 1, succeeded: 1 });
  sendSlackToOrg.mockReset().mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
  sendMsTeamsToOrg.mockReset().mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
});

// --- tests ------------------------------------------------------------------

describe("runLogAlertPass — match and dispatch", () => {
  it("fetches a bounded tail, dispatches on match and stamps lastAlertedAt", async () => {
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 1, notified: 1, failed: 0 });

    expect(getLogs).toHaveBeenCalledWith("k8s-pod", "res-1", "acc-1", {
      tailLines: LOG_WORKSPACE_LIMITS.alertTailLines,
    });

    expect(sendPushToOrg).toHaveBeenCalledTimes(1);
    const [orgId, trigger, msg] = sendPushToOrg.mock.calls[0]!;
    expect(orgId).toBe("org-1");
    expect(trigger).toBe("logMatchAlerts");
    expect(msg.title).toBe("Log match: prod errors");
    expect(msg.data).toEqual({
      type: "log_match",
      orgId: "org-1",
      queryId: "q1",
      matchCount: 1,
    });
    expect(sendSlackToOrg).toHaveBeenCalledTimes(1);
    expect(sendMsTeamsToOrg).toHaveBeenCalledTimes(1);

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
    sendPushToOrg.mockResolvedValue({ attempted: 0, succeeded: 0 });
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
    expect(sendPushToOrg).not.toHaveBeenCalled();
    expect(sendSlackToOrg).not.toHaveBeenCalled();
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
    expect(sendPushToOrg).toHaveBeenCalledTimes(1);
  });
});

describe("runLogAlertPass — no match", () => {
  it("records the evaluation without dispatching", async () => {
    getLogs.mockResolvedValue({ text: "all good\n", containers: [], activeContainer: "" });
    const result = await runLogAlertPass({ now: NOW });
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 0, notified: 0, failed: 0 });
    expect(sendPushToOrg).not.toHaveBeenCalled();
    const completion = completionWrites.at(-1)!;
    expect(completion["lastEvalAt"]).toEqual(new Date(NOW));
    expect(completion["lastMatchAt"]).toBeUndefined();
  });
});

describe("runLogAlertPass — guard rails", () => {
  it("records an error instead of alerting for an empty (match-all) expression", async () => {
    queryRow = baseRow({ search: "   " });
    const result = await runLogAlertPass({ now: NOW });
    expect(result.failed).toBe(1);
    expect(getLogs).not.toHaveBeenCalled();
    expect(sendPushToOrg).not.toHaveBeenCalled();
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
