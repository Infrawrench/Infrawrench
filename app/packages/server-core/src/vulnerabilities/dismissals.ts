/**
 * Vulnerability dismissals: accepting an advisory as a known risk for one
 * artifact repository, or for every artifact (`artifactKey = "*"`). The
 * `posture/dismissals.ts` semantics: idempotent upsert, reason trimmed and
 * capped, inert when nothing matches, never pruned.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { VulnerabilityDismissal } from "@infrawrench/client-core";
import { db } from "../db/client";
import { users, vulnerabilityDismissals } from "../db/schema";

export const MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH = 500;

export interface VulnerabilityDismissalRecord extends VulnerabilityDismissal {
  id: string;
  organizationId: string;
}

function selection() {
  return {
    id: vulnerabilityDismissals.id,
    organizationId: vulnerabilityDismissals.organizationId,
    advisoryId: vulnerabilityDismissals.advisoryId,
    artifactKey: vulnerabilityDismissals.artifactKey,
    reason: vulnerabilityDismissals.reason,
    dismissedByName: users.displayName,
    dismissedByEmail: users.email,
    updatedAt: vulnerabilityDismissals.updatedAt,
  };
}

type Row = {
  id: string;
  organizationId: string;
  advisoryId: string;
  artifactKey: string;
  reason: string | null;
  dismissedByName: string | null;
  dismissedByEmail: string | null;
  updatedAt: Date;
};

function toRecord(row: Row): VulnerabilityDismissalRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    advisoryId: row.advisoryId,
    artifactKey: row.artifactKey,
    reason: row.reason,
    dismissedBy: row.dismissedByName || row.dismissedByEmail || null,
    dismissedAt: row.updatedAt.toISOString(),
  };
}

export async function listVulnerabilityDismissals(
  organizationId: string,
): Promise<VulnerabilityDismissalRecord[]> {
  const rows = await db
    .select(selection())
    .from(vulnerabilityDismissals)
    .leftJoin(users, eq(users.id, vulnerabilityDismissals.dismissedBy))
    .where(eq(vulnerabilityDismissals.organizationId, organizationId))
    .orderBy(desc(vulnerabilityDismissals.updatedAt));
  return rows.map(toRecord);
}

export interface DismissVulnerabilityInput {
  advisoryId: string;
  artifactKey: string;
  reason?: string | null | undefined;
  userId?: string | null | undefined;
}

function normalizeReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH);
}

export async function dismissVulnerability(
  organizationId: string,
  input: DismissVulnerabilityInput,
): Promise<VulnerabilityDismissalRecord> {
  const advisoryId = input.advisoryId.trim().toUpperCase();
  const artifactKey = input.artifactKey.trim();
  if (!advisoryId) throw new Error("advisoryId is required");
  if (!artifactKey) throw new Error("artifactKey is required");

  const values = {
    reason: normalizeReason(input.reason),
    dismissedBy: input.userId ?? null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(vulnerabilityDismissals)
    .values({ id: randomUUID(), organizationId, advisoryId, artifactKey, ...values })
    .onConflictDoUpdate({
      target: [
        vulnerabilityDismissals.organizationId,
        vulnerabilityDismissals.advisoryId,
        vulnerabilityDismissals.artifactKey,
      ],
      set: values,
    })
    .returning({ id: vulnerabilityDismissals.id });
  if (!row) throw new Error("Failed to dismiss the vulnerability");

  const [record] = await db
    .select(selection())
    .from(vulnerabilityDismissals)
    .leftJoin(users, eq(users.id, vulnerabilityDismissals.dismissedBy))
    .where(eq(vulnerabilityDismissals.id, row.id))
    .limit(1);
  if (!record) throw new Error("Failed to dismiss the vulnerability");
  return toRecord(record);
}

/** Remove a dismissal. False when there was none (the route answers 404). */
export async function restoreVulnerability(
  organizationId: string,
  advisoryId: string,
  artifactKey: string,
): Promise<boolean> {
  const removed = await db
    .delete(vulnerabilityDismissals)
    .where(
      and(
        eq(vulnerabilityDismissals.organizationId, organizationId),
        eq(vulnerabilityDismissals.advisoryId, advisoryId.trim().toUpperCase()),
        eq(vulnerabilityDismissals.artifactKey, artifactKey.trim()),
      ),
    )
    .returning({ id: vulnerabilityDismissals.id });
  return removed.length > 0;
}
