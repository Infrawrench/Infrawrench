/**
 * Break-glass access — the platform-neutral client half.
 *
 * A member asks for specific permissions, for a specific number of minutes,
 * with a reason; someone else approves; the elevation lapses on its own. The
 * alternative most orgs reach for — making the person an admin — is how you end
 * up with ten admins and no record of why.
 *
 * Server contract: `/api/org/:orgId/access-requests` (web
 * `api/routes/access-requests.ts`). Asking takes `access:request`, seeing the
 * queue `access:read`, deciding `access:approve`.
 */
import { CloudApiError, type CloudFetch } from "./fetch";

export type AccessRequestStatus = "pending" | "approved" | "denied" | "expired";

/** One request and, if approved, the elevation it opened. */
export interface AccessRequest {
  id: string;
  userId: string;
  /** Name snapshot taken when the request was raised. */
  userName: string | null;
  permissions: string[];
  reason: string;
  /** How long the elevation lasts once granted. */
  durationMinutes: number;
  status: AccessRequestStatus;
  /** When an undecided request stops being decidable (counts as a denial). */
  expiresAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  grantedAt: string | null;
  /** When the elevation lapses. */
  grantExpiresAt: string | null;
  revokedAt: string | null;
  revokedByName: string | null;
  /** True when this row is granting permissions right now. */
  active: boolean;
  createdAt: string;
}

/** What a request may ask for, and the bounds on how long. */
export interface AccessRequestCatalog {
  permissions: string[];
  /** Permissions the caller already holds; asking for these changes nothing. */
  held: string[];
  minGrantMinutes: number;
  maxGrantMinutes: number;
}

/**
 * A live elevation as `/team/me` reports it. Already folded into that
 * response's `permissions`; here so a surface can say what is temporary and
 * when it lapses.
 */
export interface ActiveElevation {
  requestId: string;
  permissions: string[];
  expiresAt: string;
  reason: string;
}

export interface AccessRequestFilters {
  status?: AccessRequestStatus;
  /** Only the caller's own requests — "where is mine". */
  mine?: boolean;
  /** Only rows granting permissions right now. */
  active?: boolean;
}

export async function fetchAccessRequests(
  api: CloudFetch,
  orgId: string,
  filters: AccessRequestFilters = {},
): Promise<AccessRequest[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.mine) params.set("mine", "1");
  if (filters.active) params.set("active", "1");
  const qs = params.toString();
  return (await api.org<AccessRequest[]>(orgId, `/access-requests${qs ? `?${qs}` : ""}`)) ?? [];
}

export async function fetchAccessRequestCatalog(
  api: CloudFetch,
  orgId: string,
): Promise<AccessRequestCatalog | null> {
  return api.org<AccessRequestCatalog>(orgId, "/access-requests/catalog");
}

export async function createAccessRequest(
  api: CloudFetch,
  orgId: string,
  input: { permissions: string[]; reason: string; durationMinutes: number },
): Promise<AccessRequest | null> {
  return api.org<AccessRequest>(orgId, "/access-requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function decideAccessRequest(
  api: CloudFetch,
  orgId: string,
  requestId: string,
  decision: "approve" | "deny",
  note?: string,
): Promise<AccessRequest | null> {
  return api.org<AccessRequest>(
    orgId,
    `/access-requests/${encodeURIComponent(requestId)}/${decision}`,
    { method: "POST", body: JSON.stringify(note ? { note } : {}) },
  );
}

export async function revokeAccessGrant(
  api: CloudFetch,
  orgId: string,
  requestId: string,
): Promise<AccessRequest | null> {
  return api.org<AccessRequest>(orgId, `/access-requests/${encodeURIComponent(requestId)}/revoke`, {
    method: "POST",
  });
}

export async function withdrawAccessRequest(
  api: CloudFetch,
  orgId: string,
  requestId: string,
): Promise<void> {
  await api.org(orgId, `/access-requests/${encodeURIComponent(requestId)}/withdraw`, {
    method: "POST",
  });
}

/**
 * True when a decision failed because someone else got there first, or the
 * request had already timed out. The server's conditional UPDATE is what makes
 * two racing deciders produce exactly one decision — the loser gets this, and
 * the honest response is to say so and re-list rather than retry.
 */
export function isAccessDecisionConflict(error: unknown): boolean {
  return error instanceof CloudApiError && error.status === 409;
}

/**
 * True when the decision was refused on principle rather than by a race: you
 * cannot decide your own request, and you cannot grant what you do not hold.
 * Both are 403s the UI should explain rather than retry.
 */
export function isAccessDecisionForbidden(error: unknown): boolean {
  return error instanceof CloudApiError && error.status === 403;
}

/** "45m" / "2h" / "8h" — the duration picker and the request row. */
export function formatGrantDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/**
 * "expires in 24m" / "expired 3m ago" — the countdown on a pending request and
 * on a live grant.
 *
 * Deliberately the same wording as the workflow approvals inbox
 * (`formatApprovalExpiry`): the phone and the desktop should not describe two
 * kinds of deadline in two different dialects.
 */
export function formatElevationCountdown(at: string, now: number = Date.now()): string {
  const deltaMs = new Date(at).getTime() - now;
  if (Number.isNaN(deltaMs)) return "";
  const past = deltaMs < 0;
  const mins = Math.round(Math.abs(deltaMs) / 60_000);
  const body =
    mins < 1
      ? "less than a minute"
      : mins < 60
        ? `${mins}m`
        : mins < 60 * 24
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / (60 * 24))}d`;
  return past ? `expired ${body} ago` : `expires in ${body}`;
}
