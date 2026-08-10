/**
 * Resource lease rows — CRUD + normalization shared by the web API and the
 * poller's auto-delete pass.
 *
 * Input validation comes from `@infrawrench/client-core`
 * (`validateLeaseInput`, `LEASE_LIMITS`), the same function the editor UIs
 * check with — the server and the form can't disagree about what a valid
 * deadline is.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  LEASE_LIMITS,
  validateLeaseInput,
  validateLeaseNote,
  type LeaseStatus,
  type ResourceLease,
  type ResourceLeaseListResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resourceLeases, resources } from "../db/schema";

export interface LeaseRecord {
  id: string;
  organizationId: string;
  accountId: string;
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  expiresAt: Date;
  autoDelete: boolean;
  note: string | null;
  status: LeaseStatus;
  firstWarningAt: Date | null;
  finalWarningAt: Date | null;
  nextCheckAt: Date | null;
  deleteAttempts: number;
  lastError: string | null;
  completedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeaseCreateInput {
  resourceId: string;
  accountId: string;
  /** ISO 8601. */
  expiresAt: string;
  autoDelete?: boolean;
  note?: string;
}

export interface LeaseUpdateInput {
  /** ISO 8601. */
  expiresAt?: string;
  autoDelete?: boolean;
  /** `null` clears the note. */
  note?: string | null;
}

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class LeaseInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "LeaseInputError";
  }
}

/** Postgres unique-index conflict (23505), possibly wrapped by the ORM. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}

function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export async function listLeaseRecords(organizationId: string): Promise<LeaseRecord[]> {
  const rows = await db
    .select()
    .from(resourceLeases)
    .where(eq(resourceLeases.organizationId, organizationId))
    .orderBy(resourceLeases.expiresAt, resourceLeases.id);
  return rows as LeaseRecord[];
}

export async function getLeaseRecord(
  organizationId: string,
  leaseId: string,
): Promise<LeaseRecord | null> {
  const rows = await db
    .select()
    .from(resourceLeases)
    .where(and(eq(resourceLeases.organizationId, organizationId), eq(resourceLeases.id, leaseId)))
    .limit(1);
  return (rows[0] as LeaseRecord | undefined) ?? null;
}

/** The (unique) lease row for a resource, whatever its status, or null. */
export async function getLeaseRecordByResource(
  organizationId: string,
  resourceId: string,
): Promise<LeaseRecord | null> {
  const rows = await db
    .select()
    .from(resourceLeases)
    .where(
      and(
        eq(resourceLeases.organizationId, organizationId),
        eq(resourceLeases.resourceId, resourceId),
      ),
    )
    .limit(1);
  return (rows[0] as LeaseRecord | undefined) ?? null;
}

/**
 * Create a lease on a synced resource. One lease per resource: an *active*
 * lease conflicts (409 — edit it instead), while a terminal row (deleted /
 * failed / canceled) is replaced in place so the unique index never blocks a
 * fresh lease on a surviving resource.
 */
export async function createLeaseRecord(
  organizationId: string,
  input: LeaseCreateInput,
  createdByUserId?: string,
): Promise<LeaseRecord> {
  const note = normalizeNote(input.note);
  const problem = validateLeaseInput({ expiresAt: input.expiresAt, note });
  if (problem) throw new LeaseInputError(problem);

  const [resource] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, input.resourceId)))
    .limit(1);
  if (!resource || resource.deletedAt !== null) {
    throw new LeaseInputError("Resource not found in this organization", 404);
  }
  if (resource.accountId !== input.accountId) {
    throw new LeaseInputError("Resource does not belong to that account");
  }

  const now = new Date();
  const row = {
    id: randomUUID(),
    organizationId,
    accountId: resource.accountId,
    resourceId: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    displayName: resource.displayName,
    expiresAt: new Date(input.expiresAt),
    autoDelete: input.autoDelete === true,
    note,
    status: "active" as const,
    firstWarningAt: null,
    finalWarningAt: null,
    // Null = due: the pass picks a fresh auto-delete lease up on the next
    // tick and reschedules it to its first warning instant. Harmless on
    // nag-only leases — the claim filters on `auto_delete`.
    nextCheckAt: null,
    deleteAttempts: 0,
    lastError: null,
    completedAt: null,
    createdByUserId: createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  // Duplicate check, per-org limit, terminal-row replacement and the insert
  // run in one transaction under an org-scoped advisory lock (the schedules
  // recipe); the unique index on (organization_id, resource_id) is the hard
  // backstop and surfaces as the same 409 the pre-check gives.
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`resource_leases:${organizationId}`}))`,
      );
      const [existing] = await tx
        .select({ id: resourceLeases.id, status: resourceLeases.status })
        .from(resourceLeases)
        .where(
          and(
            eq(resourceLeases.organizationId, organizationId),
            eq(resourceLeases.resourceId, input.resourceId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.status === "active") {
          throw new LeaseInputError("This resource already has a lease — edit it instead", 409);
        }
        await tx.delete(resourceLeases).where(eq(resourceLeases.id, existing.id));
      }

      // Terminal leases (deleted/failed/canceled) stay behind as history and
      // must not consume the cap, or a churny org eventually can't lease at all.
      const count = await tx
        .select({ id: resourceLeases.id })
        .from(resourceLeases)
        .where(
          and(
            eq(resourceLeases.organizationId, organizationId),
            eq(resourceLeases.status, "active"),
          ),
        );
      if (count.length >= LEASE_LIMITS.maxPerOrg) {
        throw new LeaseInputError(
          `Organizations are limited to ${LEASE_LIMITS.maxPerOrg} active leases`,
        );
      }

      await tx.insert(resourceLeases).values(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new LeaseInputError("This resource already has a lease — edit it instead", 409);
    }
    throw error;
  }
  return (await getLeaseRecord(organizationId, row.id))!;
}

/**
 * Update the deadline, the auto-delete opt-in and/or the note. Only active
 * leases can be edited. Changing the deadline or the auto-delete flag re-arms
 * the announcement schedule: the warning stamps, the retry counters and the
 * claim column are reset, so the pass recomputes everything from the new
 * timing — and a run the pass has mid-flight loses its claim token, so the
 * edit always wins.
 */
export async function updateLeaseRecord(
  organizationId: string,
  leaseId: string,
  patch: LeaseUpdateInput,
): Promise<LeaseRecord> {
  const existing = await getLeaseRecord(organizationId, leaseId);
  if (!existing) throw new LeaseInputError("Lease not found", 404);
  if (existing.status !== "active") {
    throw new LeaseInputError("Only active leases can be edited — create a new lease instead");
  }

  const expiresAt = patch.expiresAt ?? existing.expiresAt.toISOString();
  const note = patch.note !== undefined ? normalizeNote(patch.note) : existing.note;
  // Only re-validate the deadline when the patch changes it — a note-only edit
  // must not be rejected because the existing deadline has already passed.
  const problem =
    patch.expiresAt !== undefined
      ? validateLeaseInput({ expiresAt, note })
      : validateLeaseNote(note);
  if (problem) throw new LeaseInputError(problem);

  const autoDelete = patch.autoDelete ?? existing.autoDelete;
  const rearm = patch.expiresAt !== undefined || patch.autoDelete !== undefined;
  await db
    .update(resourceLeases)
    .set({
      expiresAt: new Date(expiresAt),
      autoDelete,
      note,
      ...(rearm
        ? {
            firstWarningAt: null,
            finalWarningAt: null,
            nextCheckAt: null,
            deleteAttempts: 0,
            lastError: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(resourceLeases.organizationId, organizationId), eq(resourceLeases.id, leaseId)));
  return (await getLeaseRecord(organizationId, leaseId))!;
}

/** Cancel an active lease — the countdown stops, the resource stays. */
export async function cancelLeaseRecord(
  organizationId: string,
  leaseId: string,
): Promise<LeaseRecord> {
  const existing = await getLeaseRecord(organizationId, leaseId);
  if (!existing) throw new LeaseInputError("Lease not found", 404);
  if (existing.status !== "active") {
    throw new LeaseInputError("Only active leases can be canceled");
  }
  const now = new Date();
  await db
    .update(resourceLeases)
    .set({ status: "canceled", nextCheckAt: null, completedAt: now, updatedAt: now })
    .where(and(eq(resourceLeases.organizationId, organizationId), eq(resourceLeases.id, leaseId)));
  return (await getLeaseRecord(organizationId, leaseId))!;
}

export async function deleteLeaseRecord(
  organizationId: string,
  leaseId: string,
): Promise<LeaseRecord> {
  const existing = await getLeaseRecord(organizationId, leaseId);
  if (!existing) throw new LeaseInputError("Lease not found", 404);
  await db
    .delete(resourceLeases)
    .where(and(eq(resourceLeases.organizationId, organizationId), eq(resourceLeases.id, leaseId)));
  return existing;
}

// ---------------------------------------------------------------------------
// Wire assembly
// ---------------------------------------------------------------------------

function toWire(
  row: LeaseRecord,
  names: { resourceName: string; accountName: string },
): ResourceLease {
  return {
    id: row.id,
    resourceId: row.resourceId,
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    resourceName: names.resourceName,
    accountName: names.accountName,
    expiresAt: row.expiresAt.toISOString(),
    autoDelete: row.autoDelete,
    note: row.note,
    status: row.status,
    firstWarningAt: row.firstWarningAt ? row.firstWarningAt.toISOString() : null,
    finalWarningAt: row.finalWarningAt ? row.finalWarningAt.toISOString() : null,
    deleteAttempts: row.deleteAttempts,
    lastError: row.lastError,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function nameRows(
  organizationId: string,
  rows: LeaseRecord[],
): Promise<Map<string, { resourceName: string; accountName: string }>> {
  const resourceIds = [...new Set(rows.map((r) => r.resourceId))];
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const [resourceRows, accountRows] = await Promise.all([
    resourceIds.length > 0
      ? db
          .select({ id: resources.id, displayName: resources.displayName })
          .from(resources)
          .where(
            and(eq(resources.organizationId, organizationId), inArray(resources.id, resourceIds)),
          )
      : Promise.resolve([]),
    accountIds.length > 0
      ? db
          .select({ id: accounts.id, displayName: accounts.displayName })
          .from(accounts)
          .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds)))
      : Promise.resolve([]),
  ]);
  const resourceById = new Map(resourceRows.map((r) => [r.id, r.displayName]));
  const accountById = new Map(accountRows.map((a) => [a.id, a.displayName]));
  const out = new Map<string, { resourceName: string; accountName: string }>();
  for (const row of rows) {
    out.set(row.id, {
      // Prefer the live resource name; fall back to the name denormalized at
      // lease time (the resource may already be gone).
      resourceName: resourceById.get(row.resourceId) ?? row.displayName,
      accountName: accountById.get(row.accountId) ?? row.accountId,
    });
  }
  return out;
}

/** All leases for the org, in wire shape, soonest deadline first. */
export async function listLeases(organizationId: string): Promise<ResourceLeaseListResponse> {
  const rows = await listLeaseRecords(organizationId);
  if (rows.length === 0) return { leases: [] };
  const names = await nameRows(organizationId, rows);
  return { leases: rows.map((row) => toWire(row, names.get(row.id)!)) };
}

/** One lease in wire shape, or null. */
export async function getLeaseWire(
  organizationId: string,
  leaseId: string,
): Promise<ResourceLease | null> {
  const row = await getLeaseRecord(organizationId, leaseId);
  if (!row) return null;
  const names = await nameRows(organizationId, [row]);
  return toWire(row, names.get(row.id)!);
}

/** A resource's lease in wire shape, or null. */
export async function getLeaseWireByResource(
  organizationId: string,
  resourceId: string,
): Promise<ResourceLease | null> {
  const row = await getLeaseRecordByResource(organizationId, resourceId);
  if (!row) return null;
  const names = await nameRows(organizationId, [row]);
  return toWire(row, names.get(row.id)!);
}
