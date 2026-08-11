/**
 * Backup policy rows — CRUD shared by the web API and the coverage feed.
 *
 * Validation comes from `@infrawrench/client-core`
 * (`validateBackupPolicyInput`, `BACKUP_POLICY_LIMITS`), the same function the
 * editors call before a round trip — the `probes/store.ts` and
 * `schedules/store.ts` stance: the server and the form must not be able to
 * disagree about what a valid policy is.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import {
  BACKUP_POLICY_LIMITS,
  validateBackupPolicyInput,
  type BackupPolicy,
  type BackupPolicyInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { backupPolicies } from "../db/schema";

export type BackupPolicyRecord = typeof backupPolicies.$inferSelect;

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class BackupPolicyInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "BackupPolicyInputError";
  }
}

/** Wire shape from a stored row. */
export function toWireBackupPolicy(row: BackupPolicyRecord): BackupPolicy {
  return {
    id: row.id,
    name: row.name,
    resourceTypeIds: row.resourceTypeIds
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    tagKey: row.tagKey,
    tagValue: row.tagValue,
    maxRpoHours: row.maxRpoHours,
    minRetentionDays: row.minRetentionDays,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Trim, dedupe and join a resource-type selector for storage. */
function joinTypeIds(ids: readonly string[] | undefined): string {
  return [...new Set((ids ?? []).map((s) => s.trim()).filter((s) => s !== ""))].join(",");
}

/** `""` and whitespace collapse to null: an empty tag key is "no narrowing". */
function normalizeTag(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The org's policies, newest first. */
export async function listBackupPolicies(organizationId: string): Promise<BackupPolicy[]> {
  const rows = await db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.organizationId, organizationId));
  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
    .map(toWireBackupPolicy);
}

export async function createBackupPolicy(
  organizationId: string,
  input: BackupPolicyInput,
  userId: string | null,
): Promise<BackupPolicy> {
  const problem = validateBackupPolicyInput(input);
  if (problem) throw new BackupPolicyInputError(problem);

  const [existing] = await db
    .select({ n: count() })
    .from(backupPolicies)
    .where(eq(backupPolicies.organizationId, organizationId));
  if ((existing?.n ?? 0) >= BACKUP_POLICY_LIMITS.maxPolicies) {
    throw new BackupPolicyInputError(
      `An organization can have at most ${BACKUP_POLICY_LIMITS.maxPolicies} backup policies`,
      409,
    );
  }

  const tagKey = normalizeTag(input.tagKey);
  const [row] = await db
    .insert(backupPolicies)
    .values({
      id: randomUUID(),
      organizationId,
      name: input.name.trim(),
      resourceTypeIds: joinTypeIds(input.resourceTypeIds),
      tagKey,
      // A value without a key selects nothing; the validator already refuses
      // that, so this only guards the "" → null collapse above.
      tagValue: tagKey ? normalizeTag(input.tagValue) : null,
      maxRpoHours: input.maxRpoHours ?? null,
      minRetentionDays: input.minRetentionDays ?? null,
      enabled: input.enabled ?? true,
      createdBy: userId,
    })
    .returning();
  if (!row) throw new Error("Failed to create the backup policy");
  return toWireBackupPolicy(row);
}

export async function updateBackupPolicy(
  organizationId: string,
  policyId: string,
  patch: Partial<BackupPolicyInput>,
): Promise<BackupPolicy> {
  const [current] = await db
    .select()
    .from(backupPolicies)
    .where(and(eq(backupPolicies.organizationId, organizationId), eq(backupPolicies.id, policyId)))
    .limit(1);
  if (!current) throw new BackupPolicyInputError("No such backup policy", 404);

  const merged: BackupPolicyInput = {
    name: patch.name ?? current.name,
    resourceTypeIds: patch.resourceTypeIds ?? toWireBackupPolicy(current).resourceTypeIds,
    tagKey: patch.tagKey !== undefined ? patch.tagKey : current.tagKey,
    tagValue: patch.tagValue !== undefined ? patch.tagValue : current.tagValue,
    maxRpoHours: patch.maxRpoHours !== undefined ? patch.maxRpoHours : current.maxRpoHours,
    minRetentionDays:
      patch.minRetentionDays !== undefined ? patch.minRetentionDays : current.minRetentionDays,
    enabled: patch.enabled ?? current.enabled,
  };
  // Validated after merging, not before: a PATCH that clears the RPO on a
  // policy whose only other demand is retention is fine, and one that clears
  // both is not — neither is visible from the patch alone.
  const problem = validateBackupPolicyInput(merged);
  if (problem) throw new BackupPolicyInputError(problem);

  const tagKey = normalizeTag(merged.tagKey);
  const [row] = await db
    .update(backupPolicies)
    .set({
      name: merged.name.trim(),
      resourceTypeIds: joinTypeIds(merged.resourceTypeIds),
      tagKey,
      tagValue: tagKey ? normalizeTag(merged.tagValue) : null,
      maxRpoHours: merged.maxRpoHours ?? null,
      minRetentionDays: merged.minRetentionDays ?? null,
      enabled: merged.enabled ?? true,
      updatedAt: new Date(),
    })
    .where(and(eq(backupPolicies.organizationId, organizationId), eq(backupPolicies.id, policyId)))
    .returning();
  if (!row) throw new BackupPolicyInputError("No such backup policy", 404);
  return toWireBackupPolicy(row);
}

/** Returns false when the policy was already gone, so the route can 404. */
export async function deleteBackupPolicy(
  organizationId: string,
  policyId: string,
): Promise<boolean> {
  const removed = await db
    .delete(backupPolicies)
    .where(and(eq(backupPolicies.organizationId, organizationId), eq(backupPolicies.id, policyId)))
    .returning({ id: backupPolicies.id });
  return removed.length > 0;
}
