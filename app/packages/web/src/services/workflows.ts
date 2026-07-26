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
  DEFAULT_BUDGET_TRIGGER_PERCENT,
  generateInfraDts,
  typecheckWorkflow,
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
 * boolean. A workflow row is readable with `dashboards:read`, which is a much
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
    // Poller computes the precise next time from the cron expression; seed "now"
    // so it gets picked up on the next tick.
    return { nextRunAt: new Date(), webhookToken: null };
  }
  if (trigger.kind === "git") {
    return { nextRunAt: null, webhookToken: crypto.randomUUID() };
  }
  // Budget triggers are driven by the poller's cost pass, not a schedule.
  return { nextRunAt: null, webhookToken: null };
}

/**
 * Reject a trigger the runner could never act on. Budget triggers are checked
 * against the org's real budgets — a typo'd id would otherwise save cleanly and
 * then silently never fire.
 */
async function validateTrigger(organizationId: string, trigger: WorkflowTrigger): Promise<void> {
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
 * Build the ambient `infra.d.ts` a workflow's source is written and checked
 * against. Enrichment and SSH-key listing are best-effort niceties — never let
 * them fail the whole thing (which would drop the caller back to `infra: any`).
 */
export async function generateWorkflowTypings(
  organizationId: string,
  opts: { metrics?: MetricDef[]; triggerKind?: WorkflowTrigger["kind"] } = {},
): Promise<string> {
  const [plugins, sshKeyNames] = await Promise.all([
    listOrgPlugins(organizationId, { enrichCreateFields: true }).catch(() =>
      listOrgPlugins(organizationId),
    ),
    listOrgSshKeyNames(organizationId).catch(() => [] as string[]),
  ]);
  const triggerKind = opts.triggerKind ?? "manual";
  return generateInfraDts({
    plugins,
    metrics: opts.metrics ?? [],
    interactive: triggerKind === "manual",
    triggerKind,
    sshKeyNames,
  });
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
