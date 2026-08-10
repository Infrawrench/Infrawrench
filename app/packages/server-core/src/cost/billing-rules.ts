/**
 * Billing rules — CRUD, plus the one function that turns them into something a
 * query can use.
 *
 * The shape of this module mirrors `cost/allocation.ts` on purpose: rules are
 * the same kind of object (ordered, matched against `cost_daily` columns,
 * first-match-wins where that fits), and the two are read together by anyone
 * trying to understand why a number came out the way it did.
 *
 * The adjustment itself happens nowhere near here. `resolveBillingAdjustments`
 * hands a compiled rule set to `clickhouse/cost-readers.ts`, which folds it into
 * the statement it was going to run anyway. Nothing in this file writes to
 * `cost_daily`, and nothing ever should: collected spend is the audit trail, and
 * a markup that restated it would be unrecoverable the moment it was saved.
 *
 * It lives in `server-core` rather than `web/services` because two independent
 * callers need it: the HTTP/MCP/CLI read path (`web/services/cost-query.ts`)
 * and the poller's budget evaluation (`cost/budget-eval.ts`). One resolver is
 * what makes an opted-in budget measure exactly what the Costs panel shows.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  BILLING_RULE_LIMITS,
  billingRuleInputError,
  compileBillingRules,
  normalizeBillingRuleInput,
  orderBillingRules,
  summarizeBillingRules,
  type BillingRule,
  type BillingRuleAdjustment,
  type BillingRuleInput,
  type BillingRuleMatch,
  type CompiledBillingAdjustments,
  type CostAdjustmentRule,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costBillingRules } from "../db/schema";

export type { BillingRule, BillingRuleInput, BillingRuleMatch, BillingRuleAdjustment };
export { BILLING_RULE_LIMITS };

/** A billing-rule write the API should refuse with a 400 and this message. */
export class BillingRuleError extends Error {
  override readonly name = "BillingRuleError";
}

/** A name already taken in this org — the API maps this to a 409. */
export class BillingRuleNameConflictError extends Error {
  override readonly name = "BillingRuleNameConflictError";

  constructor(name: string) {
    super(
      `A billing rule called "${name}" already exists. Names are how a rule is named in the ` +
        "caption on every adjusted figure, so they have to be unambiguous.",
    );
  }
}

function toWire(row: typeof costBillingRules.$inferSelect): BillingRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    priority: row.priority,
    match: row.match as BillingRuleMatch,
    adjustment: row.adjustment as BillingRuleAdjustment,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The org's rules in evaluation order — the order the readers compile and the
 * order the settings UI renders, so "the first reallocation wins" means what
 * the list shows.
 */
export async function listBillingRules(organizationId: string): Promise<BillingRule[]> {
  const rows = await db
    .select()
    .from(costBillingRules)
    .where(eq(costBillingRules.organizationId, organizationId))
    .orderBy(asc(costBillingRules.priority), asc(costBillingRules.createdAt));
  return orderBillingRules(rows.map(toWire));
}

export async function getBillingRule(
  organizationId: string,
  id: string,
): Promise<BillingRule | null> {
  const [row] = await db
    .select()
    .from(costBillingRules)
    .where(and(eq(costBillingRules.id, id), eq(costBillingRules.organizationId, organizationId)))
    .limit(1);
  return row ? toWire(row) : null;
}

/**
 * Normalize, then validate — a user typing `usd` into a currency box has not
 * made a mistake, and rejecting them for it would be pedantry. Everything
 * genuinely wrong is refused afterwards, in the same words the editor shows.
 */
function prepare(input: BillingRuleInput): BillingRuleInput {
  const normalized = normalizeBillingRuleInput(input);
  const error = billingRuleInputError(normalized);
  if (error) throw new BillingRuleError(error);
  return normalized;
}

/** Postgres' unique-violation code, for the org+name index. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export async function createBillingRule(
  organizationId: string,
  input: BillingRuleInput,
  createdByUserId?: string | undefined,
): Promise<BillingRule> {
  const data = prepare(input);

  const existing = await db
    .select({ id: costBillingRules.id })
    .from(costBillingRules)
    .where(eq(costBillingRules.organizationId, organizationId));
  if (existing.length >= BILLING_RULE_LIMITS.maxRules) {
    throw new BillingRuleError(
      `An organisation can have at most ${BILLING_RULE_LIMITS.maxRules} billing rules.`,
    );
  }

  try {
    const [row] = await db
      .insert(costBillingRules)
      .values({
        id: randomUUID(),
        organizationId,
        name: data.name,
        description: data.description ?? null,
        enabled: data.enabled,
        priority: data.priority,
        match: data.match,
        adjustment: data.adjustment,
        createdByUserId: createdByUserId ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create billing rule");
    return toWire(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new BillingRuleNameConflictError(data.name);
    throw e;
  }
}

/** Full replace, like every other cost object's update. Null when not found. */
export async function updateBillingRule(
  organizationId: string,
  id: string,
  input: BillingRuleInput,
): Promise<BillingRule | null> {
  const data = prepare(input);
  try {
    const [row] = await db
      .update(costBillingRules)
      .set({
        name: data.name,
        description: data.description ?? null,
        enabled: data.enabled,
        priority: data.priority,
        match: data.match,
        adjustment: data.adjustment,
        updatedAt: new Date(),
      })
      .where(and(eq(costBillingRules.id, id), eq(costBillingRules.organizationId, organizationId)))
      .returning();
    return row ? toWire(row) : null;
  } catch (e) {
    if (isUniqueViolation(e)) throw new BillingRuleNameConflictError(data.name);
    throw e;
  }
}

/**
 * Delete a rule. False when not found.
 *
 * Hard delete, and safely so: no spend was ever restated, so nothing has to be
 * un-restated. Every figure the rule ever affected is recomputed from the rules
 * that exist at read time — which is the same reason a budget that opted into
 * adjusted spend simply starts measuring one fewer rule rather than breaking.
 */
export async function deleteBillingRule(organizationId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(costBillingRules)
    .where(and(eq(costBillingRules.id, id), eq(costBillingRules.organizationId, organizationId)))
    .returning({ id: costBillingRules.id });
  return deleted.length > 0;
}

/** The rule set an adjusted query runs, plus what it should be labelled with. */
export interface ResolvedBillingAdjustments {
  adjustments: CompiledBillingAdjustments;
  /** The enabled rules, in evaluation order, for the response's caption. */
  rules: CostAdjustmentRule[];
}

/**
 * The org's enabled rules, compiled for the readers.
 *
 * Always returns a set, never null, even for an org with no rules: "adjusted"
 * must be a state a caller can be told it is in, and an empty compiled set
 * still produces `adjustment: { rules: [], rawTotals: … }` on the wire. The
 * absence of that field has exactly one meaning — these are the collected
 * numbers — and an org with no rules must not be able to fake it.
 */
export async function resolveBillingAdjustments(
  organizationId: string,
): Promise<ResolvedBillingAdjustments> {
  const rules = await listBillingRules(organizationId);
  return { adjustments: compileBillingRules(rules), rules: summarizeBillingRules(rules) };
}
