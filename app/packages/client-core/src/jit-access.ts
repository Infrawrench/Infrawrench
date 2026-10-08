/**
 * Just-in-time access: the platform-neutral client half.
 *
 * A member asks for a **provider** role (a permission set on an AWS account, an
 * IAM role on a GCP project, a ClusterRole in a namespace) for a bounded
 * window, under a policy an admin wrote; an approver the policy names says yes;
 * the plugin grants it upstream; the host revokes it when the window ends.
 *
 * Not to be confused with break-glass access (`access-requests.ts`), which
 * elevates a member's **Infrawrench** permissions and never touches a cloud.
 * The two share the `access:*` permission family for reading and asking, and
 * nothing else: break-glass approval is a permission, just-in-time approval is
 * a seat in a policy's approver set.
 *
 * Server contract: `/api/org/:orgId/jit-access` (web `api/routes/jit-access.ts`).
 * The decision rules below are pure so the server, the UI and the tests agree
 * on them without a database.
 */
import { CloudApiError, type CloudFetch } from "./fetch";

/**
 * Where a request is in its life.
 *
 * - `pending`: waiting for an approver; `timed_out` when nobody decided in time.
 * - `denied` / `cancelled`: ended before anything was granted.
 * - `granting`: approved, the provider call is in flight.
 * - `active`: the provider holds the grant (or the principal already had it:
 *   see `preexisting`).
 * - `grant_failed`: the provider refused; nothing is held.
 * - `revoking` → `revoked`: the window ended (`endReason`) and the grant was
 *   removed upstream.
 * - `revoke_failed`: removing it failed and is being retried. Raised loudly:
 *   this is somebody holding access past the window an approver agreed to.
 */
export type JitRequestStatus =
  | "pending"
  | "timed_out"
  | "denied"
  | "cancelled"
  | "granting"
  | "active"
  | "grant_failed"
  | "revoking"
  | "revoked"
  | "revoke_failed";

export const JIT_REQUEST_STATUSES: readonly JitRequestStatus[] = [
  "pending",
  "timed_out",
  "denied",
  "cancelled",
  "granting",
  "active",
  "grant_failed",
  "revoking",
  "revoked",
  "revoke_failed",
];

/** Why a grant stopped: it ran out, somebody ended it, or the grant itself failed. */
export type JitEndReason = "expired" | "revoked" | "grant_failed";

/** The bounds every surface (and the Terraform provider) enforces. */
export const JIT_LIMITS = {
  minDurationMinutes: 5,
  /** Twelve hours: a window that outlives a long shift is a role change. */
  maxDurationMinutes: 720,
  minTimeoutMinutes: 5,
  maxTimeoutMinutes: 1440,
  minReasonLength: 10,
  maxReasonLength: 2000,
  maxTicketLength: 200,
  maxNameLength: 120,
  maxDescriptionLength: 1000,
  maxTargets: 50,
  maxPrincipalsPerList: 100,
} as const;

/** One scope + role pair a policy lets people ask for. Names are display snapshots. */
export interface JitPolicyTarget {
  scopeId: string;
  scopeName: string;
  roleId: string;
  roleName: string;
}

/** What a plugin calls its scopes, roles and principals. */
export interface JitProviderLabels {
  scopeLabel: string;
  roleLabel: string;
  principalLabel: string;
  description?: string;
  providerEnforcedExpiry: boolean;
  principalPicker: boolean;
}

export interface JitPolicy {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  accountId: string;
  /** Display name of the account, for the picker and the card. */
  accountName: string | null;
  pluginId: string;
  targets: JitPolicyTarget[];
  maxDurationMinutes: number;
  defaultDurationMinutes: number;
  /** How long a request stays decidable. No decision counts as a denial. */
  requestTimeoutMinutes: number;
  /** Who may ask. Both empty means any member holding `access:request`. */
  requesterUserIds: string[];
  requesterRoleIds: string[];
  /** Who may decide. The union, evaluated at decision time. */
  approverUserIds: string[];
  approverRoleIds: string[];
  /** On-call rotations whose current on-call person may decide. */
  approverOnCallScheduleIds: string[];
  /**
   * While a declared incident is open, an approver may approve their own
   * request (recorded as self-approved, with the incident). Off by default.
   */
  allowSelfApprovalDuringIncident: boolean;
  requireReason: boolean;
  requireTicket: boolean;
  createdAt: string;
  updatedAt: string;
  /** Labels from the account's plugin; absent when the plugin lost the capability. */
  labels?: JitProviderLabels | null;
  /** Caller-relative: whether the caller may raise a request under this policy. */
  canRequest?: boolean;
}

/** Create/replace body for a policy. */
export interface JitPolicyInput {
  name: string;
  description?: string | null | undefined;
  enabled?: boolean | undefined;
  accountId: string;
  targets: JitPolicyTarget[];
  maxDurationMinutes: number;
  defaultDurationMinutes?: number | undefined;
  requestTimeoutMinutes?: number | undefined;
  requesterUserIds?: string[] | undefined;
  requesterRoleIds?: string[] | undefined;
  approverUserIds?: string[] | undefined;
  approverRoleIds?: string[] | undefined;
  approverOnCallScheduleIds?: string[] | undefined;
  allowSelfApprovalDuringIncident?: boolean | undefined;
  requireReason?: boolean | undefined;
  requireTicket?: boolean | undefined;
}

export interface JitAccessRequest {
  id: string;
  policyId: string | null;
  policyName: string | null;
  accountId: string;
  accountName: string | null;
  pluginId: string;
  scopeId: string;
  scopeName: string;
  roleId: string;
  roleName: string;
  userId: string;
  userName: string | null;
  principalId: string;
  principalName: string;
  principalKind: "user" | "group";
  /**
   * True when the principal was resolved from the requester's own email. A
   * request naming somebody else's principal says so on every approval card.
   */
  principalMatched: boolean;
  reason: string;
  ticket: string | null;
  durationMinutes: number;
  status: JitRequestStatus;
  /** When an undecided request times out. */
  requestExpiresAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  /** Approved by the requester under the incident rule. */
  selfApproved: boolean;
  incidentId: string | null;
  grantedAt: string | null;
  grantExpiresAt: string | null;
  /** The principal already held the role; nothing was created or will be removed. */
  preexisting: boolean;
  extendedMinutes: number;
  endedAt: string | null;
  endedByName: string | null;
  endReason: JitEndReason | null;
  lastError: string | null;
  revokeAttempts: number;
  createdAt: string;
  /** Caller-relative permissions, computed by the server at read time. */
  canDecide: boolean;
  canCancel: boolean;
  canExtend: boolean;
  canRevoke: boolean;
}

export interface JitAccessAccount {
  id: string;
  displayName: string;
  pluginId: string;
  labels: JitProviderLabels;
}

export interface JitPickerOption {
  id: string;
  name: string;
  description?: string;
  privileged?: boolean;
}

export interface JitPrincipalOption {
  id: string;
  name: string;
  kind: "user" | "group";
  email?: string | null;
}

/** The caller's resolved principal for one policy, or why there is none. */
export interface JitPrincipalResolution {
  principal: JitPrincipalOption | null;
  /** True when the requester may pick a different principal. */
  canPick: boolean;
  labels: JitProviderLabels;
}

export interface JitCreateRequestInput {
  policyId: string;
  scopeId: string;
  roleId: string;
  durationMinutes: number;
  reason: string;
  ticket?: string | undefined;
  /** Only when the caller's email does not resolve; must be one the plugin lists. */
  principalId?: string | undefined;
}

/**
 * A grant the access review should flag: revocation failed, or the grant is
 * still marked as held after its window ended.
 */
export interface JitGrantIssue {
  requestId: string;
  kind: "revoke_failed" | "overdue" | "still_present";
  accountId: string;
  accountName: string | null;
  pluginId: string;
  scopeName: string;
  roleName: string;
  principalName: string;
  userName: string | null;
  grantExpiresAt: string | null;
  lastError: string | null;
  revokeAttempts: number;
}

/* ------------------------------------------------------------------ *
 * Pure rules. The server is the authority; these are the same rules,
 * here so they are tested once and readable by every surface.
 * ------------------------------------------------------------------ */

/** Statuses in which access may be held upstream right now. */
export const JIT_HOLDING_STATUSES: ReadonlySet<JitRequestStatus> = new Set([
  "granting",
  "active",
  "revoking",
  "revoke_failed",
]);

/** Whether a policy lets this member ask. Both lists empty means everyone may. */
export function jitMayRequest(
  policy: Pick<JitPolicy, "enabled" | "requesterUserIds" | "requesterRoleIds">,
  member: { userId: string; roleId: string | null },
): boolean {
  if (!policy.enabled) return false;
  if (policy.requesterUserIds.length === 0 && policy.requesterRoleIds.length === 0) return true;
  if (policy.requesterUserIds.includes(member.userId)) return true;
  return member.roleId !== null && policy.requesterRoleIds.includes(member.roleId);
}

/**
 * Whether a member is in a policy's approver set *right now*.
 * `onCallUserIds` is who the policy's rotations resolve to at this instant.
 */
export function jitIsApprover(
  policy: Pick<JitPolicy, "approverUserIds" | "approverRoleIds">,
  member: { userId: string; roleId: string | null },
  onCallUserIds: readonly string[] = [],
): boolean {
  if (policy.approverUserIds.includes(member.userId)) return true;
  if (member.roleId !== null && policy.approverRoleIds.includes(member.roleId)) return true;
  return onCallUserIds.includes(member.userId);
}

export type JitDecisionCheck =
  | { allowed: true; selfApproved: boolean }
  | {
      allowed: false;
      code: "not_approver" | "self_approval" | "self_approval_unmatched_principal";
    };

/**
 * May this decider approve (or deny) this request?
 *
 * 1. The decider must be in the approver set at decision time; a role edit or
 *    an on-call handover between request and decision is honoured.
 * 2. Nobody decides their own request, with one exception the policy must opt
 *    into: an approver may approve their own request while a declared incident
 *    is open, and only for a principal resolved from their own email (so the
 *    exception cannot be used to hand access to somebody else).
 *    Denying your own request is never the route: cancelling is.
 */
export function jitCanDecide(args: {
  decision: "approve" | "deny";
  requesterUserId: string;
  deciderUserId: string;
  deciderIsApprover: boolean;
  allowSelfApprovalDuringIncident: boolean;
  activeIncidentId: string | null;
  principalMatched: boolean;
}): JitDecisionCheck {
  if (!args.deciderIsApprover) return { allowed: false, code: "not_approver" };
  if (args.requesterUserId !== args.deciderUserId) return { allowed: true, selfApproved: false };
  if (
    args.decision === "approve" &&
    args.allowSelfApprovalDuringIncident &&
    args.activeIncidentId !== null
  ) {
    if (!args.principalMatched)
      return { allowed: false, code: "self_approval_unmatched_principal" };
    return { allowed: true, selfApproved: true };
  }
  return { allowed: false, code: "self_approval" };
}

/**
 * How many more minutes a live grant may be extended by: the policy maximum
 * is a ceiling on the whole window, not on each piece of it.
 */
export function jitExtensionHeadroom(
  request: Pick<JitAccessRequest, "durationMinutes" | "extendedMinutes">,
  maxDurationMinutes: number,
): number {
  return Math.max(0, maxDurationMinutes - request.durationMinutes - request.extendedMinutes);
}

/** Status words for every surface, in one dialect. */
export function jitStatusLabel(status: JitRequestStatus): string {
  switch (status) {
    case "pending":
      return "Waiting";
    case "timed_out":
      return "Timed out";
    case "denied":
      return "Denied";
    case "cancelled":
      return "Cancelled";
    case "granting":
      return "Granting";
    case "active":
      return "Active";
    case "grant_failed":
      return "Grant failed";
    case "revoking":
      return "Revoking";
    case "revoked":
      return "Ended";
    case "revoke_failed":
      return "Revoke failed";
  }
}

/* ------------------------------------------------------------------ *
 * Transport (mobile, CLI). Web and desktop speak the same paths
 * through their own transports.
 * ------------------------------------------------------------------ */

export async function fetchJitPolicies(api: CloudFetch, orgId: string): Promise<JitPolicy[]> {
  return (await api.org<JitPolicy[]>(orgId, "/jit-access/policies")) ?? [];
}

export interface JitRequestFilters {
  status?: JitRequestStatus;
  mine?: boolean;
  /** Only rows that may be holding access upstream. */
  holding?: boolean;
}

export function jitRequestQuery(filters: JitRequestFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.mine) params.set("mine", "1");
  if (filters.holding) params.set("holding", "1");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchJitRequests(
  api: CloudFetch,
  orgId: string,
  filters: JitRequestFilters = {},
): Promise<JitAccessRequest[]> {
  return (
    (await api.org<JitAccessRequest[]>(orgId, `/jit-access/requests${jitRequestQuery(filters)}`)) ??
    []
  );
}

export async function fetchJitRequest(
  api: CloudFetch,
  orgId: string,
  requestId: string,
): Promise<JitAccessRequest | null> {
  return api.org<JitAccessRequest>(orgId, `/jit-access/requests/${encodeURIComponent(requestId)}`);
}

export async function fetchJitPrincipal(
  api: CloudFetch,
  orgId: string,
  policyId: string,
): Promise<JitPrincipalResolution | null> {
  return api.org<JitPrincipalResolution>(
    orgId,
    `/jit-access/policies/${encodeURIComponent(policyId)}/principal`,
  );
}

export async function createJitRequest(
  api: CloudFetch,
  orgId: string,
  input: JitCreateRequestInput,
): Promise<JitAccessRequest | null> {
  return api.org<JitAccessRequest>(orgId, "/jit-access/requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type JitRequestAction = "approve" | "deny" | "cancel" | "revoke";

export async function actOnJitRequest(
  api: CloudFetch,
  orgId: string,
  requestId: string,
  action: JitRequestAction,
  note?: string,
): Promise<JitAccessRequest | null> {
  return api.org<JitAccessRequest>(
    orgId,
    `/jit-access/requests/${encodeURIComponent(requestId)}/${action}`,
    { method: "POST", body: JSON.stringify(note ? { note } : {}) },
  );
}

export async function extendJitRequest(
  api: CloudFetch,
  orgId: string,
  requestId: string,
  minutes: number,
): Promise<JitAccessRequest | null> {
  return api.org<JitAccessRequest>(
    orgId,
    `/jit-access/requests/${encodeURIComponent(requestId)}/extend`,
    { method: "POST", body: JSON.stringify({ minutes }) },
  );
}

/** A decision that lost a race (or arrived after the timeout): re-list, do not retry. */
export function isJitConflict(error: unknown): boolean {
  return error instanceof CloudApiError && error.status === 409;
}
