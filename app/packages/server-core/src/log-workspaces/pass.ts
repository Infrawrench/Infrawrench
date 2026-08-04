/**
 * The poller's log-alert pass — periodically evaluates alert-enabled saved
 * log queries by fetching a bounded tail of each stream through the same
 * plugin `getLogs` contract the workspace UI uses, and notifies on match.
 *
 * Guard rails, in the order they bite:
 *
 * - **One claim per evaluation.** `next_eval_at` doubles as the claim lease
 *   (the `resource_schedules.next_transition_at` protocol): N poller replicas
 *   claim disjoint rows, and a replica that dies mid-work simply lets the row
 *   come due again at lease expiry.
 * - **Edits beat stale runs.** The lease instant doubles as a claim token:
 *   every completion write requires `next_eval_at` to still hold the claimed
 *   value. A query edit or alert-off recomputes/clears that column, so a
 *   superseded run's completion matches nothing.
 * - **Bounded lookback.** Each stream fetch is capped at
 *   `LOG_WORKSPACE_LIMITS.alertTailLines` tail lines and match counting stops
 *   at `alertMatchCap` — a pathological log volume can never make an
 *   evaluation unbounded.
 * - **Cooldown.** A notification is dispatched at most once per
 *   `alertCooldownMs` per query (`last_alerted_at`), so a query that keeps
 *   matching reports "still matching" on the next cooldown boundary instead
 *   of re-firing every pass. `last_alerted_at` is only stamped when at least
 *   one channel actually delivered — the anomaly-pipeline rule.
 * - **Failures are never silent.** Per-stream failures are aggregated into
 *   `last_eval_error` (surfaced in every saved-query list) and logged with a
 *   `[log-match]` prefix; one query's failure never blocks the rest of the
 *   batch, and nothing here throws into the poller's tick.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  compileLogSearch,
  evaluateLogMatches,
  LOG_WORKSPACE_LIMITS,
  type LogStreamSelector,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { logWorkspaceQueries, resources } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { getClientForResource } from "../peer-clients";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import type { LogWorkspaceQueryRecord } from "./store";

/** Lease written into `next_eval_at` by the claim. */
export const LOG_ALERT_LEASE_MS = 10 * 60 * 1000;

export interface LogAlertPassOptions {
  /** Max queries to evaluate per tick. */
  limit?: number;
  /** Fixed clock for tests. */
  now?: number;
}

export interface LogAlertPassResult {
  claimed: number;
  evaluated: number;
  matched: number;
  notified: number;
  failed: number;
}

/** A claimed row: its id plus the claim token the completion must present. */
interface ClaimedQuery {
  id: string;
  /** Postgres' own text rendering of the lease instant (no driver rounding). */
  claimToken: string;
}

/** Claim due, alert-enabled queries — the `claimDueAccounts` protocol. */
async function claimDueQueries(limit: number): Promise<ClaimedQuery[]> {
  const rows = await db.execute(sql`
    UPDATE log_workspace_queries
    SET next_eval_at = now() + ${LOG_ALERT_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM log_workspace_queries
      WHERE alert_enabled = true
        AND next_eval_at IS NOT NULL
        AND next_eval_at <= now()
      ORDER BY next_eval_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, next_eval_at::text AS claim_token
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    claimToken: String(r["claim_token"]),
  }));
}

/** WHERE fragment shared by the completion writes — see the module header. */
function claimGuard(rowId: string, claimToken: string) {
  return and(
    eq(logWorkspaceQueries.id, rowId),
    sql`${logWorkspaceQueries.nextEvalAt} = ${claimToken}::timestamp`,
  );
}

interface EvalCompletion {
  matched: boolean;
  error: string | null;
  sample: string | null;
  alertedAt: Date | null;
}

async function completeEval(
  row: LogWorkspaceQueryRecord,
  now: number,
  claimToken: string,
  update: EvalCompletion,
): Promise<void> {
  const updated = await db
    .update(logWorkspaceQueries)
    .set({
      nextEvalAt: new Date(now + LOG_WORKSPACE_LIMITS.alertEvalIntervalMs),
      lastEvalAt: new Date(now),
      lastEvalError: update.error,
      ...(update.matched ? { lastMatchAt: new Date(now) } : {}),
      ...(update.sample !== null ? { lastMatchSample: update.sample } : {}),
      ...(update.alertedAt !== null ? { lastAlertedAt: update.alertedAt } : {}),
      updatedAt: new Date(now),
    })
    .where(claimGuard(row.id, claimToken))
    .returning({ id: logWorkspaceQueries.id });
  if (updated.length === 0) {
    console.warn(
      `[log-match] completion for query ${row.id} superseded by a concurrent edit; ` +
        `leaving the edited row's state in place`,
    );
  }
}

/** Deep-link base for notification buttons; null when APP_URL is unset. */
function logWorkspacesUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/logs`;
}

interface StreamMatchResult {
  selector: LogStreamSelector;
  displayName: string;
  matchCount: number;
  truncated: boolean;
  samples: string[];
  error: string | null;
}

/**
 * Display names for the query's resources; missing rows report as gone. A
 * sidecar selector's stream is never a stored row — the anchor is its parent
 * (whose outputs mint the peer client), so the lookup keys on the parent id
 * and the stream name is derived from the peer resource id's tail.
 */
async function loadStreamNames(
  organizationId: string,
  selectors: LogStreamSelector[],
): Promise<Map<string, { displayName: string; deleted: boolean }>> {
  const ids = [...new Set(selectors.map((s) => s.parentResourceId ?? s.resourceId))];
  const rows = await db
    .select({
      id: resources.id,
      displayName: resources.displayName,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, ids)));
  return new Map(
    rows.map((r) => [r.id, { displayName: r.displayName, deleted: r.deletedAt !== null }]),
  );
}

/** Human name for a sidecar stream: `cluster/ns:pod-name`. */
function sidecarStreamName(selector: LogStreamSelector, parentName: string): string {
  const tail = selector.resourceId.split(":").slice(2).join(":") || selector.resourceId;
  return `${parentName}/${tail}`;
}

/**
 * One client per (account, parent) per run: native streams share the account
 * client, sidecar streams share the peer client built through their parent.
 */
type AccountClientCache = Map<string, Awaited<ReturnType<typeof getOrgAccountClient>>>;

function clientCacheKey(selector: LogStreamSelector): string {
  return `${selector.accountId}:${selector.parentResourceId ?? ""}:${selector.parentResourceId ? selector.pluginId : ""}`;
}

async function evaluateStream(
  row: LogWorkspaceQueryRecord,
  selector: LogStreamSelector,
  displayName: string,
  search: ReturnType<typeof compileLogSearch>,
  clients: AccountClientCache,
): Promise<StreamMatchResult> {
  const base: StreamMatchResult = {
    selector,
    displayName,
    matchCount: 0,
    truncated: false,
    samples: [],
    error: null,
  };
  try {
    const cacheKey = clientCacheKey(selector);
    let ctx = clients.get(cacheKey);
    if (!clients.has(cacheKey)) {
      ctx = selector.parentResourceId
        ? await getClientForResource(
            selector.pluginId,
            selector.accountId,
            row.organizationId,
            selector.parentResourceId,
          )
        : await getOrgAccountClient(selector.accountId, row.organizationId);
      clients.set(cacheKey, ctx);
    }
    if (!ctx) {
      return {
        ...base,
        error: selector.parentResourceId
          ? `${displayName}: parent resource no longer exposes a ${selector.pluginId} sidecar`
          : `${displayName}: account not found or its plugin failed to load`,
      };
    }
    if (!ctx.client.getLogs) {
      return { ...base, error: `${displayName}: plugin no longer supports logs` };
    }
    const result = await ctx.client.getLogs(
      selector.resourceTypeId,
      selector.resourceId,
      selector.accountId,
      {
        tailLines: LOG_WORKSPACE_LIMITS.alertTailLines,
        ...(selector.container ? { container: selector.container } : {}),
      },
    );
    const evaluated = evaluateLogMatches(result.text, search, {
      matchCap: LOG_WORKSPACE_LIMITS.alertMatchCap,
    });
    return {
      ...base,
      matchCount: evaluated.matchCount,
      truncated: evaluated.truncated,
      samples: evaluated.samples,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, error: `${displayName}: ${message}` };
  }
}

function formatCount(result: StreamMatchResult): string {
  return `${result.displayName}: ${result.matchCount}${result.truncated ? "+" : ""}`;
}

async function evaluateQuery(
  row: LogWorkspaceQueryRecord,
  now: number,
  claimToken: string,
): Promise<{ matched: boolean; notified: boolean; failed: boolean }> {
  const search = compileLogSearch(row.search);
  if (search.error) {
    await completeEval(row, now, claimToken, {
      matched: false,
      error: search.error,
      sample: null,
      alertedAt: null,
    });
    return { matched: false, notified: false, failed: true };
  }
  if (search.matchAll) {
    // An empty expression matches every line — alerting on it would fire
    // forever. The store rejects this combination; a legacy row degrades to
    // a recorded error instead of a notification storm.
    await completeEval(row, now, claimToken, {
      matched: false,
      error: "Alerting requires a non-empty search expression",
      sample: null,
      alertedAt: null,
    });
    return { matched: false, notified: false, failed: true };
  }

  const names = await loadStreamNames(row.organizationId, row.resources);
  const clients: AccountClientCache = new Map();
  const results: StreamMatchResult[] = [];
  for (const selector of row.resources) {
    const anchorId = selector.parentResourceId ?? selector.resourceId;
    const name = names.get(anchorId);
    if (!name || name.deleted) {
      results.push({
        selector,
        displayName: selector.resourceId,
        matchCount: 0,
        truncated: false,
        samples: [],
        error: selector.parentResourceId
          ? `Parent resource ${anchorId} is no longer synced`
          : `Resource ${anchorId} is no longer synced`,
      });
      continue;
    }
    const displayName = selector.parentResourceId
      ? sidecarStreamName(selector, name.displayName)
      : name.displayName;
    results.push(await evaluateStream(row, selector, displayName, search, clients));
  }

  const errors = results.filter((r) => r.error !== null).map((r) => r.error!);
  const matchedStreams = results.filter((r) => r.matchCount > 0);
  const totalMatches = matchedStreams.reduce((sum, r) => sum + r.matchCount, 0);
  const anyTruncated = matchedStreams.some((r) => r.truncated);
  const lastSample = matchedStreams.flatMap((r) => r.samples).at(-1) ?? null;
  const evalError = errors.length > 0 ? errors.join("; ").slice(0, 1000) : null;

  if (totalMatches === 0) {
    await completeEval(row, now, claimToken, {
      matched: false,
      error: evalError,
      sample: null,
      alertedAt: null,
    });
    return { matched: false, notified: false, failed: errors.length > 0 };
  }

  const inCooldown =
    row.lastAlertedAt !== null &&
    now - row.lastAlertedAt.getTime() < LOG_WORKSPACE_LIMITS.alertCooldownMs;
  let alertedAt: Date | null = null;
  if (!inCooldown) {
    const title = `Log match: ${row.name}`;
    const body =
      `${totalMatches}${anyTruncated ? "+" : ""} matching line${totalMatches === 1 && !anyTruncated ? "" : "s"} ` +
      `for "${row.search}" (${matchedStreams.map(formatCount).join(", ")})` +
      (lastSample ? ` — ${lastSample.slice(0, 200)}` : "");
    const url = logWorkspacesUrl(row.organizationId);
    const context = `Checked the last ${LOG_WORKSPACE_LIMITS.alertTailLines} lines per resource; next alert after the ${Math.round(LOG_WORKSPACE_LIMITS.alertCooldownMs / 60000)}-minute cooldown.`;
    const pushed = await sendPushToOrg(row.organizationId, "logMatchAlerts", {
      title,
      body,
      data: {
        type: "log_match",
        orgId: row.organizationId,
        queryId: row.id,
        matchCount: totalMatches,
      },
    });
    const slacked = await sendSlackToOrg(row.organizationId, "logMatchAlerts", {
      title,
      body,
      context,
      ...(url ? { url } : {}),
    });
    const teamed = await sendMsTeamsToOrg(row.organizationId, "logMatchAlerts", {
      title,
      body,
      context,
      ...(url ? { url } : {}),
    });
    const delivered = pushed.succeeded > 0 || slacked.succeeded > 0 || teamed.succeeded > 0;
    if (delivered) alertedAt = new Date(now);
    console.log(
      `[log-match] query ${row.id} ("${row.name}") matched ${totalMatches} line(s); ` +
        (delivered ? "notified" : "no channel delivered"),
    );
  }

  await completeEval(row, now, claimToken, {
    matched: true,
    error: evalError,
    sample: lastSample,
    alertedAt,
  });
  return { matched: true, notified: alertedAt !== null, failed: errors.length > 0 };
}

/**
 * One log-alert tick: claim due queries and evaluate them. Every query is
 * individually guarded — one failure never blocks the rest of the batch, and
 * nothing here throws into the poller's tick.
 */
export async function runLogAlertPass(
  options: LogAlertPassOptions = {},
): Promise<LogAlertPassResult> {
  const limit = options.limit ?? 4;
  const result: LogAlertPassResult = {
    claimed: 0,
    evaluated: 0,
    matched: 0,
    notified: 0,
    failed: 0,
  };

  const claimed = await claimDueQueries(limit);
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  for (const { id, claimToken } of claimed) {
    const now = options.now ?? Date.now();
    try {
      const rows = await db
        .select()
        .from(logWorkspaceQueries)
        .where(eq(logWorkspaceQueries.id, id))
        .limit(1);
      const row = rows[0] as LogWorkspaceQueryRecord | undefined;
      if (!row || !row.alertEnabled) continue;
      const outcome = await evaluateQuery(row, now, claimToken);
      result.evaluated += 1;
      if (outcome.matched) result.matched += 1;
      if (outcome.notified) result.notified += 1;
      if (outcome.failed) result.failed += 1;
    } catch (e) {
      result.failed += 1;
      console.error(`[log-match] pass failed for query ${id}:`, e);
    }
  }
  return result;
}
