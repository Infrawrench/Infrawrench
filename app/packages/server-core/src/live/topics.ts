/**
 * The live-update topics: what a panel may watch, who may watch it, and the
 * change signal behind it. The client half (and the design) is client-core's
 * `live.ts`; the backend that turns a signal into a ticket is `./backend.ts`.
 *
 * A signal is a read-only, deterministic `SELECT` over our own tables, scoped
 * to the caller's org by a bound parameter (never by string building), whose
 * result moves whenever the panel's data does. It is a signal and not the
 * data: it selects ids, statuses and version counters, never a name, a body
 * or money, because its rows reach the subscriber. The panel refetches
 * through its ordinary API route, which applies every rule that route has
 * (cost visibility, per-row checks), so a signal only has to be as narrow as
 * "this org, and the gate the list route has".
 *
 * Neon Realtime's limits shape the SQL: no `now()` or other volatile
 * functions (so time-based state is the safety refetch's job), and each
 * table needs a stable replica identity (every table here has a primary key).
 *
 * Adding a topic is one name in client-core's `LIVE_TOPICS` and one entry
 * here; the record's type refuses a name without an entry.
 */
import { and, eq } from "drizzle-orm";
import type { LiveTopic, LiveTopicParams } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";

/** A parameterised SQL statement; `$1` is always the organization id. */
export interface LiveSignal {
  readonly sql: string;
  readonly params: readonly string[];
}

type ParamName = keyof LiveTopicParams;

export interface LiveTopicDefinition {
  /** The permission the topic's list route requires. */
  readonly permission: string;
  /** Params the topic cannot do without. */
  readonly requires: readonly ParamName[];
  /**
   * Confirm the ids the caller named belong to their org, before anything is
   * sealed. The SQL is org-scoped as well, so this only turns a foreign id
   * into a 404 rather than a subscription that never moves.
   */
  readonly authorize?: (organizationId: string, params: LiveTopicParams) => Promise<boolean>;
  readonly signal: (organizationId: string, params: LiveTopicParams) => LiveSignal;
}

const accountInOrg = async (organizationId: string, { accountId }: LiveTopicParams) => {
  if (!accountId) return false;
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  return row !== undefined;
};

const resourceInOrg = async (organizationId: string, { resourceId }: LiveTopicParams) => {
  if (!resourceId) return false;
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
    .limit(1);
  return row !== undefined;
};

export const LIVE_TOPIC_DEFINITIONS: Readonly<Record<LiveTopic, LiveTopicDefinition>> = {
  // The JIT queue and the grants still running. A request leaving these
  // states (decided, timed out by the sweep, ended) leaves the result.
  "jit-requests": {
    permission: "access:read",
    requires: [],
    signal: (org) => ({
      sql:
        "SELECT id, status, grant_expires_at, extended_minutes FROM jit_access_requests " +
        "WHERE organization_id = $1 AND status IN ('pending', 'granting', 'active', 'revoking')",
      params: [org],
    }),
  },
  // Break-glass requests waiting on a decision and grants not yet revoked.
  // A grant that lapses is computed at read time; the safety refetch covers it.
  "access-requests": {
    permission: "access:read",
    requires: [],
    signal: (org) => ({
      sql:
        "SELECT id, status FROM access_requests WHERE organization_id = $1 " +
        "AND (status = 'pending' OR (status = 'approved' AND revoked_at IS NULL))",
      params: [org],
    }),
  },
  "workflow-approvals": {
    permission: "workflows:read",
    requires: [],
    signal: (org, { workflowId }) =>
      workflowId
        ? {
            sql:
              "SELECT id, status FROM workflow_approvals " +
              "WHERE organization_id = $1 AND workflow_id = $2 AND status = 'pending'",
            params: [org, workflowId],
          }
        : {
            sql:
              "SELECT id, status FROM workflow_approvals " +
              "WHERE organization_id = $1 AND status = 'pending'",
            params: [org],
          },
  },
  // A scheduled freeze starting on its own is not a write; the banner's safety
  // refetch picks that up.
  "change-freezes": {
    permission: "freezes:read",
    requires: [],
    signal: (org) => ({
      sql:
        "SELECT id, starts_at, ends_at, updated_at FROM change_freezes " +
        "WHERE organization_id = $1 AND active",
      params: [org],
    }),
  },
  // One row for the whole account: every sync gives the rows it writes a new
  // org-wide `sync_version`, and a removal changes the count.
  "account-resources": {
    permission: "resources:read",
    requires: ["accountId"],
    authorize: accountInOrg,
    signal: (org, { accountId }) => ({
      sql:
        "SELECT count(*) AS n, max(sync_version) AS v FROM resources " +
        "WHERE organization_id = $1 AND account_id = $2 AND deleted_at IS NULL",
      params: [org, accountId!],
    }),
  },
  resource: {
    permission: "resources:read",
    requires: ["resourceId"],
    authorize: resourceInOrg,
    signal: (org, { resourceId }) => ({
      sql:
        "SELECT sync_version, deleted_at FROM resources " +
        "WHERE organization_id = $1 AND id = $2",
      params: [org, resourceId!],
    }),
  },
  // The runs list: the newest fifty, by status. The poller rewrites a running
  // row every second (`next_attempt_at`), which this deliberately does not select.
  "ci-runs": {
    permission: "ci:read",
    requires: [],
    signal: (org) => ({
      sql:
        "SELECT id, status FROM ci_runs WHERE organization_id = $1 " +
        "ORDER BY created_at DESC LIMIT 50",
      params: [org],
    }),
  },
};

export function liveTopicDefinition(topic: string): LiveTopicDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(LIVE_TOPIC_DEFINITIONS, topic)
    ? LIVE_TOPIC_DEFINITIONS[topic as LiveTopic]
    : undefined;
}
