/**
 * Cost centres and allocation rules — the org-defined mapping from spend to
 * named cost centres that powers the showback report. CRUD only; the actual
 * allocation happens in `clickhouse/cost-readers.ts` (`getShowbackSpend`),
 * which compiles the ordered rule list into one `multiIf` over `cost_daily`.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  ALLOCATION_RULE_LIMITS,
  type AllocationRule,
  type AllocationRuleInput,
  type AllocationRuleMatch,
  type CostCentre,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costAllocationRules, costCentres } from "../db/schema";

export type { AllocationRule, AllocationRuleInput, AllocationRuleMatch, CostCentre };
export { ALLOCATION_RULE_LIMITS };

function centreToWire(row: typeof costCentres.$inferSelect): CostCentre {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function ruleToWire(row: typeof costAllocationRules.$inferSelect): AllocationRule {
  return {
    id: row.id,
    costCentreId: row.costCentreId,
    priority: row.priority,
    match: normalizeMatch(row.match),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Drop empty strings so "unset" has exactly one representation. */
export function normalizeMatch(match: AllocationRuleMatch): AllocationRuleMatch {
  const out: AllocationRuleMatch = {};
  if (match.tagKey?.trim()) out.tagKey = match.tagKey.trim();
  // A tag value without a key matches nothing meaningful — require the key.
  if (out.tagKey && match.tagValue?.trim()) out.tagValue = match.tagValue.trim();
  if (match.accountId?.trim()) out.accountId = match.accountId.trim();
  if (match.pluginId?.trim()) out.pluginId = match.pluginId.trim();
  if (match.service?.trim()) out.service = match.service.trim();
  return out;
}

export async function listCostCentres(organizationId: string): Promise<CostCentre[]> {
  const rows = await db
    .select()
    .from(costCentres)
    .where(eq(costCentres.organizationId, organizationId))
    .orderBy(asc(costCentres.name));
  return rows.map(centreToWire);
}

export async function createCostCentre(
  organizationId: string,
  input: { name: string; description?: string | undefined },
): Promise<CostCentre> {
  const [row] = await db
    .insert(costCentres)
    .values({
      id: randomUUID(),
      organizationId,
      name: input.name,
      description: input.description ?? null,
    })
    .returning();
  if (!row) throw new Error("Failed to create cost centre");
  return centreToWire(row);
}

export async function updateCostCentre(
  organizationId: string,
  id: string,
  input: { name: string; description?: string | undefined },
): Promise<CostCentre | null> {
  const [row] = await db
    .update(costCentres)
    .set({ name: input.name, description: input.description ?? null, updatedAt: new Date() })
    .where(and(eq(costCentres.id, id), eq(costCentres.organizationId, organizationId)))
    .returning();
  return row ? centreToWire(row) : null;
}

/** Deleting a centre cascades to its rules (FK `on delete cascade`). */
export async function deleteCostCentre(organizationId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(costCentres)
    .where(and(eq(costCentres.id, id), eq(costCentres.organizationId, organizationId)))
    .returning({ id: costCentres.id });
  return deleted.length > 0;
}

/** Rules in evaluation order: ascending priority, then creation time. */
export async function listAllocationRules(organizationId: string): Promise<AllocationRule[]> {
  const rows = await db
    .select()
    .from(costAllocationRules)
    .where(eq(costAllocationRules.organizationId, organizationId))
    .orderBy(asc(costAllocationRules.priority), asc(costAllocationRules.createdAt));
  return rows.map(ruleToWire);
}

export async function createAllocationRule(
  organizationId: string,
  input: AllocationRuleInput,
): Promise<AllocationRule | null> {
  // The centre must belong to the same org — a cross-org centre id would
  // silently allocate someone else's spend labels.
  const [centre] = await db
    .select({ id: costCentres.id })
    .from(costCentres)
    .where(
      and(eq(costCentres.id, input.costCentreId), eq(costCentres.organizationId, organizationId)),
    );
  if (!centre) return null;

  const existing = await db
    .select({ id: costAllocationRules.id })
    .from(costAllocationRules)
    .where(eq(costAllocationRules.organizationId, organizationId));
  if (existing.length >= ALLOCATION_RULE_LIMITS.maxRules) {
    throw new Error(`An org can have at most ${ALLOCATION_RULE_LIMITS.maxRules} allocation rules`);
  }

  const [row] = await db
    .insert(costAllocationRules)
    .values({
      id: randomUUID(),
      organizationId,
      costCentreId: input.costCentreId,
      priority: input.priority,
      match: normalizeMatch(input.match),
    })
    .returning();
  if (!row) throw new Error("Failed to create allocation rule");
  return ruleToWire(row);
}

export async function updateAllocationRule(
  organizationId: string,
  id: string,
  input: AllocationRuleInput,
): Promise<AllocationRule | null> {
  const [centre] = await db
    .select({ id: costCentres.id })
    .from(costCentres)
    .where(
      and(eq(costCentres.id, input.costCentreId), eq(costCentres.organizationId, organizationId)),
    );
  if (!centre) return null;

  const [row] = await db
    .update(costAllocationRules)
    .set({
      costCentreId: input.costCentreId,
      priority: input.priority,
      match: normalizeMatch(input.match),
      updatedAt: new Date(),
    })
    .where(
      and(eq(costAllocationRules.id, id), eq(costAllocationRules.organizationId, organizationId)),
    )
    .returning();
  return row ? ruleToWire(row) : null;
}

export async function deleteAllocationRule(organizationId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(costAllocationRules)
    .where(
      and(eq(costAllocationRules.id, id), eq(costAllocationRules.organizationId, organizationId)),
    )
    .returning({ id: costAllocationRules.id });
  return deleted.length > 0;
}
