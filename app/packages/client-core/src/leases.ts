/**
 * Resource leases (TTL) — an optional "expires at" on any resource ("give me
 * a test cluster for 3 days").
 *
 * Active leases ride the expiry radar as kind `"lease"` items, so the owner
 * is nagged through the existing expiry alert pass on every surface. A lease
 * may additionally opt into **auto-delete**: the poller's lease pass
 * (`server-core/src/leases/pass.ts`) announces the deletion twice on the
 * `expiryAlerts` trigger and then calls the plugin's `deleteResource` at
 * expiry — freeze-aware, and never before both announcements went out.
 *
 * This module is the shared pure half: the wire contract for
 * `/api/org/:orgId/leases`, the input validation both the editor UIs and the
 * API boundary run (so they reject the same inputs with the same words), and
 * the Bearer fetch helpers.
 */
import type { CloudFetch } from "./fetch";

/**
 * Lifecycle of a lease row:
 * - `"active"` — counting down (only active leases appear on the radar).
 * - `"deleted"` — auto-delete completed; the resource is gone.
 * - `"failed"` — auto-delete was retried and given up on (see `lastError`).
 * - `"canceled"` — the lease was called off; the resource stays.
 */
export type LeaseStatus = "active" | "deleted" | "failed" | "canceled";

/** Wire shape of a lease row as every read endpoint returns it. */
export interface ResourceLease {
  id: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /** Resource display name, denormalized at lease time — survives deletion. */
  resourceName: string;
  accountName: string;
  /** The lease deadline, ISO 8601. */
  expiresAt: string;
  /** Whether the resource is deleted at expiry (after two announcements). */
  autoDelete: boolean;
  /** Why/who-for, shown on the radar and in the announcements. */
  note: string | null;
  status: LeaseStatus;
  /** First announcement instant; null until sent. */
  firstWarningAt: string | null;
  /** Final (second) announcement instant; null until sent. */
  finalWarningAt: string | null;
  deleteAttempts: number;
  /** Last auto-delete failure/deferral detail; never silent. */
  lastError: string | null;
  /** When the lease reached a terminal status. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceLeaseListResponse {
  leases: ResourceLease[];
}

/** Body of `POST /api/org/:orgId/leases`. */
export interface ResourceLeaseCreate {
  resourceId: string;
  accountId: string;
  /** ISO 8601; must be in the future, at most {@link LEASE_LIMITS.maxHorizonDays} out. */
  expiresAt: string;
  autoDelete?: boolean;
  note?: string;
}

/** Body of `PUT /api/org/:orgId/leases/:id`; omitted fields keep their value. */
export interface ResourceLeasePatch {
  expiresAt?: string;
  autoDelete?: boolean;
  /** `null` clears the note. */
  note?: string | null;
}

export const LEASE_LIMITS = {
  /** Hard cap on lease rows per org — a governance rail, not a product tier. */
  maxPerOrg: 200,
  /** Furthest a lease may reach into the future, in days. */
  maxHorizonDays: 365,
  /** Longest accepted note. */
  maxNoteLength: 500,
} as const;

const MS_PER_DAY = 86_400_000;

/**
 * Validate a lease deadline + note. Returns a human-readable problem or null
 * when valid — shared verbatim by the editor UIs and the API boundary.
 */
export function validateLeaseInput(
  input: { expiresAt: string; note?: string | null | undefined },
  now: number = Date.now(),
): string | null {
  const parsed = Date.parse(input.expiresAt);
  if (typeof input.expiresAt !== "string" || Number.isNaN(parsed)) {
    return "Expiry must be an ISO 8601 date-time.";
  }
  if (parsed <= now) return "The lease must expire in the future.";
  if (parsed > now + LEASE_LIMITS.maxHorizonDays * MS_PER_DAY) {
    return `Leases are limited to ${LEASE_LIMITS.maxHorizonDays} days out.`;
  }
  if (input.note != null && input.note.length > LEASE_LIMITS.maxNoteLength) {
    return `Notes are limited to ${LEASE_LIMITS.maxNoteLength} characters.`;
  }
  return null;
}

/** Read `GET /api/org/:orgId/leases` (permission `resources:read`). */
export async function fetchLeases(
  api: CloudFetch,
  orgId: string,
): Promise<ResourceLeaseListResponse> {
  const res = await api.org<ResourceLeaseListResponse>(orgId, "/leases");
  return res ?? { leases: [] };
}

/** Read one resource's lease, or null (`resources:read`). */
export async function fetchResourceLease(
  api: CloudFetch,
  orgId: string,
  resourceId: string,
): Promise<ResourceLease | null> {
  const res = await api.org<{ lease: ResourceLease | null }>(
    orgId,
    `/leases/resource?resourceId=${encodeURIComponent(resourceId)}`,
  );
  return res?.lease ?? null;
}

/**
 * Create a lease (`resources:write`; `autoDelete: true` additionally requires
 * `resources:delete` — the lease becomes a standing deletion).
 */
export async function createLease(
  api: CloudFetch,
  orgId: string,
  body: ResourceLeaseCreate,
): Promise<ResourceLease | null> {
  return api.org<ResourceLease>(orgId, "/leases", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Update a lease's deadline/auto-delete/note (same permission logic as create). */
export async function updateLease(
  api: CloudFetch,
  orgId: string,
  leaseId: string,
  patch: ResourceLeasePatch,
): Promise<ResourceLease | null> {
  return api.org<ResourceLease>(orgId, `/leases/${encodeURIComponent(leaseId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Cancel a lease — the resource stays, the countdown stops (`resources:write`). */
export async function cancelLease(
  api: CloudFetch,
  orgId: string,
  leaseId: string,
): Promise<ResourceLease | null> {
  return api.org<ResourceLease>(orgId, `/leases/${encodeURIComponent(leaseId)}/cancel`, {
    method: "POST",
  });
}

/** Remove the lease row entirely (`resources:write`). */
export async function deleteLease(api: CloudFetch, orgId: string, leaseId: string): Promise<void> {
  await api.org(orgId, `/leases/${encodeURIComponent(leaseId)}`, { method: "DELETE" });
}
