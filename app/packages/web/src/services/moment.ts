/**
 * The moment view union — "what changed around 03:14?".
 *
 * Read-only merge of every feed the platform already indexes into one
 * chronological window: resource changes, provider status incidents, cost
 * anomalies, workflow runs, deployments, audit entries, change freezes, and
 * the drift/expiry alert delivery claims. No new tables, no new writes —
 * each loader reuses the same table + permission the feed's own endpoint
 * reads.
 *
 * Two properties the route, the MCP tool and the tests all rely on:
 *
 * - **Permission-respecting.** Each feed is gated on the exact permission its
 *   own endpoint requires; feeds the caller can't read are `omitted` (never
 *   errored, never leaked).
 * - **Partial-failure tolerant.** One feed's query throwing marks that feed
 *   `error` and the rest of the response still comes back — the screen shows
 *   "workflow runs unavailable" instead of blanking.
 *
 * Wire contract lives in `@infrawrench/client-core` (`moment.ts`) so web,
 * desktop, mobile and the CLI cannot drift from the server.
 */
import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import {
  clampMomentWindow,
  compareMomentEvents,
  momentWindowBounds,
  MOMENT_FEED_IDS,
  type MomentEvent,
  type MomentFeedId,
  type MomentFeedStatus,
  type MomentIncidentSpan,
  type MomentResponse,
  type MomentSeverity,
} from "@infrawrench/client-core";
import { summarizeChange } from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { getOrgStatusIncidents } from "@infrawrench/server-core/status/match";
import { getDriftAlertSettings } from "@infrawrench/server-core/drift/settings";
import { getExpirySettings } from "@infrawrench/server-core/expiry/settings";
import { db } from "../db/client";
import {
  accounts,
  auditLogs,
  changeFreezes,
  costAnomalies,
  deploymentRuns,
  resourceChanges,
  users,
  workflowRuns,
  workflows,
} from "../db/schema";

/**
 * The permission each feed's own endpoint enforces. Drift/expiry alert
 * delivery timestamps are gated at `resources:read` like the feeds whose
 * content they summarize (`/changes`, `/expiring`) — `org:settings:write`
 * only guards *editing* the alert settings.
 */
export const MOMENT_FEED_PERMISSIONS: Record<MomentFeedId, string> = {
  changes: "resources:read",
  statusIncidents: "resources:read",
  costAnomalies: "costs:read",
  workflowRuns: "workflows:read",
  deployments: "deployments:read",
  audit: "audit:read",
  freezes: "freezes:read",
  driftAlerts: "resources:read",
  expiryAlerts: "resources:read",
};

/** Per-feed row cap — enough for any sane window, small enough to stay cheap. */
const FEED_ROW_CAP = 300;

export interface MomentQuery {
  /** Centre of the window; defaults to "around now". */
  at?: Date | undefined;
  /** Half-window in minutes; clamped to `MOMENT_WINDOW_LIMITS`. */
  windowMinutes?: number | undefined;
  /** The caller's effective permission grants — decides which feeds load. */
  permissions: readonly string[];
}

interface FeedResult {
  events: MomentEvent[];
  truncated?: boolean;
}

type FeedLoader = (organizationId: string, from: Date, to: Date) => Promise<FeedResult>;

export async function computeMoment(
  organizationId: string,
  query: MomentQuery,
): Promise<MomentResponse> {
  const at = query.at ?? new Date();
  if (Number.isNaN(at.getTime())) throw new Error("Invalid moment timestamp");
  const windowMinutes = clampMomentWindow(query.windowMinutes);
  const { from, to } = momentWindowBounds(at, windowMinutes);

  // Incidents are loaded once and reused for the feed events *and* the
  // overlap spans, so a failure there degrades both consistently.
  let incidentSpans: MomentIncidentSpan[] = [];
  let incidentError: string | null = null;
  const incidentsAllowed = hasPermission(
    query.permissions,
    MOMENT_FEED_PERMISSIONS.statusIncidents,
  );
  if (incidentsAllowed) {
    try {
      incidentSpans = await loadIncidentSpans(organizationId, from, to);
    } catch (error) {
      incidentError = describeError(error, "statusIncidents");
    }
  }

  const loaders: Record<MomentFeedId, FeedLoader> = {
    changes: loadChanges,
    statusIncidents: async () => incidentEvents(incidentSpans, from, to),
    costAnomalies: loadCostAnomalies,
    workflowRuns: loadWorkflowRuns,
    deployments: loadDeployments,
    audit: loadAudit,
    freezes: loadFreezes,
    driftAlerts: loadDriftAlert,
    expiryAlerts: loadExpiryAlert,
  };

  const feeds: MomentFeedStatus[] = [];
  const events: MomentEvent[] = [];

  await Promise.all(
    MOMENT_FEED_IDS.map(async (feed) => {
      if (!hasPermission(query.permissions, MOMENT_FEED_PERMISSIONS[feed])) {
        feeds.push({ feed, status: "omitted" });
        return;
      }
      if (feed === "statusIncidents" && incidentError !== null) {
        feeds.push({ feed, status: "error", error: incidentError });
        return;
      }
      try {
        const result = await loaders[feed](organizationId, from, to);
        events.push(...result.events);
        feeds.push({ feed, status: "ok", ...(result.truncated ? { truncated: true } : {}) });
      } catch (error) {
        feeds.push({ feed, status: "error", error: describeError(error, feed) });
      }
    }),
  );

  // Report feeds in canonical order regardless of async completion order.
  feeds.sort((a, b) => MOMENT_FEED_IDS.indexOf(a.feed) - MOMENT_FEED_IDS.indexOf(b.feed));
  events.sort(compareMomentEvents);

  return {
    at: at.toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    windowMinutes,
    generatedAt: new Date().toISOString(),
    feeds,
    events,
    incidents: incidentSpans,
  };
}

/**
 * Log the real failure server-side and hand the client an opaque reason —
 * driver/internal error text (hosts, table names, SQL) must not reach API
 * clients through `MomentFeedStatus.error`.
 */
function describeError(error: unknown, feed: MomentFeedId): string {
  console.error(`[moment] feed "${feed}" failed to load:`, error);
  return "Feed unavailable";
}

/**
 * Parse a caller-supplied `at` timestamp deterministically: an offset-less
 * ISO date-time (e.g. "2026-08-03T03:14:00") is interpreted as UTC rather
 * than the server's local zone, so the same request means the same window
 * regardless of where the server runs. Returns null when unparseable.
 */
export function parseMomentTimestamp(raw: string): Date | null {
  // ISO date-time with a time part but no zone designator (no trailing Z or
  // ±hh[:mm]) — pin it to UTC.
  const offsetless = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw.trim());
  const at = new Date(offsetless ? `${raw.trim()}Z` : raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

function within(value: Date | null, from: Date, to: Date): value is Date {
  return value !== null && value >= from && value <= to;
}

/* ------------------------------------------------------------------ *
 * Feed loaders — one per feed, mirroring the feed's own endpoint query
 * ------------------------------------------------------------------ */

/** `resource_changes` in the window — same query shape as `GET /changes`. */
const loadChanges: FeedLoader = async (organizationId, from, to) => {
  const rows = await db
    .select({
      id: resourceChanges.id,
      resourceId: resourceChanges.resourceId,
      accountId: resourceChanges.accountId,
      pluginId: resourceChanges.pluginId,
      resourceTypeId: resourceChanges.resourceTypeId,
      displayName: resourceChanges.displayName,
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
      origin: resourceChanges.origin,
      createdAt: resourceChanges.createdAt,
      accountName: accounts.displayName,
    })
    .from(resourceChanges)
    .leftJoin(accounts, eq(resourceChanges.accountId, accounts.id))
    .where(
      and(
        eq(resourceChanges.organizationId, organizationId),
        gte(resourceChanges.createdAt, from),
        lte(resourceChanges.createdAt, to),
      ),
    )
    // Newest-first so the row cap drops the *oldest* rows, matching the
    // `truncated` contract. Global event order is restored by the final sort.
    .orderBy(desc(resourceChanges.createdAt))
    .limit(FEED_ROW_CAP + 1);

  const truncated = rows.length > FEED_ROW_CAP;
  const events = rows.slice(0, FEED_ROW_CAP).map((row): MomentEvent => {
    const verb =
      row.changeKind === "created"
        ? "appeared"
        : row.changeKind === "deleted"
          ? "disappeared"
          : "changed";
    const summary = summarizeChange({
      changeKind: row.changeKind,
      diff: Array.isArray(row.diff) ? row.diff : [],
    });
    return {
      id: `changes:${row.id}`,
      feed: "changes",
      kind: `change.${row.changeKind}`,
      timestamp: row.createdAt.toISOString(),
      title: `${row.displayName} ${verb}`,
      detail:
        row.changeKind === "updated"
          ? row.origin === "schedule"
            ? `${summary} — via sleep/wake schedule`
            : summary
          : row.origin === "schedule"
            ? "via sleep/wake schedule"
            : null,
      severity: row.changeKind === "deleted" ? "warning" : "info",
      pluginId: row.pluginId,
      accountId: row.accountId,
      accountName: row.accountName,
      resourceId: row.resourceId,
      resourceTypeId: row.resourceTypeId,
      resourceName: row.displayName,
      link: { kind: "resource", id: row.resourceId },
    };
  });
  return { events, ...(truncated ? { truncated: true } : {}) };
};

/**
 * Incidents overlapping the window, via the same correlated reader the
 * status endpoint uses (`getOrgStatusIncidents`) so region/type matching and
 * plugin display names stay in one place. `resolvedWithinMs` is widened to
 * reach back to the window start; incidents that began after the window ends
 * are filtered out here.
 */
async function loadIncidentSpans(
  organizationId: string,
  from: Date,
  to: Date,
): Promise<MomentIncidentSpan[]> {
  const resolvedWithinMs = Math.max(Date.now() - from.getTime(), 0) + 60_000;
  const incidents = await getOrgStatusIncidents(organizationId, { resolvedWithinMs });
  return incidents
    .filter((incident) => {
      const started = Date.parse(incident.startedAt);
      if (Number.isNaN(started) || started > to.getTime()) return false;
      if (!incident.resolvedAt) return true;
      const resolved = Date.parse(incident.resolvedAt);
      return Number.isNaN(resolved) || resolved >= from.getTime();
    })
    .map((incident) => ({
      id: incident.id,
      pluginId: incident.pluginId,
      pluginName: incident.pluginName,
      title: incident.title,
      impact: incident.impact,
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt ?? null,
      url: incident.url ?? null,
    }));
}

const INCIDENT_SEVERITY: Record<string, MomentSeverity> = {
  critical: "critical",
  major: "warning",
  minor: "info",
  maintenance: "info",
};

/** Started/resolved edges of overlapping incidents that fall in the window. */
function incidentEvents(spans: MomentIncidentSpan[], from: Date, to: Date): FeedResult {
  const events: MomentEvent[] = [];
  for (const span of spans) {
    const started = new Date(span.startedAt);
    const resolved = span.resolvedAt ? new Date(span.resolvedAt) : null;
    const link = { kind: "incident" as const, id: span.id, url: span.url ?? null };
    if (within(started, from, to)) {
      events.push({
        id: `statusIncidents:${span.id}:started`,
        feed: "statusIncidents",
        kind: "incident.started",
        timestamp: started.toISOString(),
        title: `${span.pluginName} incident started: ${span.title}`,
        detail: span.impact === "maintenance" ? "Scheduled maintenance" : `Impact: ${span.impact}`,
        severity: INCIDENT_SEVERITY[span.impact] ?? "warning",
        pluginId: span.pluginId,
        link,
      });
    }
    if (resolved !== null && within(resolved, from, to)) {
      events.push({
        id: `statusIncidents:${span.id}:resolved`,
        feed: "statusIncidents",
        kind: "incident.resolved",
        timestamp: resolved.toISOString(),
        title: `${span.pluginName} incident resolved: ${span.title}`,
        detail: null,
        severity: "info",
        pluginId: span.pluginId,
        link,
      });
    }
  }
  return { events };
}

/** `cost_anomalies` by detection time — same table as `GET /costs/anomalies`. */
const loadCostAnomalies: FeedLoader = async (organizationId, from, to) => {
  const rows = await db
    .select()
    .from(costAnomalies)
    .where(
      and(
        eq(costAnomalies.organizationId, organizationId),
        gte(costAnomalies.detectedAt, from),
        lte(costAnomalies.detectedAt, to),
      ),
    )
    .orderBy(desc(costAnomalies.detectedAt))
    .limit(FEED_ROW_CAP + 1);

  const truncated = rows.length > FEED_ROW_CAP;
  const events = rows.slice(0, FEED_ROW_CAP).map((row): MomentEvent => {
    const actual = formatCents(row.actualAmountCents, row.currency);
    const baseline = formatCents(row.baselineAmountCents, row.currency);
    return {
      id: `costAnomalies:${row.id}`,
      feed: "costAnomalies",
      kind: `anomaly.${row.kind}`,
      timestamp: row.detectedAt.toISOString(),
      title:
        row.kind === "new_source"
          ? `New spend source detected: ${row.dimensionKey}`
          : `Cost spike detected: ${row.dimensionKey}`,
      detail: `${actual} on ${row.day} vs ${baseline} baseline (by ${row.dimension})`,
      severity: "warning",
      link: { kind: "costs" },
    };
  });
  return { events, ...(truncated ? { truncated: true } : {}) };
};

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** `workflow_runs` whose start or finish falls in the window. */
const loadWorkflowRuns: FeedLoader = async (organizationId, from, to) => {
  const rows = await db
    .select({
      id: workflowRuns.id,
      workflowId: workflowRuns.workflowId,
      status: workflowRuns.status,
      triggerSource: workflowRuns.triggerSource,
      startedAt: workflowRuns.startedAt,
      finishedAt: workflowRuns.finishedAt,
      workflowName: workflows.name,
    })
    .from(workflowRuns)
    .leftJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
    .where(
      and(
        eq(workflowRuns.organizationId, organizationId),
        or(
          and(gte(workflowRuns.startedAt, from), lte(workflowRuns.startedAt, to)),
          and(gte(workflowRuns.finishedAt, from), lte(workflowRuns.finishedAt, to)),
        ),
      ),
    )
    .orderBy(desc(workflowRuns.createdAt))
    .limit(FEED_ROW_CAP + 1);

  const truncated = rows.length > FEED_ROW_CAP;
  const events: MomentEvent[] = [];
  for (const row of rows.slice(0, FEED_ROW_CAP)) {
    const name = row.workflowName ?? "(deleted workflow)";
    const link = { kind: "workflow-run" as const, id: row.id, parentId: row.workflowId };
    if (within(row.startedAt, from, to)) {
      events.push({
        id: `workflowRuns:${row.id}:started`,
        feed: "workflowRuns",
        kind: "workflow-run.started",
        timestamp: row.startedAt.toISOString(),
        title: `Workflow "${name}" started`,
        detail: `Trigger: ${row.triggerSource}`,
        severity: "info",
        link,
      });
    }
    if (within(row.finishedAt, from, to) && row.status !== "running" && row.status !== "pending") {
      const outcome =
        row.status === "success" ? "succeeded" : row.status === "canceled" ? "canceled" : "failed";
      events.push({
        id: `workflowRuns:${row.id}:finished`,
        feed: "workflowRuns",
        kind: `workflow-run.${outcome}`,
        timestamp: row.finishedAt.toISOString(),
        title: `Workflow "${name}" ${outcome === "canceled" ? "was canceled" : outcome}`,
        detail: null,
        severity: outcome === "failed" ? "critical" : "info",
        link,
      });
    }
  }
  return { events, ...(truncated ? { truncated: true } : {}) };
};

/** `deployment_runs` whose start or finish falls in the window. */
const loadDeployments: FeedLoader = async (organizationId, from, to) => {
  const rows = await db
    .select({
      id: deploymentRuns.id,
      env: deploymentRuns.env,
      repo: deploymentRuns.repo,
      gitSha: deploymentRuns.gitSha,
      status: deploymentRuns.status,
      origin: deploymentRuns.origin,
      startedAt: deploymentRuns.startedAt,
      finishedAt: deploymentRuns.finishedAt,
    })
    .from(deploymentRuns)
    .where(
      and(
        eq(deploymentRuns.organizationId, organizationId),
        or(
          and(gte(deploymentRuns.startedAt, from), lte(deploymentRuns.startedAt, to)),
          and(gte(deploymentRuns.finishedAt, from), lte(deploymentRuns.finishedAt, to)),
        ),
      ),
    )
    .orderBy(desc(deploymentRuns.startedAt))
    .limit(FEED_ROW_CAP + 1);

  const truncated = rows.length > FEED_ROW_CAP;
  const events: MomentEvent[] = [];
  for (const row of rows.slice(0, FEED_ROW_CAP)) {
    const what = `${row.repo}${row.gitSha ? `@${row.gitSha.slice(0, 7)}` : ""} → ${row.env}`;
    const link = { kind: "deployment" as const, id: row.id };
    if (within(row.startedAt, from, to)) {
      events.push({
        id: `deployments:${row.id}:started`,
        feed: "deployments",
        kind: "deployment.started",
        timestamp: row.startedAt.toISOString(),
        title: `Deploy started: ${what}`,
        detail: `Origin: ${row.origin}`,
        severity: "info",
        link,
      });
    }
    if (within(row.finishedAt, from, to) && row.status !== "running" && row.status !== "pending") {
      const failed = row.status === "failure";
      events.push({
        id: `deployments:${row.id}:finished`,
        feed: "deployments",
        kind: failed ? "deployment.failed" : "deployment.finished",
        timestamp: row.finishedAt.toISOString(),
        title: failed
          ? `Deploy failed: ${what}`
          : row.status === "canceled"
            ? `Deploy canceled: ${what}`
            : `Deploy succeeded: ${what}`,
        detail: null,
        severity: failed ? "critical" : "info",
        link,
      });
    }
  }
  return { events, ...(truncated ? { truncated: true } : {}) };
};

/** `audit_logs` in the window — same query shape as `GET /audit-logs`. */
const loadAudit: FeedLoader = async (organizationId, from, to) => {
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
      userName: users.displayName,
      userEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        gte(auditLogs.createdAt, from),
        lte(auditLogs.createdAt, to),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(FEED_ROW_CAP + 1);

  const truncated = rows.length > FEED_ROW_CAP;
  const events = rows.slice(0, FEED_ROW_CAP).map((row): MomentEvent => {
    const actor = row.userName ?? row.userEmail ?? "API key";
    const destructive = row.action.endsWith(".delete") || row.action.endsWith(".end");
    return {
      id: `audit:${row.id}`,
      feed: "audit",
      kind: `audit.${row.action}`,
      timestamp: row.createdAt.toISOString(),
      title: humanizeAuditAction(row.action),
      detail: `${actor}${row.entityId ? ` — ${row.entityType} ${row.entityId}` : ""}`,
      severity: destructive ? "warning" : "info",
      link: { kind: "audit" },
    };
  });
  return { events, ...(truncated ? { truncated: true } : {}) };
};

/** `"change_freeze.create"` → `"Change freeze created"`. */
function humanizeAuditAction(action: string): string {
  const [entity, verb] = action.split(".");
  if (!entity || !verb) return action;
  const entityLabel = entity.replace(/[_-]/g, " ");
  const verbLabel =
    verb === "create"
      ? "created"
      : verb === "update"
        ? "updated"
        : verb === "delete"
          ? "deleted"
          : verb === "end"
            ? "ended"
            : verb;
  return `${entityLabel.charAt(0).toUpperCase()}${entityLabel.slice(1)} ${verbLabel}`;
}

/** `change_freezes` that started or ended inside the window. */
const loadFreezes: FeedLoader = async (organizationId, from, to) => {
  const rows = await db
    .select()
    .from(changeFreezes)
    .where(
      and(
        eq(changeFreezes.organizationId, organizationId),
        or(
          and(gte(changeFreezes.startsAt, from), lte(changeFreezes.startsAt, to)),
          and(gte(changeFreezes.endsAt, from), lte(changeFreezes.endsAt, to)),
        ),
      ),
    )
    .orderBy(desc(changeFreezes.startsAt))
    .limit(FEED_ROW_CAP + 1);

  const truncated = rows.length > FEED_ROW_CAP;
  const events: MomentEvent[] = [];
  for (const row of rows.slice(0, FEED_ROW_CAP)) {
    const link = { kind: "freeze" as const, id: row.id };
    if (within(row.startsAt, from, to)) {
      events.push({
        id: `freezes:${row.id}:started`,
        feed: "freezes",
        kind: "freeze.started",
        timestamp: row.startsAt.toISOString(),
        title: `Change freeze started: ${row.name}`,
        detail: row.reason,
        severity: "info",
        link,
      });
    }
    if (within(row.endsAt, from, to)) {
      events.push({
        id: `freezes:${row.id}:ended`,
        feed: "freezes",
        kind: "freeze.ended",
        timestamp: row.endsAt.toISOString(),
        title: `Change freeze ended: ${row.name}`,
        detail: row.active ? null : "Ended early",
        severity: "info",
        link,
      });
    }
  }
  return { events, ...(truncated ? { truncated: true } : {}) };
};

/**
 * Drift alerts keep no per-event history — only the per-org cooldown claim
 * (`org_drift_alert_settings.last_notified_at`), so the feed contributes at
 * most one "a drift digest was delivered" event per window.
 */
const loadDriftAlert: FeedLoader = async (organizationId, from, to) => {
  const settings = await getDriftAlertSettings(organizationId);
  const notifiedAt = settings.lastNotifiedAt;
  if (!within(notifiedAt, from, to)) return { events: [] };
  return {
    events: [
      {
        id: `driftAlerts:${organizationId}:${notifiedAt.getTime()}`,
        feed: "driftAlerts",
        kind: "drift-alert.sent",
        timestamp: notifiedAt.toISOString(),
        title: "Drift alert delivered",
        detail: "The org's most recent drift digest — see the change timeline for its contents",
        severity: "info",
        link: { kind: "changes" },
      },
    ],
  };
};

/** Same single-claim shape for expiry alerts (`org_expiry_settings`). */
const loadExpiryAlert: FeedLoader = async (organizationId, from, to) => {
  const settings = await getExpirySettings(organizationId);
  const notifiedAt = settings.lastNotifiedAt;
  if (!within(notifiedAt, from, to)) return { events: [] };
  return {
    events: [
      {
        id: `expiryAlerts:${organizationId}:${notifiedAt.getTime()}`,
        feed: "expiryAlerts",
        kind: "expiry-alert.sent",
        timestamp: notifiedAt.toISOString(),
        title: "Expiry alert delivered",
        detail: "The org's most recent expiry scan notified — see Expiring for current deadlines",
        severity: "info",
        link: { kind: "expiring" },
      },
    ],
  };
};
