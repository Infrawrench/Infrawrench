/**
 * Org-scoped scenario-model CRUD and referent scanning — shared by the HTTP
 * routes (api/routes/cost-scenarios.ts) and the tool registry, mirroring
 * services/saved-cost-filters.ts.
 *
 * A scenario model is **known future cost the trend cannot see**: a purchase
 * next quarter, a team starting in September, a migration that takes a fifth
 * off compute. Charts, reports and budgets reference one **by id**, and the
 * reference is resolved at query time
 * (`@infrawrench/server-core/cost/scenario-forecast`), so editing the model
 * here changes every projection built on it.
 *
 * Two policy decisions, both inherited from saved filters and both sharper
 * here:
 *
 * - **Deletion is refused while anything references the model** (409 listing
 *   the referents). For a chart that would silently drop the assumptions from a
 *   projection somebody is reading; for a **budget** it would silently move the
 *   forecast thresholds back to the bare trend, which changes when real people
 *   get paged.
 * - **Names are unique per org**, case-insensitively. The name is what the CLI
 *   addresses (`--scenario "Q4 plan"`) and what a chart prints under its
 *   scenario line, so two models called "Q4 plan" would make both meaningless.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  COST_SCENARIO_LIMITS,
  costScenarioModelInputError,
  type CostScenarioAdjustment,
  type CostScenarioModel,
  type CostScenarioModelInput,
  type CostScenarioReferent,
} from "@infrawrench/client-core";
import { toCostScenarioModel } from "@infrawrench/server-core/cost/scenario-forecast";

import { db } from "../db/client";
import {
  budgets,
  costReports,
  costScenarioModels,
  dashboardWidgets,
  dashboards,
} from "../db/schema";

/** Refused delete: the model is still referenced. Routes map this to a 409. */
export class CostScenarioInUseError extends Error {
  override readonly name = "CostScenarioInUseError";
  readonly referents: CostScenarioReferent[];

  constructor(referents: CostScenarioReferent[]) {
    super(
      "This scenario model is still referenced. Deleting it would silently drop its " +
        "assumptions from every projection built on it — including any budget whose forecast " +
        "thresholds are measured against it — so detach it from them first.",
    );
    this.referents = referents;
  }
}

/** A create/update whose name is already taken by a live model. 409. */
export class CostScenarioNameConflictError extends Error {
  override readonly name = "CostScenarioNameConflictError";

  constructor(name: string) {
    super(
      `A scenario model named "${name}" already exists. The name is what a chart prints ` +
        "under its scenario line and what the CLI addresses, so it has to be unambiguous.",
    );
  }
}

/** Too many models. A soft cap, so a runaway integration cannot fill the table. */
export class CostScenarioLimitError extends Error {
  override readonly name = "CostScenarioLimitError";

  constructor() {
    super(
      `An organization can hold at most ${COST_SCENARIO_LIMITS.maxModelsPerOrg} scenario models.`,
    );
  }
}

/**
 * Normalize an input for storage: trimmed name, upper-cased currency, and every
 * adjustment reduced to exactly the stored shape.
 *
 * Normalizing *before* validating is deliberate — a user typing `usd` into a
 * currency box has not made a mistake, and rejecting them for it would be
 * pedantry. Everything the validation genuinely refuses is refused after.
 *
 * @throws {Error} with a caller-presentable message from
 * `costScenarioModelInputError`, which the editors run too, so a form refuses
 * exactly what the API refuses and in the same words.
 */
export function normalizeCostScenarioInput(input: CostScenarioModelInput): {
  name: string;
  description: string | null;
  currency: string;
  adjustments: CostScenarioAdjustment[];
} {
  const currency = (input.currency ?? "").trim().toUpperCase();
  const adjustments: CostScenarioAdjustment[] = (input.adjustments ?? []).map((a) => ({
    id: a.id?.trim() || uuidv4(),
    label: (a.label ?? "").trim(),
    kind: a.kind,
    startDate: a.startDate,
    endDate: a.endDate ?? null,
    amountCents: a.kind === "rate_change" ? null : (a.amountCents ?? null),
    currency:
      a.kind === "rate_change" ? null : (a.currency ?? currency).trim().toUpperCase() || null,
    period: a.kind === "recurring" ? (a.period ?? null) : null,
    percent: a.kind === "rate_change" ? (a.percent ?? null) : null,
    scope: a.scope ?? [],
  }));

  const normalized: CostScenarioModelInput = {
    name: (input.name ?? "").trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    currency,
    adjustments,
  };
  const error = costScenarioModelInputError(normalized);
  if (error) throw new Error(error);

  return {
    name: normalized.name,
    description: normalized.description ?? null,
    currency,
    adjustments,
  };
}

/** List the org's scenario models, alphabetically. */
export async function listCostScenarioModels(organizationId: string): Promise<CostScenarioModel[]> {
  const rows = await db
    .select()
    .from(costScenarioModels)
    .where(
      and(
        eq(costScenarioModels.organizationId, organizationId),
        isNull(costScenarioModels.deletedAt),
      ),
    )
    .orderBy(asc(costScenarioModels.name));
  return rows.map(toCostScenarioModel);
}

/** Fetch one model. Null when not found (or soft-deleted). */
export async function getCostScenarioModel(
  organizationId: string,
  modelId: string,
): Promise<CostScenarioModel | null> {
  const [row] = await db
    .select()
    .from(costScenarioModels)
    .where(
      and(
        eq(costScenarioModels.id, modelId),
        eq(costScenarioModels.organizationId, organizationId),
        isNull(costScenarioModels.deletedAt),
      ),
    )
    .limit(1);
  return row ? toCostScenarioModel(row) : null;
}

async function nameTaken(
  organizationId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: costScenarioModels.id })
    .from(costScenarioModels)
    .where(
      and(
        eq(costScenarioModels.organizationId, organizationId),
        isNull(costScenarioModels.deletedAt),
        sql`lower(${costScenarioModels.name}) = lower(${name})`,
      ),
    );
  return rows.some((r) => r.id !== excludeId);
}

export async function createCostScenarioModel(
  organizationId: string,
  input: CostScenarioModelInput,
  createdByUserId: string | null,
): Promise<CostScenarioModel> {
  const normalized = normalizeCostScenarioInput(input);
  if (await nameTaken(organizationId, normalized.name)) {
    throw new CostScenarioNameConflictError(normalized.name);
  }
  const existing = await db
    .select({ id: costScenarioModels.id })
    .from(costScenarioModels)
    .where(
      and(
        eq(costScenarioModels.organizationId, organizationId),
        isNull(costScenarioModels.deletedAt),
      ),
    );
  if (existing.length >= COST_SCENARIO_LIMITS.maxModelsPerOrg) throw new CostScenarioLimitError();

  const [created] = await db
    .insert(costScenarioModels)
    .values({ id: uuidv4(), organizationId, ...normalized, createdByUserId })
    .returning();
  return toCostScenarioModel(created!);
}

/**
 * Replace a model's name, description, currency and adjustments. Null when not
 * found.
 *
 * A full replace, matching budgets, reports and saved filters. This is the
 * high-leverage write of the feature: every chart drawing the model, and every
 * budget measuring its forecast thresholds against it, uses the new numbers on
 * its next evaluation — which for a budget can change which alerts fire.
 */
export async function updateCostScenarioModel(
  organizationId: string,
  modelId: string,
  input: CostScenarioModelInput,
): Promise<CostScenarioModel | null> {
  const normalized = normalizeCostScenarioInput(input);
  if (await nameTaken(organizationId, normalized.name, modelId)) {
    throw new CostScenarioNameConflictError(normalized.name);
  }

  const [updated] = await db
    .update(costScenarioModels)
    .set({ ...normalized, updatedAt: new Date() })
    .where(
      and(
        eq(costScenarioModels.id, modelId),
        eq(costScenarioModels.organizationId, organizationId),
        isNull(costScenarioModels.deletedAt),
      ),
    )
    .returning();
  return updated ? toCostScenarioModel(updated) : null;
}

/**
 * Everything still referencing a scenario model, in a stable order (budgets
 * first — they are the ones that page people — then reports, then dashboard
 * graphs).
 *
 * Budgets carry the reference as a real column; reports and ad-hoc graph
 * widgets carry it inside their `CostGraphConfig` jsonb, so those are found by
 * scanning `config->>'scenarioModelId'`. There is deliberately no foreign key
 * behind any of these, so this scan *is* the referential integrity.
 */
export async function listCostScenarioReferents(
  organizationId: string,
  modelId: string,
): Promise<CostScenarioReferent[]> {
  const referents: CostScenarioReferent[] = [];

  const budgetRows = await db
    .select({ id: budgets.id, name: budgets.name })
    .from(budgets)
    .where(
      and(
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
        eq(budgets.scenarioModelId, modelId),
      ),
    )
    .orderBy(asc(budgets.name));
  for (const row of budgetRows) referents.push({ kind: "budget", id: row.id, name: row.name });

  const reportRows = await db
    .select({ id: costReports.id, name: costReports.name })
    .from(costReports)
    .where(
      and(
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
        eq(sql`${costReports.config} ->> 'scenarioModelId'`, modelId),
      ),
    )
    .orderBy(asc(costReports.name));
  for (const row of reportRows) referents.push({ kind: "cost_report", id: row.id, name: row.name });

  const widgetRows = await db
    .select({
      id: dashboardWidgets.id,
      title: dashboardWidgets.title,
      dashboardId: dashboardWidgets.dashboardId,
      dashboardName: dashboards.name,
    })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "cost_graph"),
        isNull(dashboardWidgets.deletedAt),
        isNull(dashboards.deletedAt),
        eq(sql`${dashboardWidgets.config} ->> 'scenarioModelId'`, modelId),
      ),
    )
    .orderBy(asc(dashboards.name));
  for (const row of widgetRows) {
    referents.push({
      kind: "cost_graph_widget",
      id: row.id,
      name: row.title,
      dashboardId: row.dashboardId,
      dashboardName: row.dashboardName,
    });
  }

  return referents;
}

/**
 * Soft-delete a scenario model. False when not found.
 *
 * @throws {CostScenarioInUseError} while any budget, report or dashboard graph
 * references it — see the module comment for why refusal, not detach.
 */
export async function softDeleteCostScenarioModel(
  organizationId: string,
  modelId: string,
): Promise<boolean> {
  const referents = await listCostScenarioReferents(organizationId, modelId);
  if (referents.length > 0) throw new CostScenarioInUseError(referents);

  const now = new Date();
  const [deleted] = await db
    .update(costScenarioModels)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(costScenarioModels.id, modelId),
        eq(costScenarioModels.organizationId, organizationId),
        isNull(costScenarioModels.deletedAt),
      ),
    )
    .returning({ id: costScenarioModels.id });
  return !!deleted;
}
