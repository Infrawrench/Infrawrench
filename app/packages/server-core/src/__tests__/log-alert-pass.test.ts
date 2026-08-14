import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertReachedImpl, routed, unroutedResult } from "./helpers/route-alert";
import { fakePostgres } from "./helpers/fake-postgres";

// --- capture vars, reset per test -----------------------------------------

/** Rows the raw claim UPDATE returns — snake_case, passed through unmapped. */
let claimRows: Array<{ id: string; claim_token: string }> = [];
let queryRow: Record<string, unknown> | undefined;
/** Rows the stream-name lookup returns, in its projection order. */
let resourceRows: Array<{ id: string; displayName: string; deletedAt: string | null }> = [];

const getLogs = vi.fn();
const peerGetLogs = vi.fn();
const getOrgAccountClient = vi.fn();
const getClientForResource = vi.fn();

// --- module mocks (before the SUT import) ----------------------------------

// Real Drizzle over a recording driver against the real schema — the claim,
// the post-claim refetch, the stream-name lookup and the completion write all
// render their actual SQL (and shadow-validate under test:postgres:shadow).
// `runPass` queues each query's rows FIFO in execution order.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/**
 * The completion UPDATEs, decoded back to `{column: param}` from the rendered
 * set-clause. Columns render in table order and the WHERE's params follow the
 * set params, so slicing at ` where ` keeps the mapping exact. Timestamps come
 * back as the ISO strings the driver would send.
 */
function completionWrites(): Array<Record<string, unknown>> {
  return pg.queries
    .filter((q) => q.sql.startsWith('update "log_workspace_queries"'))
    .map((q) => {
      const setClause = q.sql.slice(0, q.sql.indexOf(" where "));
      const cols = [...setClause.matchAll(/"([a-z_]+)" = \$/g)].map((m) => m[1]!);
      return Object.fromEntries(cols.map((c, i) => [c, q.params[i]]));
    });
}

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
  alertReached: alertReachedImpl,
}));

const { runLogAlertPass } = await import("../log-workspaces/pass");
import { LOG_WORKSPACE_LIMITS } from "@infrawrench/client-core";

// --- fixtures ---------------------------------------------------------------

const NOW = Date.parse("2026-08-03T10:00:00.000Z");

/** A timestamp in the text form the Postgres driver hands back. */
const pgTs = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

// Keys in log_workspace_queries column order, values driver-shaped — see
// helpers/fake-postgres.ts.
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
    nextEvalAt: pgTs(new Date(NOW)),
    lastEvalAt: null,
    lastMatchAt: null,
    lastAlertedAt: null,
    lastEvalError: null,
    lastMatchSample: null,
    createdByUserId: null,
    createdAt: pgTs(new Date(NOW - 1000)),
    updatedAt: pgTs(new Date(NOW - 1000)),
    ...over,
  };
}

/**
 * Queue one pass's DB responses in execution order, then run it: the claim,
 * the post-claim refetch, the stream-name lookup (skipped with
 * `names: false` for rows whose guards fire before it), and the completion
 * UPDATE's RETURNING row (the claim token still held).
 */
async function runPass(opts: { names?: boolean } = {}) {
  pg.queueRows(claimRows);
  if (claimRows.length > 0) {
    pg.queueRows(queryRow ? [queryRow] : []);
    if (opts.names !== false) pg.queueRows(resourceRows);
    pg.queueRows([{ id: "q1" }]);
  }
  return runLogAlertPass({ now: NOW });
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
  pg.reset();
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
    const result = await runPass();
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

    const completion = completionWrites().at(-1)!;
    expect(completion["last_alerted_at"]).toBe(new Date(NOW).toISOString());
    expect(completion["last_match_at"]).toBe(new Date(NOW).toISOString());
    expect(completion["last_match_sample"]).toBe("ERROR boom");
    expect(completion["last_eval_error"]).toBeNull();
    expect(completion["next_eval_at"]).toBe(
      new Date(NOW + LOG_WORKSPACE_LIMITS.alertEvalIntervalMs).toISOString(),
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
    await runPass();
    expect(getLogs).toHaveBeenCalledWith("k8s-pod", "res-1", "acc-1", {
      tailLines: LOG_WORKSPACE_LIMITS.alertTailLines,
      container: "sidecar",
    });
  });

  it("does not stamp lastAlertedAt when no channel delivered", async () => {
    routeAlert.mockResolvedValue(unroutedResult());
    const result = await runPass();
    expect(result.notified).toBe(0);
    const completion = completionWrites().at(-1)!;
    expect(completion["last_alerted_at"]).toBeUndefined();
    expect(completion["last_match_at"]).toBe(new Date(NOW).toISOString());
  });
});

describe("runLogAlertPass — cooldown", () => {
  it("suppresses dispatch inside the cooldown window but still records the match", async () => {
    queryRow = baseRow({
      lastAlertedAt: pgTs(new Date(NOW - LOG_WORKSPACE_LIMITS.alertCooldownMs + 60_000)),
    });
    const result = await runPass();
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 1, notified: 0, failed: 0 });
    expect(routeAlert).not.toHaveBeenCalled();
    const completion = completionWrites().at(-1)!;
    expect(completion["last_match_at"]).toBe(new Date(NOW).toISOString());
    expect(completion["last_alerted_at"]).toBeUndefined();
  });

  it("dispatches again once the cooldown has elapsed", async () => {
    queryRow = baseRow({
      lastAlertedAt: pgTs(new Date(NOW - LOG_WORKSPACE_LIMITS.alertCooldownMs - 1)),
    });
    const result = await runPass();
    expect(result.notified).toBe(1);
    expect(routeAlert).toHaveBeenCalledTimes(1);
  });
});

describe("runLogAlertPass — no match", () => {
  it("records the evaluation without dispatching", async () => {
    getLogs.mockResolvedValue({ text: "all good\n", containers: [], activeContainer: "" });
    const result = await runPass();
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 0, notified: 0, failed: 0 });
    expect(routeAlert).not.toHaveBeenCalled();
    const completion = completionWrites().at(-1)!;
    expect(completion["last_eval_at"]).toBe(new Date(NOW).toISOString());
    expect(completion["last_match_at"]).toBeUndefined();
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
    const result = await runPass();
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
    resourceRows = [
      { id: "parent-1", displayName: "prod-cluster", deletedAt: pgTs(new Date(NOW)) },
    ];
    const result = await runPass();
    expect(result.failed).toBe(1);
    expect(getClientForResource).not.toHaveBeenCalled();
    const completion = completionWrites().at(-1)!;
    expect(completion["last_eval_error"]).toContain("Parent resource parent-1 is no longer synced");
  });

  it("reports a vanished peer integration as the stream's error", async () => {
    queryRow = baseRow({ resources: [sidecarSelector] });
    resourceRows = [{ id: "parent-1", displayName: "prod-cluster", deletedAt: null }];
    getClientForResource.mockResolvedValue(null);
    const result = await runPass();
    expect(result.failed).toBe(1);
    const completion = completionWrites().at(-1)!;
    expect(completion["last_eval_error"]).toContain("no longer exposes a kubernetes sidecar");
  });

  it("caches one peer client per parent across a query's streams", async () => {
    queryRow = baseRow({
      resources: [
        sidecarSelector,
        { ...sidecarSelector, resourceId: "acc-1:k8s-pod:default:api-1" },
      ],
    });
    resourceRows = [{ id: "parent-1", displayName: "prod-cluster", deletedAt: null }];
    await runPass();
    expect(getClientForResource).toHaveBeenCalledTimes(1);
    expect(peerGetLogs).toHaveBeenCalledTimes(2);
  });
});

describe("runLogAlertPass — guard rails", () => {
  it("records an error instead of alerting for an empty (match-all) expression", async () => {
    queryRow = baseRow({ search: "   " });
    // The compile guard fires before the stream-name lookup runs.
    const result = await runPass({ names: false });
    expect(result.failed).toBe(1);
    expect(getLogs).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
    expect(completionWrites().at(-1)!["last_eval_error"]).toMatch(/non-empty search/);
  });

  it("records an invalid regex instead of alerting", async () => {
    queryRow = baseRow({ search: "/[unclosed/" });
    const result = await runPass({ names: false });
    expect(result.failed).toBe(1);
    expect(getLogs).not.toHaveBeenCalled();
    expect(completionWrites().at(-1)!["last_eval_error"]).toMatch(/Invalid regex/);
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
    const result = await runPass();
    // res-1 still matched and notified; res-gone is reported.
    expect(result).toEqual({ claimed: 1, evaluated: 1, matched: 1, notified: 1, failed: 1 });
    expect(String(completionWrites().at(-1)!["last_eval_error"])).toMatch(/no longer synced/);
  });

  it("reports a plugin that no longer supports logs", async () => {
    getOrgAccountClient.mockResolvedValue({ client: {} });
    const result = await runPass();
    expect(result.failed).toBe(1);
    expect(String(completionWrites().at(-1)!["last_eval_error"])).toMatch(
      /no longer supports logs/,
    );
  });

  it("skips rows whose alert was turned off after the claim", async () => {
    queryRow = baseRow({ alertEnabled: false });
    const result = await runPass({ names: false });
    expect(result).toEqual({ claimed: 1, evaluated: 0, matched: 0, notified: 0, failed: 0 });
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("does nothing when no queries are due", async () => {
    claimRows = [];
    const result = await runPass();
    expect(result).toEqual({ claimed: 0, evaluated: 0, matched: 0, notified: 0, failed: 0 });
  });
});
