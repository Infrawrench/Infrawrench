/**
 * Org-scoped workflow CRUD, typings generation, and source type checking —
 * shared by the HTTP routes (api/routes/workflows.ts) and the tool registry
 * (tools/workflows.ts), mirroring how services/budgets.ts backs both surfaces.
 *
 * Everything here is transport-agnostic: it takes an organizationId, returns
 * plain data, and reports user-correctable problems as {@link WorkflowError}
 * rather than HTTP responses.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import {
  isValidCronTimezone,
  nextCronOccurrence,
  nextCronOccurrences,
  validateCronExpression,
} from "@infrawrench/client-core";
import {
  DEFAULT_BUDGET_TRIGGER_PERCENT,
  generateInfraDts,
  generateInfraDtsParts,
  typecheckWorkflow,
  type GenerateInfraDtsInput,
  type InfraDtsParts,
  type MetricDef,
  type TypecheckResult,
  type WorkflowTrigger,
} from "@infrawrench/workflow-runtime";
import { listOrgSshKeyNames } from "@infrawrench/server-core/workflows/runner";

import { db } from "../db/client";
import { budgets, workflowMetrics, workflowRuns, workflows } from "../db/schema";
import { listOrgPlugins } from "./workflow-host";

export type WorkflowRow = typeof workflows.$inferSelect;

/** A caller-correctable problem (bad trigger, unknown budget, missing row). */
export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export interface WorkflowBody {
  name?: string;
  description?: string | null;
  source?: string;
  trigger?: WorkflowTrigger;
  metrics?: MetricDef[];
  enabled?: boolean;
  /**
   * HMAC secret for git triggers. `undefined` leaves the stored value alone;
   * `null` or `""` clears it (and with it, signature enforcement).
   */
  webhookSecret?: string | null;
}

/**
 * Strip the signing secret from anything handed back, replacing it with a
 * boolean. A workflow row is readable with `workflows:read`, which is a much
 * weaker permission than the secret warrants.
 */
export function redactWorkflow<T extends { webhookSecret?: string | null }>(
  row: T,
): Omit<T, "webhookSecret"> & { hasWebhookSecret: boolean } {
  const { webhookSecret, ...rest } = row;
  return { ...rest, hasWebhookSecret: !!webhookSecret };
}

/**
 * Resolve the webhook secret to persist. Write-only: the value is never echoed
 * back by the read paths (see {@link redactWorkflow}), so the client sends it
 * once and thereafter sees only whether one is configured.
 */
function nextWebhookSecret(body: WorkflowBody, existing: string | null): string | null | undefined {
  if (body.webhookSecret === undefined) return undefined;
  const trimmed = body.webhookSecret?.trim();
  if (!trimmed) return null;
  return trimmed === existing ? undefined : trimmed;
}

/** When a workflow has a cron/git trigger, derive scheduling/secret fields. */
function triggerDerived(
  trigger: WorkflowTrigger,
  enabled: boolean,
): { nextRunAt: Date | null; webhookToken: string | null } {
  if (trigger.kind === "cron" && enabled) {
    // Schedule the true next occurrence (the poller recomputes after each
    // fire). Seeding "now" instead would make every save of a cron workflow
    // fire it immediately on the next poller tick. `validateTrigger` has
    // already rejected unparseable expressions, so a null here only means the
    // schedule never matches — leave it unscheduled.
    return { nextRunAt: cronNextRun(trigger), webhookToken: null };
  }
  if (trigger.kind === "git") {
    return { nextRunAt: null, webhookToken: crypto.randomUUID() };
  }
  // Budget triggers are driven by the poller's cost pass, not a schedule.
  return { nextRunAt: null, webhookToken: null };
}

/** Next fire time of a cron trigger, or null when it never matches / is invalid. */
function cronNextRun(trigger: Extract<WorkflowTrigger, { kind: "cron" }>): Date | null {
  try {
    return nextCronOccurrence(trigger.expression, {
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * Reject a trigger the runner could never act on. Budget triggers are checked
 * against the org's real budgets — a typo'd id would otherwise save cleanly and
 * then silently never fire.
 */
async function validateTrigger(organizationId: string, trigger: WorkflowTrigger): Promise<void> {
  if (trigger.kind === "cron") {
    if (!trigger.expression?.trim()) {
      throw new WorkflowError("A cron trigger needs an expression (5 fields, e.g. '0 9 * * 1').");
    }
    const error = validateCronExpression(trigger.expression);
    if (error) throw new WorkflowError(`Invalid cron expression: ${error}`);
    if (trigger.timezone && !isValidCronTimezone(trigger.timezone)) {
      throw new WorkflowError(
        `Unknown timezone "${trigger.timezone}" — use an IANA name like "Europe/London".`,
      );
    }
    return;
  }
  if (trigger.kind !== "budget") return;
  if (!trigger.budgetId) {
    throw new WorkflowError("A budget trigger needs a budgetId. Call list_budgets to find one.");
  }
  const [row] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.id, trigger.budgetId),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new WorkflowError(`Budget not found: ${trigger.budgetId}`, 404);
  if (trigger.percent !== undefined && !(trigger.percent > 0)) {
    throw new WorkflowError("Budget trigger percent must be greater than 0.");
  }
  if (
    trigger.metric !== undefined &&
    trigger.metric !== "actual" &&
    trigger.metric !== "forecast"
  ) {
    throw new WorkflowError('Budget trigger metric must be "actual" or "forecast".');
  }
}

/** Normalize a trigger for storage (fills in budget-trigger defaults). */
function normalizeTrigger(trigger: WorkflowTrigger): WorkflowTrigger {
  if (trigger.kind === "cron") {
    const timezone = trigger.timezone?.trim();
    return {
      kind: "cron",
      expression: trigger.expression?.trim() ?? "",
      ...(timezone ? { timezone } : {}),
    };
  }
  if (trigger.kind !== "budget") return trigger;
  return {
    kind: "budget",
    budgetId: trigger.budgetId,
    percent: trigger.percent ?? DEFAULT_BUDGET_TRIGGER_PERCENT,
    metric: trigger.metric ?? "actual",
  };
}

export async function listWorkflows(organizationId: string): Promise<WorkflowRow[]> {
  return db
    .select()
    .from(workflows)
    .where(and(eq(workflows.organizationId, organizationId), isNull(workflows.deletedAt)))
    .orderBy(desc(workflows.updatedAt));
}

export async function getWorkflow(
  organizationId: string,
  id: string,
): Promise<WorkflowRow | undefined> {
  const [wf] = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, id),
        eq(workflows.organizationId, organizationId),
        isNull(workflows.deletedAt),
      ),
    )
    .limit(1);
  return wf;
}

/** Like {@link getWorkflow} but throws a 404 {@link WorkflowError} when missing. */
export async function requireWorkflow(organizationId: string, id: string): Promise<WorkflowRow> {
  const wf = await getWorkflow(organizationId, id);
  if (!wf) throw new WorkflowError(`Workflow not found: ${id}`, 404);
  return wf;
}

export async function createWorkflow(
  organizationId: string,
  body: WorkflowBody,
  userId: string | null,
): Promise<WorkflowRow> {
  const trigger = normalizeTrigger(body.trigger ?? { kind: "manual" });
  await validateTrigger(organizationId, trigger);
  const enabled = body.enabled ?? true;
  const derived = triggerDerived(trigger, enabled);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(workflows).values({
    id,
    organizationId,
    name: body.name?.trim() || "Untitled workflow",
    description: body.description ?? null,
    source: body.source ?? "",
    trigger,
    metricDefs: body.metrics ?? [],
    enabled,
    webhookToken: derived.webhookToken,
    webhookSecret: nextWebhookSecret(body, null) ?? null,
    nextRunAt: derived.nextRunAt,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  });
  return requireWorkflow(organizationId, id);
}

export async function updateWorkflow(
  organizationId: string,
  id: string,
  body: WorkflowBody,
): Promise<WorkflowRow> {
  const existing = await requireWorkflow(organizationId, id);
  const trigger = normalizeTrigger(body.trigger ?? (existing.trigger as WorkflowTrigger));
  await validateTrigger(organizationId, trigger);
  const enabled = body.enabled ?? existing.enabled;
  const derived = triggerDerived(trigger, enabled);
  await db
    .update(workflows)
    .set({
      name: body.name?.trim() || existing.name,
      description: body.description ?? existing.description,
      source: body.source ?? existing.source,
      trigger,
      metricDefs: body.metrics ?? existing.metricDefs,
      enabled,
      // Preserve an existing git webhook token; only (re)issue when needed.
      webhookToken: existing.webhookToken ?? derived.webhookToken,
      ...(() => {
        const secret = nextWebhookSecret(body, existing.webhookSecret);
        return secret === undefined ? {} : { webhookSecret: secret };
      })(),
      nextRunAt: derived.nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, id));
  return requireWorkflow(organizationId, id);
}

export async function softDeleteWorkflow(organizationId: string, id: string): Promise<void> {
  await requireWorkflow(organizationId, id);
  await db
    .update(workflows)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workflows.id, id));
}

// --- Cron schedule sub-resource ---------------------------------------------
//
// A workflow's cron trigger, exposed as a small CRUD surface of its own so
// programmatic clients (SDKs, CLI) can manage schedules without round-tripping
// the whole workflow body. It reads and writes the same `trigger` jsonb the
// full update path uses.

/** How many upcoming fire times the schedule read model previews. */
const SCHEDULE_PREVIEW_COUNT = 3;

export interface WorkflowScheduleView {
  expression: string;
  /** IANA zone the expression is evaluated in; null means UTC. */
  timezone: string | null;
  /** Mirrors the workflow's `enabled` flag — a disabled workflow never fires. */
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  /** The next few fire times, computed from the expression right now. */
  nextRuns: Date[];
}

export interface WorkflowScheduleBody {
  expression: string;
  timezone?: string | null;
  /** Sets the workflow's `enabled` flag (schedules on a disabled workflow don't fire). */
  enabled?: boolean;
}

/** The schedule view of a workflow row, or null when its trigger isn't cron. */
export function workflowScheduleView(row: WorkflowRow): WorkflowScheduleView | null {
  const trigger = row.trigger as WorkflowTrigger;
  if (trigger.kind !== "cron") return null;
  let nextRuns: Date[] = [];
  try {
    nextRuns = nextCronOccurrences(trigger.expression, SCHEDULE_PREVIEW_COUNT, {
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
    });
  } catch {
    // Stored expression predates validation and no longer parses — show none.
  }
  return {
    expression: trigger.expression,
    timezone: trigger.timezone ?? null,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    nextRuns,
  };
}

/**
 * Create or replace a workflow's cron schedule (its trigger becomes cron).
 * Validates the expression/timezone and computes the real `nextRunAt`.
 */
export async function setWorkflowSchedule(
  organizationId: string,
  id: string,
  body: WorkflowScheduleBody,
): Promise<WorkflowRow> {
  return updateWorkflow(organizationId, id, {
    trigger: {
      kind: "cron",
      expression: body.expression,
      ...(body.timezone ? { timezone: body.timezone } : {}),
    },
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  });
}

/**
 * Remove a workflow's cron schedule, reverting its trigger to manual. A no-op
 * when the trigger isn't cron (still 404s on a missing workflow).
 */
export async function clearWorkflowSchedule(
  organizationId: string,
  id: string,
): Promise<WorkflowRow> {
  const existing = await requireWorkflow(organizationId, id);
  if ((existing.trigger as WorkflowTrigger).kind !== "cron") return existing;
  return updateWorkflow(organizationId, id, { trigger: { kind: "manual" } });
}

export async function listWorkflowRuns(workflowId: string, limit = 50) {
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit);
}

export async function listWorkflowMetrics(workflowId: string) {
  return db
    .select()
    .from(workflowMetrics)
    .where(and(eq(workflowMetrics.workflowId, workflowId), isNull(workflowMetrics.deletedAt)));
}

/**
 * Gather the org-specific inputs for typings generation. Enrichment and
 * SSH-key listing are best-effort niceties — never let them fail the whole
 * thing (which would drop the caller back to `infra: any`).
 */
async function workflowTypingsInput(
  organizationId: string,
  opts: { metrics?: MetricDef[]; triggerKind?: WorkflowTrigger["kind"] },
): Promise<GenerateInfraDtsInput> {
  const [plugins, sshKeyNames] = await Promise.all([
    listOrgPlugins(organizationId, { enrichCreateFields: true }).catch(() =>
      listOrgPlugins(organizationId),
    ),
    listOrgSshKeyNames(organizationId).catch(() => [] as string[]),
  ]);
  const triggerKind = opts.triggerKind ?? "manual";
  return {
    plugins,
    metrics: opts.metrics ?? [],
    interactive: triggerKind === "manual",
    triggerKind,
    // Cloud runs have the cost store, so `infra.costs.write` is available.
    costs: true,
    // Cloud runs have the approvals surface, so `infra.waitForApproval` is available.
    approvals: true,
    sshKeyNames,
  };
}

/**
 * Build the ambient `infra.d.ts` a workflow's source is written and checked
 * against.
 */
export async function generateWorkflowTypings(
  organizationId: string,
  opts: { metrics?: MetricDef[]; triggerKind?: WorkflowTrigger["kind"] } = {},
): Promise<string> {
  return generateInfraDts(await workflowTypingsInput(organizationId, opts));
}

/**
 * The same typings split into a global scope plus named per-plugin interfaces,
 * so the MCP/chat tool can hand out the file in parts instead of one large
 * blob. `parts.full` is byte-identical to {@link generateWorkflowTypings}.
 */
export async function generateWorkflowTypingsParts(
  organizationId: string,
  opts: { metrics?: MetricDef[]; triggerKind?: WorkflowTrigger["kind"] } = {},
): Promise<InfraDtsParts> {
  return generateInfraDtsParts(await workflowTypingsInput(organizationId, opts));
}

/** Type-check a source against typings generated for the same org/trigger. */
export async function checkWorkflowSource(
  organizationId: string,
  source: string,
  opts: { metrics?: MetricDef[]; triggerKind?: WorkflowTrigger["kind"] } = {},
): Promise<TypecheckResult> {
  const dts = await generateWorkflowTypings(organizationId, opts);
  return typecheckWorkflow({ source, dts });
}
