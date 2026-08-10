/**
 * Cost centres and allocation rules — the org-defined mapping from spend to
 * named cost centres that powers the showback report. CRUD only; the actual
 * allocation happens in `clickhouse/cost-readers.ts` (`getShowbackSpend`),
 * which compiles the ordered rule list into one `multiIf` over `cost_daily`.
 *
 * Centres nest (`parentId`), so "what does Engineering cost" can be answered
 * with a subtree rather than a single bucket. Nesting is presentation and
 * rollup only — matching is untouched, every row still resolves to exactly one
 * centre in that one pass, and an org that never sets a parent behaves exactly
 * as it did before the column existed. The tree rules (depth cap over the whole
 * subtree being moved, no move into your own descendants) live in
 * `costCentreMoveBlocker` in client-core so the move picker greys out exactly
 * what these functions reject with a 400.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  ALLOCATION_RULE_LIMITS,
  COST_CENTRE_LIMITS,
  costCentreMoveBlocker,
  orderAllocationRules,
  type AllocationRule,
  type AllocationRuleInput,
  type AllocationRuleMatch,
  type CostCentre,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costAllocationRules, costCentres } from "../db/schema";

export type { AllocationRule, AllocationRuleInput, AllocationRuleMatch, CostCentre };
export { ALLOCATION_RULE_LIMITS, COST_CENTRE_LIMITS };

/** A cost-centre write the API should refuse with a 400 and this message. */
export class CostCentreError extends Error {}

export interface CostCentreWriteInput {
  name: string;
  description?: string | undefined;
  /** Centre to nest under; null (or absent) is the top level. */
  parentId?: string | null | undefined;
}

function centreToWire(row: typeof costCentres.$inferSelect): CostCentre {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parentId: row.parentId,
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

/**
 * Create a centre, optionally nested under `parentId`. Throws
 * {@link CostCentreError} when the placement would breach the depth cap or
 * name an unknown parent — the same check the move picker runs client-side.
 */
export async function createCostCentre(
  organizationId: string,
  input: CostCentreWriteInput,
): Promise<CostCentre> {
  const parentId = input.parentId ?? null;
  if (parentId !== null) {
    const blocked = costCentreMoveBlocker(await listCostCentres(organizationId), null, parentId);
    if (blocked) throw new CostCentreError(blocked);
  }

  const [row] = await db
    .insert(costCentres)
    .values({
      id: randomUUID(),
      organizationId,
      name: input.name,
      description: input.description ?? null,
      parentId,
    })
    .returning();
  if (!row) throw new Error("Failed to create cost centre");
  return centreToWire(row);
}

/**
 * Rename, redescribe, and/or move a centre. A move is this same update with a
 * different `parentId` — there is no separate endpoint, the same way filing a
 * report in a folder is an edit of where it is filed.
 *
 * Throws {@link CostCentreError} when the move would nest past
 * {@link COST_CENTRE_LIMITS.maxDepth} (measured over the *whole* subtree being
 * moved, not just this centre) or place the centre inside its own subtree.
 */
export async function updateCostCentre(
  organizationId: string,
  id: string,
  input: CostCentreWriteInput,
): Promise<CostCentre | null> {
  const centres = await listCostCentres(organizationId);
  const current = centres.find((c) => c.id === id);
  if (!current) return null;

  // Absent `parentId` leaves the centre where it is, so a plain rename from a
  // client that has never heard of nesting cannot silently promote it to root.
  const parentId = input.parentId === undefined ? current.parentId : input.parentId;
  if (parentId !== current.parentId) {
    const blocked = costCentreMoveBlocker(centres, id, parentId);
    if (blocked) throw new CostCentreError(blocked);
  }

  const [row] = await db
    .update(costCentres)
    .set({
      name: input.name,
      description: input.description ?? null,
      parentId,
      updatedAt: new Date(),
    })
    .where(and(eq(costCentres.id, id), eq(costCentres.organizationId, organizationId)))
    .returning();
  return row ? centreToWire(row) : null;
}

/**
 * Delete a centre. False when not found.
 *
 * Children are **re-parented onto the deleted centre's own parent**, never
 * deleted and never promoted to the root. Deleting "Platform" out of
 * Engineering → Platform → Search has to leave Search under Engineering: that
 * is what the org chart still says, and promoting to root would quietly move
 * Search's spend out of Engineering's subtree total — a chargeback number
 * changing because someone tidied up a middle row is exactly the surprise this
 * avoids. A root delete leaves its children as roots, which is the same rule
 * with a null parent.
 *
 * Spend history is untouched: amounts live in ClickHouse and are recomputed
 * from the rules on every read. The centre's own rules do go with it (FK
 * `on delete cascade`), so the spend they claimed falls through to whatever
 * rule is next — often "Unallocated", which stays a first-class row.
 */
export async function deleteCostCentre(organizationId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: costCentres.id, parentId: costCentres.parentId })
      .from(costCentres)
      .where(and(eq(costCentres.id, id), eq(costCentres.organizationId, organizationId)))
      .limit(1);
    if (!row) return false;

    await tx
      .update(costCentres)
      .set({ parentId: row.parentId, updatedAt: new Date() })
      .where(and(eq(costCentres.parentId, id), eq(costCentres.organizationId, organizationId)));

    const deleted = await tx
      .delete(costCentres)
      .where(and(eq(costCentres.id, id), eq(costCentres.organizationId, organizationId)))
      .returning({ id: costCentres.id });
    return deleted.length > 0;
  });
}

/**
 * Rules in evaluation order — the order the showback reader compiles into its
 * single `multiIf`, and the order the settings UI renders so "first match wins"
 * means what the list shows.
 *
 * Ascending priority, then (for ties) the more deeply nested centre first, then
 * creation time; see `orderAllocationRules`. A flat org has every centre at
 * depth 0, so this is exactly the old `ORDER BY priority, created_at`.
 */
export async function listAllocationRules(organizationId: string): Promise<AllocationRule[]> {
  const [rows, centres] = await Promise.all([
    db
      .select()
      .from(costAllocationRules)
      .where(eq(costAllocationRules.organizationId, organizationId))
      .orderBy(asc(costAllocationRules.priority), asc(costAllocationRules.createdAt)),
    listCostCentres(organizationId),
  ]);
  return orderAllocationRules(rows.map(ruleToWire), centres);
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

/**
 * Atomically swap the priorities of two rules in the same org. Used by the
 * tag-policy UI's move-up/move-down controls so a half-applied reorder cannot
 * leave both rules on the same priority mid-flight.
 */
export async function swapAllocationRulePriorities(
  organizationId: string,
  aId: string,
  bId: string,
): Promise<AllocationRule[] | null> {
  if (aId === bId) return null;

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(costAllocationRules)
      .where(
        and(
          eq(costAllocationRules.organizationId, organizationId),
          inArray(costAllocationRules.id, [aId, bId]),
        ),
      );
    if (rows.length !== 2) return null;
    const a = rows.find((r) => r.id === aId);
    const b = rows.find((r) => r.id === bId);
    if (!a || !b) return null;

    const now = new Date();
    // Three-step swap through a sentinel so a partial failure cannot leave
    // both rows on one priority even without a unique constraint.
    const sentinel = Math.max(a.priority, b.priority) + 1_000_000;
    await tx
      .update(costAllocationRules)
      .set({ priority: sentinel, updatedAt: now })
      .where(
        and(
          eq(costAllocationRules.id, a.id),
          eq(costAllocationRules.organizationId, organizationId),
        ),
      );
    await tx
      .update(costAllocationRules)
      .set({ priority: a.priority, updatedAt: now })
      .where(
        and(
          eq(costAllocationRules.id, b.id),
          eq(costAllocationRules.organizationId, organizationId),
        ),
      );
    await tx
      .update(costAllocationRules)
      .set({ priority: b.priority, updatedAt: now })
      .where(
        and(
          eq(costAllocationRules.id, a.id),
          eq(costAllocationRules.organizationId, organizationId),
        ),
      );

    // Re-listed in evaluation order (the depth tie-break included) so the UI
    // renders exactly the order the showback query will compile.
    const [updated, centreRows] = await Promise.all([
      tx
        .select()
        .from(costAllocationRules)
        .where(eq(costAllocationRules.organizationId, organizationId))
        .orderBy(asc(costAllocationRules.priority), asc(costAllocationRules.createdAt)),
      tx.select().from(costCentres).where(eq(costCentres.organizationId, organizationId)),
    ]);
    return orderAllocationRules(updated.map(ruleToWire), centreRows.map(centreToWire));
  });
}
