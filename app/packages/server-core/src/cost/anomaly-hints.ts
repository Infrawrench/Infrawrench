/**
 * Root-cause hints for cost anomalies — "spend went up *because of this*".
 *
 * When the evaluator (`anomaly-eval.ts`) flags a day, it already knows the
 * window, the org, and (for the provider dimension) which plugin the spend
 * belongs to. This module turns that into a small ranked list of
 * human-readable facts pulled from what the platform already indexes:
 *
 * - the change timeline (`resource_changes`) — "12 gce-instance resources
 *   appeared";
 * - the audit log (`audit_logs`) — "Astrid ran workflow \"Nightly rebuild\"",
 *   "a change freeze was lifted".
 *
 * The split mirrors `anomaly-detect.ts` / `anomaly-eval.ts`: the ranking and
 * phrasing (`composeAnomalyHints`) are pure and unit-tested without a
 * database; `buildAnomalyHints` is the thin I/O wrapper that runs the two
 * window queries and never throws — hints are garnish on an alert that must
 * go out either way, so any failure here degrades to "no hints".
 *
 * Both queries are cheap by construction: they range-scan the existing
 * `(organization_id, created_at)` indexes (`resource_changes_org_created_idx`,
 * `audit_logs_org_created_idx`) over a two-day window. No schema changes are
 * needed for the reads; the computed hints are stored on the anomaly row
 * (`cost_anomalies.hints`) so the list UI can render them without re-querying.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/client";
import { auditLogs, resourceChanges, users, workflows } from "../db/schema";

/** Hints kept per anomaly, however much happened in the window. */
export const MAX_ANOMALY_HINTS = 3;

/** Audit rows read per window — plenty for ranking, bounded for safety. */
const AUDIT_ROW_CAP = 200;

/** The slice of an anomaly the hint queries need. */
export interface AnomalyHintTarget {
  /** The anomalous day, "YYYY-MM-DD" (UTC). */
  day: string;
  dimension: "provider" | "service";
  /** A plugin id (provider dimension) or a service name (service dimension). */
  dimensionKey: string;
}

/**
 * The window a hint may come from: the anomalous day plus the whole day
 * before it, in UTC. Spend billed on a day is caused by things that happened
 * on that day or shortly before — a fleet created at 23:50 shows up on the
 * next day's bill. Wider than two days and the hints start explaining the
 * baseline rather than the spike.
 */
export function anomalyHintWindow(day: string): { from: Date; to: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return {
    from: new Date(start.getTime() - 24 * 60 * 60 * 1000),
    to: new Date(start.getTime() + 24 * 60 * 60 * 1000),
  };
}

/** One aggregated change-timeline bucket: N events of one kind for one type. */
export interface ChangeAggregate {
  changeKind: "created" | "updated" | "deleted";
  resourceTypeId: string;
  count: number;
}

/** One audit-log row, flattened to what phrasing needs. */
export interface AuditHintEntry {
  action: string;
  /** Display name (or email) of the acting user; null for API-key actors. */
  actorName: string | null;
  /**
   * A human name for the entity where one is resolvable — the workflow's
   * name for `workflow.run`, the freeze's name for `change_freeze.*`.
   */
  entityName: string | null;
}

/**
 * The audit actions worth turning into hints, i.e. the ones that plausibly
 * *cause* spend. Reads (`account.credentials.read`), preference edits and the
 * like are noise here no matter who did them.
 */
export const HINT_AUDIT_ACTIONS = [
  "workflow.run",
  "change_freeze.end",
  "change_freeze.delete",
  "change_freeze.override",
  "deployment.plan",
  "deployment.rollback",
  "resource.create",
  "resource.apply_manifest",
  "resource.attach",
  "resource.invoke_action",
  "resource_schedule.create",
  "resource_schedule.update",
  "resource_schedule.delete",
  "sync.push",
] as const;

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

interface ScoredHint {
  score: number;
  text: string;
}

/**
 * Phrase one change-timeline aggregate. Creations rank highest — new
 * resources are the single most direct way spend appears — then deletions
 * (context for a spike elsewhere, the cause of a final-hours billing burst),
 * then updates. Within a kind, bigger buckets outrank smaller.
 */
function changeHint(row: ChangeAggregate): ScoredHint | null {
  if (!(row.count > 0)) return null;
  const n = row.count;
  switch (row.changeKind) {
    case "created":
      return {
        score: 400 + n,
        text:
          n === 1
            ? `a ${row.resourceTypeId} resource appeared`
            : `${n} ${row.resourceTypeId} resources appeared`,
      };
    case "deleted":
      return {
        score: 250 + n,
        text:
          n === 1
            ? `a ${row.resourceTypeId} resource was removed`
            : `${n} ${row.resourceTypeId} resources were removed`,
      };
    case "updated":
      return {
        score: 100 + n,
        text:
          n === 1
            ? `a ${row.resourceTypeId} resource changed`
            : `${n} ${row.resourceTypeId} resources changed`,
      };
    default:
      return null;
  }
}

/** The actor as a hint names them. Audit rows without a user are API-key writes. */
function actorLabel(actorName: string | null): string {
  return actorName ?? "an API key";
}

/**
 * Phrase one *group* of identical audit entries (same action, actor and
 * entity), `count` strong. Returns null for actions the map doesn't cover —
 * callers pre-filter on {@link HINT_AUDIT_ACTIONS}, so that is only a new
 * action added to the list without a phrase here.
 */
function auditHint(entry: AuditHintEntry, count: number): ScoredHint | null {
  const actor = actorLabel(entry.actorName);
  const times = count > 1 ? ` ${count} times` : "";
  switch (entry.action) {
    case "change_freeze.end":
      return {
        score: 380,
        text: `${actor} lifted ${entry.entityName ? `change freeze "${entry.entityName}"` : "a change freeze"} early`,
      };
    case "change_freeze.delete":
      return {
        score: 380,
        text: `${actor} deleted ${entry.entityName ? `change freeze "${entry.entityName}"` : "a change freeze"}`,
      };
    case "change_freeze.override":
      return { score: 370, text: `${actor} overrode a change freeze` };
    case "workflow.run":
      return {
        score: 350 + count,
        text: `${actor} ran ${entry.entityName ? `workflow "${entry.entityName}"` : "a workflow"}${times}`,
      };
    case "deployment.plan":
      return {
        score: 300 + count,
        text: `${actor} ran ${count === 1 ? "a deployment" : `${count} deployments`}`,
      };
    case "deployment.rollback":
      return { score: 300 + count, text: `${actor} rolled back a deployment` };
    case "resource.create":
      return {
        score: 200 + count,
        text: `${actor} created ${count === 1 ? "a resource" : `${count} resources`} from Infrawrench`,
      };
    case "resource.apply_manifest":
      return { score: 200 + count, text: `${actor} applied ${count} ${plural(count, "manifest")}` };
    case "resource.attach":
      return {
        score: 180 + count,
        text: `${actor} attached ${count} ${plural(count, "resource")}`,
      };
    case "resource.invoke_action":
      return {
        score: 170 + count,
        text: `${actor} invoked ${count} resource ${plural(count, "action")}`,
      };
    case "resource_schedule.create":
    case "resource_schedule.update":
    case "resource_schedule.delete":
      return { score: 150 + count, text: `${actor} changed a sleep/wake schedule` };
    case "sync.push":
      return { score: 120 + count, text: `${actor} pushed a desktop state sync` };
    default:
      return null;
  }
}

/**
 * Rank and phrase the window's evidence into at most {@link MAX_ANOMALY_HINTS}
 * hints. Pure — the inputs are whatever the two queries (or a test) supply.
 *
 * Audit entries arrive one row per event and are grouped here by
 * (action, actor, entity) so ten identical workflow runs read as one hint
 * with a count, not ten hints crowding everything else out. Schedule actions
 * collapse to one phrase per actor on purpose — create/update/delete of a
 * sleep/wake schedule are the same fact for this audience.
 */
export function composeAnomalyHints(
  changes: readonly ChangeAggregate[],
  audit: readonly AuditHintEntry[],
): string[] {
  const candidates: ScoredHint[] = [];

  for (const row of changes) {
    const hint = changeHint(row);
    if (hint) candidates.push(hint);
  }

  const groups = new Map<string, { entry: AuditHintEntry; count: number }>();
  for (const entry of audit) {
    // Schedule verbs collapse into one phrase, so group them under one key.
    const action = entry.action.startsWith("resource_schedule.")
      ? "resource_schedule"
      : entry.action;
    const key = `${action} ${entry.actorName ?? ""} ${entry.entityName ?? ""}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { entry, count: 1 });
  }
  for (const { entry, count } of groups.values()) {
    const hint = auditHint(entry, count);
    if (hint) candidates.push(hint);
  }

  candidates.sort((a, b) => b.score - a.score);

  const out: string[] = [];
  for (const { text } of candidates) {
    if (!out.includes(text)) out.push(text);
    if (out.length >= MAX_ANOMALY_HINTS) break;
  }
  return out;
}

/** `metadata.name`, when the audit writer stored one (change freezes do). */
function metadataName(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const name = (metadata as Record<string, unknown>)["name"];
    if (typeof name === "string" && name.length > 0) return name;
  }
  return null;
}

/**
 * Query the change timeline and the audit log for the anomaly's window and
 * compose the hints. Scoped to the org; for the provider dimension the change
 * timeline is additionally filtered to that plugin's resources — a GCP spike
 * should not be "explained" by a Cloudflare worker appearing. Service names
 * cannot be mapped to a plugin generically, so the service dimension reads
 * org-wide.
 *
 * Never throws, and never returns more than {@link MAX_ANOMALY_HINTS}
 * entries. A failure logs and returns `[]`: hints annotate an alert that must
 * be delivered regardless.
 */
export async function buildAnomalyHints(
  organizationId: string,
  target: AnomalyHintTarget,
): Promise<string[]> {
  try {
    const { from, to } = anomalyHintWindow(target.day);

    const changeWhere = [
      eq(resourceChanges.organizationId, organizationId),
      gte(resourceChanges.createdAt, from),
      lt(resourceChanges.createdAt, to),
    ];
    if (target.dimension === "provider") {
      changeWhere.push(eq(resourceChanges.pluginId, target.dimensionKey));
    }
    const changeRows = await db
      .select({
        changeKind: resourceChanges.changeKind,
        resourceTypeId: resourceChanges.resourceTypeId,
        count: sql<number>`count(*)`,
      })
      .from(resourceChanges)
      .where(and(...changeWhere))
      .groupBy(resourceChanges.changeKind, resourceChanges.resourceTypeId);

    const auditRows = await db
      .select({
        action: auditLogs.action,
        entityId: auditLogs.entityId,
        metadata: auditLogs.metadata,
        actorName: users.displayName,
        actorEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          gte(auditLogs.createdAt, from),
          lt(auditLogs.createdAt, to),
          inArray(auditLogs.action, [...HINT_AUDIT_ACTIONS]),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(AUDIT_ROW_CAP);

    // `workflow.run` logs the workflow id, not its name — resolve names in one
    // read so the hint can say which workflow, not just that one ran.
    const workflowIds = [
      ...new Set(auditRows.filter((r) => r.action === "workflow.run").map((r) => r.entityId)),
    ];
    const workflowNames = new Map<string, string>();
    if (workflowIds.length > 0) {
      const nameRows = await db
        .select({ id: workflows.id, name: workflows.name })
        .from(workflows)
        .where(inArray(workflows.id, workflowIds));
      for (const row of nameRows) workflowNames.set(row.id, row.name);
    }

    const audit: AuditHintEntry[] = auditRows.map((row) => ({
      action: row.action,
      actorName: row.actorName ?? row.actorEmail ?? null,
      entityName:
        row.action === "workflow.run"
          ? (workflowNames.get(row.entityId) ?? null)
          : metadataName(row.metadata),
    }));

    const changes: ChangeAggregate[] = changeRows.map((row) => ({
      changeKind: row.changeKind,
      resourceTypeId: row.resourceTypeId,
      count: Number(row.count),
    }));

    return composeAnomalyHints(changes, audit);
  } catch (err) {
    console.error(
      `[anomaly-hints] hint queries failed for org ${organizationId} (${target.dimension} ${target.dimensionKey} on ${target.day}):`,
      err,
    );
    return [];
  }
}
