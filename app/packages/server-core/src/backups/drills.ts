/**
 * Restore drills — recording one, and computing where each protected resource
 * stands.
 *
 * Coverage answers "is there a backup". This answers "does it restore, and how
 * long does it take", which is a different question and the one that is
 * routinely answered wrongly on the day.
 *
 * The standing is derived on read from the drill log by `drillStanding` in
 * `@infrawrench/client-core` — the same function the UI could call, so the two
 * cannot disagree — and the eligible population comes from
 * `listBackupCoverage`, so a resource is only ever asked about its restore when
 * it has something to restore *from*.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  drillStanding,
  summarizeDrills,
  validateRestoreDrill,
  type DrillCoverageRow,
  type DrillSummary,
  type RestoreDrill,
  type RestoreDrillInput,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { users } from "../db/schema";
import { restoreDrills } from "../db/restore-drill-schema";
import { listBackupCoverage } from "./feed";

export class RestoreDrillInputError extends Error {
  status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = "RestoreDrillInputError";
    this.status = status;
  }
}

function selectDrills() {
  return db
    .select({
      id: restoreDrills.id,
      resourceId: restoreDrills.resourceId,
      performedAt: restoreDrills.performedAt,
      outcome: restoreDrills.outcome,
      rtoMinutes: restoreDrills.rtoMinutes,
      restoredFrom: restoreDrills.restoredFrom,
      notes: restoreDrills.notes,
      performedByUserId: restoreDrills.performedByUserId,
      performedByName: users.displayName,
      createdAt: restoreDrills.createdAt,
    })
    .from(restoreDrills)
    .leftJoin(users, eq(users.id, restoreDrills.performedByUserId));
}

interface DrillRow {
  id: string;
  resourceId: string;
  performedAt: Date;
  outcome: RestoreDrill["outcome"];
  rtoMinutes: number | null;
  restoredFrom: string | null;
  notes: string | null;
  performedByUserId: string | null;
  performedByName: string | null;
  createdAt: Date;
}

/**
 * Resource and account names are attached by the caller from the coverage feed
 * rather than joined here, because the coverage feed is where a resource's
 * display name is already resolved — and joining `resources` would drop every
 * drill whose resource has since been deleted, which is exactly the history an
 * auditor asks about.
 */
function toWire(row: DrillRow): RestoreDrill {
  return {
    id: row.id,
    resourceId: row.resourceId,
    resourceName: null,
    accountId: null,
    accountName: null,
    performedAt: row.performedAt.toISOString(),
    outcome: row.outcome,
    rtoMinutes: row.rtoMinutes,
    restoredFrom: row.restoredFrom,
    notes: row.notes,
    performedByUserId: row.performedByUserId,
    performedByName: row.performedByName,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRestoreDrills(
  organizationId: string,
  options: { resourceId?: string | undefined; limit?: number | undefined } = {},
): Promise<RestoreDrill[]> {
  const filters = [eq(restoreDrills.organizationId, organizationId)];
  if (options.resourceId) filters.push(eq(restoreDrills.resourceId, options.resourceId));
  const rows = await selectDrills()
    .where(and(...filters))
    .orderBy(desc(restoreDrills.performedAt))
    .limit(Math.min(options.limit ?? 200, 500));
  return rows.map(toWire);
}

export async function createRestoreDrill(
  organizationId: string,
  input: RestoreDrillInput,
  userId: string | null,
): Promise<RestoreDrill> {
  const problem = validateRestoreDrill(input);
  if (problem) throw new RestoreDrillInputError(problem);

  const id = randomUUID();
  await db.insert(restoreDrills).values({
    id,
    organizationId,
    resourceId: input.resourceId,
    performedAt: new Date(input.performedAt),
    outcome: input.outcome,
    // Normalized to null on a blocked drill even though validation rejects a
    // value there: two places agreeing is cheaper than one place being the only
    // thing between a meaningless RTO and the summary that averages it.
    rtoMinutes: input.outcome === "blocked" ? null : (input.rtoMinutes ?? null),
    restoredFrom: input.restoredFrom?.trim() || null,
    notes: input.notes?.trim() || null,
    performedByUserId: userId,
  });

  const created = (await listRestoreDrills(organizationId, { resourceId: input.resourceId })).find(
    (drill) => drill.id === id,
  );
  if (!created) throw new Error("Failed to record the drill");
  return created;
}

export async function deleteRestoreDrill(
  organizationId: string,
  drillId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(restoreDrills)
    .where(and(eq(restoreDrills.organizationId, organizationId), eq(restoreDrills.id, drillId)))
    .returning({ id: restoreDrills.id });
  return deleted.length > 0;
}

export interface DrillCoverageResponse {
  rows: DrillCoverageRow[];
  summary: DrillSummary;
  /** The staleness window the standings were computed against, in days. */
  validDays: number;
  /**
   * Drills recorded against a resource that is no longer in the inventory.
   * Reported rather than dropped: "we tested this and then removed it" is a
   * fact an auditor asks about, and silently losing it would make the history
   * quietly incomplete.
   */
  orphanedDrills: RestoreDrill[];
  generatedAt: string;
}

export interface ListDrillCoverageOptions {
  validDays?: number;
  now?: number;
}

/**
 * Where every protected resource stands on restore.
 *
 * The population is resources the coverage feed says are **protected or
 * provider-automated** — a resource with no backup cannot be drilled, and
 * listing it here as "never tested" would duplicate the coverage page's own
 * unprotected finding while burying the ones that genuinely can be tested.
 */
export async function listDrillCoverage(
  organizationId: string,
  options: ListDrillCoverageOptions = {},
): Promise<DrillCoverageResponse> {
  const now = options.now ?? Date.now();
  const validDays = options.validDays ?? 180;

  const [coverage, drills] = await Promise.all([
    listBackupCoverage(organizationId),
    selectDrills()
      .where(eq(restoreDrills.organizationId, organizationId))
      .orderBy(asc(restoreDrills.performedAt)),
  ]);

  const byResource = new Map<string, RestoreDrill[]>();
  for (const row of drills) {
    const list = byResource.get(row.resourceId) ?? [];
    list.push(toWire(row));
    byResource.set(row.resourceId, list);
  }

  const eligible = coverage.resources.filter(
    (row) => row.state === "protected" || row.state === "automated",
  );

  const rows: DrillCoverageRow[] = eligible.map((resource) => {
    const own = byResource.get(resource.resourceId) ?? [];
    const standing = drillStanding(own, { validDays, now });
    return {
      resourceId: resource.resourceId,
      resourceName: resource.displayName,
      accountId: resource.accountId,
      accountName: resource.accountName,
      resourceTypeId: resource.resourceTypeId,
      ...standing,
    };
  });

  const eligibleIds = new Set(eligible.map((row) => row.resourceId));
  const orphanedDrills = [...byResource.entries()]
    .filter(([resourceId]) => !eligibleIds.has(resourceId))
    .flatMap(([, list]) => list)
    .sort((a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt));

  // Names are attached from the coverage feed rather than joined in SQL; see
  // the note on `toWire`.
  const names = new Map(
    coverage.resources.map((row) => [
      row.resourceId,
      { resourceName: row.displayName, accountId: row.accountId, accountName: row.accountName },
    ]),
  );
  for (const list of byResource.values()) {
    for (const drill of list) {
      const named = names.get(drill.resourceId);
      if (named) Object.assign(drill, named);
    }
  }

  return {
    rows,
    summary: summarizeDrills(rows),
    validDays,
    orphanedDrills,
    generatedAt: new Date(now).toISOString(),
  };
}
