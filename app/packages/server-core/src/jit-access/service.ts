/**
 * Just-in-time access: policies, requests and decisions.
 *
 * A member asks for a provider role (picked from a policy an admin wrote) on a
 * connected account, for a bounded window, with a reason; an approver the
 * policy names decides; on approval the plugin grants it upstream
 * (`lifecycle.ts`); the `jit-access-expiry` sweep revokes it when the window
 * ends. Not break-glass (`access/break-glass.ts`), which elevates Infrawrench
 * permissions and never touches a cloud.
 *
 * Authorization lives here, not in the routes, so the HTTP route, the Slack
 * button and anything else that decides go through exactly one set of rules
 * (`jitCanDecide` and friends in client-core, which are the tested statement of
 * them). The rules, all evaluated at the moment of the action:
 *
 * - Asking: the policy is enabled and names the member (or names nobody).
 * - Deciding: the decider is in the policy's approver set *now* (users, roles,
 *   and whoever its on-call rotations resolve to at this instant). Nobody
 *   decides their own request, except an approver approving their own during
 *   an open declared incident when the policy opts in, for their own
 *   principal only. A deleted or disabled policy has no approvers, so its
 *   pending requests cannot be approved.
 * - Extending: an approver, within the policy maximum for the whole window.
 * - Revoking: the holder, an approver, or anyone with `org:settings:write`.
 * - Cancelling: the requester, while it is still pending.
 *
 * Every state change is audit-logged (`auditJit`), including denials,
 * cancellations, timeouts and every failed revoke.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  JIT_HOLDING_STATUSES,
  JIT_LIMITS,
  jitCanDecide,
  jitExtensionHeadroom,
  jitIsApprover,
  jitMayRequest,
  type JitAccessAccount,
  type JitAccessRequest,
  type JitCreateRequestInput,
  type JitEndReason,
  type JitGrantIssue,
  type JitPickerOption,
  type JitPolicy,
  type JitPolicyInput,
  type JitPrincipalOption,
  type JitPrincipalResolution,
  type JitProviderLabels,
  type JitRequestStatus,
} from "@infrawrench/client-core";
import type { JitAccessDeclaration } from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accounts, organizationMembers, users } from "../db/schema";
import { incidents } from "../db/incident-schema";
import { jitAccessPolicies, jitAccessRequests } from "../db/jit-access-schema";
import { getPlugin, pluginCodeAvailable } from "../plugin-loader";
import { resolveOnCallNow } from "../on-call/store";
import { hasPermission } from "../permissions/catalog";
import { fanOutApprovalRequest, formatApprovalExpiry } from "../approvals/notify";
import { updateSlackApprovalMessages } from "../slack-approvals";
import { sendPushToOrgUser } from "../push/dispatch";
import { appPath } from "../app-url";
import { keepAlive } from "../runtime/request-scope";
import {
  JIT_LEASE_MS,
  auditJit,
  executeGrant,
  executeRevoke,
  jitClient,
  runJitAccessSweep,
  type JitActor,
  type JitRequestRow,
  type JitSweepStats,
} from "./lifecycle";

type PolicyRow = typeof jitAccessPolicies.$inferSelect;

/** A refusal the route turns into an HTTP status. */
export class JitAccessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502,
    readonly code?: string,
  ) {
    super(message);
    this.name = "JitAccessError";
  }
}

/** Who is calling, resolved once per request. */
export interface JitCaller {
  userId: string;
  name: string | null;
  email: string | null;
  roleId: string | null;
  permissions: readonly string[];
}

export async function loadJitCaller(
  organizationId: string,
  userId: string,
  permissions: readonly string[],
): Promise<JitCaller> {
  const [row] = await db
    .select({
      email: users.email,
      displayName: users.displayName,
      roleId: organizationMembers.roleId,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return {
    userId,
    name: row?.displayName ?? row?.email ?? null,
    email: row?.email ?? null,
    roleId: row?.roleId ?? null,
    permissions,
  };
}

/* ------------------------------------------------------------------ *
 * Accounts and pickers (plugin calls: gateway).
 * ------------------------------------------------------------------ */

function labelsOf(decl: JitAccessDeclaration): JitProviderLabels {
  return {
    scopeLabel: decl.scopeLabel,
    roleLabel: decl.roleLabel,
    principalLabel: decl.principalLabel,
    ...(decl.description ? { description: decl.description } : {}),
    providerEnforcedExpiry: decl.providerEnforcedExpiry,
    principalPicker: decl.principalPicker,
  };
}

async function declarationFor(pluginId: string): Promise<JitAccessDeclaration | null> {
  const loaded = await getPlugin(pluginId);
  return loaded?.plugin.manifest.jitAccess ?? null;
}

/** Connected accounts whose plugin can grant. Manifest-only, so edge-safe. */
export async function listJitAccounts(organizationId: string): Promise<JitAccessAccount[]> {
  const rows = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))
    .orderBy(accounts.displayName);
  const out: JitAccessAccount[] = [];
  for (const row of rows) {
    const decl = await declarationFor(row.pluginId);
    if (decl) out.push({ ...row, labels: labelsOf(decl) });
  }
  return out;
}

function wrapProviderError(err: unknown): never {
  if (err instanceof JitAccessError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new JitAccessError(message, 502, "provider_error");
}

export async function listJitScopeOptions(
  organizationId: string,
  accountId: string,
): Promise<JitPickerOption[]> {
  try {
    const client = await jitClient(organizationId, accountId);
    return await client.listJitScopes!();
  } catch (err) {
    wrapProviderError(err);
  }
}

export async function listJitRoleOptions(
  organizationId: string,
  accountId: string,
  scopeId: string,
): Promise<JitPickerOption[]> {
  try {
    const client = await jitClient(organizationId, accountId);
    return await client.listJitRoles!(scopeId);
  } catch (err) {
    wrapProviderError(err);
  }
}

/* ------------------------------------------------------------------ *
 * Policies.
 * ------------------------------------------------------------------ */

async function accountNames(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: accounts.id, displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, ids)));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

async function toPolicy(
  row: PolicyRow,
  names: Map<string, string>,
  caller?: JitCaller,
): Promise<JitPolicy> {
  const decl = await declarationFor(row.pluginId);
  const policy: JitPolicy = {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    accountId: row.accountId,
    accountName: names.get(row.accountId) ?? null,
    pluginId: row.pluginId,
    targets: row.targets ?? [],
    maxDurationMinutes: row.maxDurationMinutes,
    defaultDurationMinutes: row.defaultDurationMinutes,
    requestTimeoutMinutes: row.requestTimeoutMinutes,
    requesterUserIds: row.requesterUserIds ?? [],
    requesterRoleIds: row.requesterRoleIds ?? [],
    approverUserIds: row.approverUserIds ?? [],
    approverRoleIds: row.approverRoleIds ?? [],
    approverOnCallScheduleIds: row.approverOnCallScheduleIds ?? [],
    allowSelfApprovalDuringIncident: row.allowSelfApprovalDuringIncident,
    requireReason: row.requireReason,
    requireTicket: row.requireTicket,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    labels: decl ? labelsOf(decl) : null,
  };
  if (caller) {
    policy.canRequest =
      Boolean(decl) &&
      hasPermission(caller.permissions, "access:request") &&
      jitMayRequest(policy, caller);
  }
  return policy;
}

export async function listJitPolicies(
  organizationId: string,
  caller?: JitCaller,
): Promise<JitPolicy[]> {
  const rows = await db
    .select()
    .from(jitAccessPolicies)
    .where(eq(jitAccessPolicies.organizationId, organizationId))
    .orderBy(jitAccessPolicies.name);
  const names = await accountNames(organizationId, [...new Set(rows.map((r) => r.accountId))]);
  return Promise.all(rows.map((r) => toPolicy(r, names, caller)));
}

async function policyRow(organizationId: string, policyId: string): Promise<PolicyRow | null> {
  const [row] = await db
    .select()
    .from(jitAccessPolicies)
    .where(
      and(eq(jitAccessPolicies.organizationId, organizationId), eq(jitAccessPolicies.id, policyId)),
    )
    .limit(1);
  return row ?? null;
}

export async function getJitPolicy(
  organizationId: string,
  policyId: string,
  caller?: JitCaller,
): Promise<JitPolicy | null> {
  const row = await policyRow(organizationId, policyId);
  if (!row) return null;
  return toPolicy(row, await accountNames(organizationId, [row.accountId]), caller);
}

function dedupe(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Validate a policy body against the org and the account's capability. The
 * route has already bounds-checked the shape with zod; these are the rules
 * that need the database.
 */
async function normalizePolicyInput(organizationId: string, input: JitPolicyInput) {
  const [account] = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, input.accountId)))
    .limit(1);
  if (!account) throw new JitAccessError("No such account in this organization.", 400);
  if (!(await declarationFor(account.pluginId))) {
    throw new JitAccessError("That account's provider does not support just-in-time access.", 400);
  }
  const targets = input.targets.map((t) => ({
    scopeId: t.scopeId.trim(),
    scopeName: t.scopeName.trim() || t.scopeId.trim(),
    roleId: t.roleId.trim(),
    roleName: t.roleName.trim() || t.roleId.trim(),
  }));
  if (targets.length === 0 || targets.some((t) => !t.scopeId || !t.roleId)) {
    throw new JitAccessError("Pick at least one scope and role people may ask for.", 400);
  }
  const seen = new Set(targets.map((t) => `${t.scopeId}\u0000${t.roleId}`));
  if (seen.size !== targets.length) {
    throw new JitAccessError("Each scope and role pair may appear only once.", 400);
  }
  const approverUserIds = dedupe(input.approverUserIds);
  const approverRoleIds = dedupe(input.approverRoleIds);
  const approverOnCallScheduleIds = dedupe(input.approverOnCallScheduleIds);
  if (
    approverUserIds.length === 0 &&
    approverRoleIds.length === 0 &&
    approverOnCallScheduleIds.length === 0
  ) {
    throw new JitAccessError(
      "Name at least one approver: a member, a role, or an on-call rotation.",
      400,
    );
  }
  const max = input.maxDurationMinutes;
  const def = input.defaultDurationMinutes ?? Math.min(60, max);
  if (def > max) {
    throw new JitAccessError("The default duration cannot be longer than the maximum.", 400);
  }
  return {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    enabled: input.enabled ?? true,
    accountId: account.id,
    pluginId: account.pluginId,
    targets,
    maxDurationMinutes: max,
    defaultDurationMinutes: def,
    requestTimeoutMinutes: input.requestTimeoutMinutes ?? 60,
    requesterUserIds: dedupe(input.requesterUserIds),
    requesterRoleIds: dedupe(input.requesterRoleIds),
    approverUserIds,
    approverRoleIds,
    approverOnCallScheduleIds,
    allowSelfApprovalDuringIncident: input.allowSelfApprovalDuringIncident ?? false,
    requireReason: input.requireReason ?? true,
    requireTicket: input.requireTicket ?? false,
  };
}

export async function createJitPolicy(
  organizationId: string,
  input: JitPolicyInput,
  userId: string | null,
): Promise<JitPolicy> {
  const values = await normalizePolicyInput(organizationId, input);
  const [row] = await db
    .insert(jitAccessPolicies)
    .values({ id: randomUUID(), organizationId, createdByUserId: userId, ...values })
    .returning();
  return toPolicy(row!, await accountNames(organizationId, [row!.accountId]));
}

export async function updateJitPolicy(
  organizationId: string,
  policyId: string,
  input: JitPolicyInput,
): Promise<JitPolicy | null> {
  const values = await normalizePolicyInput(organizationId, input);
  const [row] = await db
    .update(jitAccessPolicies)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(eq(jitAccessPolicies.organizationId, organizationId), eq(jitAccessPolicies.id, policyId)),
    )
    .returning();
  if (!row) return null;
  return toPolicy(row, await accountNames(organizationId, [row.accountId]));
}

/**
 * Delete a policy. Grants it produced keep running to their end and are
 * revoked on time (the sweep needs nothing from the policy); its pending
 * requests lose their approver set and simply time out.
 */
export async function deleteJitPolicy(organizationId: string, policyId: string): Promise<boolean> {
  const deleted = await db
    .delete(jitAccessPolicies)
    .where(
      and(eq(jitAccessPolicies.organizationId, organizationId), eq(jitAccessPolicies.id, policyId)),
    )
    .returning({ id: jitAccessPolicies.id });
  return deleted.length > 0;
}

/* ------------------------------------------------------------------ *
 * Approver evaluation.
 * ------------------------------------------------------------------ */

/** Who the policy's rotations resolve to right now. Never throws (resolveOnCallNow doesn't). */
async function onCallUserIds(organizationId: string, policy: PolicyRow): Promise<string[]> {
  const ids = policy.approverOnCallScheduleIds ?? [];
  const resolved = await Promise.all(ids.map((id) => resolveOnCallNow(organizationId, id)));
  return resolved.map((r) => r.shift?.userId).filter((u): u is string => Boolean(u));
}

async function activeIncidentId(organizationId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(eq(incidents.organizationId, organizationId), eq(incidents.status, "open")))
      .orderBy(desc(incidents.startedAt))
      .limit(1);
    return row?.id ?? null;
  } catch (err) {
    // Fail closed: no incident means no self-approval.
    console.error(`[jit-access] reading open incidents for ${organizationId} failed:`, err);
    return null;
  }
}

interface ApproverView {
  policy: PolicyRow | null;
  isApprover: boolean;
  incidentId: string | null;
}

/** Memoized per call: one listing evaluates each policy once, not once per row. */
function approverEvaluator(organizationId: string, caller: JitCaller) {
  const policies = new Map<string, Promise<PolicyRow | null>>();
  const views = new Map<string, Promise<ApproverView>>();
  let incident: Promise<string | null> | null = null;
  return (policyId: string | null): Promise<ApproverView> => {
    const key = policyId ?? "";
    let view = views.get(key);
    if (!view) {
      view = (async () => {
        if (!policyId) return { policy: null, isApprover: false, incidentId: null };
        let p = policies.get(policyId);
        if (!p) {
          p = policyRow(organizationId, policyId);
          policies.set(policyId, p);
        }
        const policy = await p;
        if (!policy || !policy.enabled) return { policy, isApprover: false, incidentId: null };
        const onCall = await onCallUserIds(organizationId, policy);
        const isApprover = jitIsApprover(
          { approverUserIds: policy.approverUserIds, approverRoleIds: policy.approverRoleIds },
          caller,
          onCall,
        );
        incident ??= policy.allowSelfApprovalDuringIncident
          ? activeIncidentId(organizationId)
          : Promise.resolve(null);
        return {
          policy,
          isApprover,
          incidentId: policy.allowSelfApprovalDuringIncident ? await incident : null,
        };
      })();
      views.set(key, view);
    }
    return view;
  };
}

/* ------------------------------------------------------------------ *
 * Requests: shaping.
 * ------------------------------------------------------------------ */

function toRequest(row: JitRequestRow, caller: JitCaller, view: ApproverView): JitAccessRequest {
  const now = Date.now();
  const status = row.status as JitRequestStatus;
  const isRequester = row.userId === caller.userId;
  const decide = jitCanDecide({
    decision: "approve",
    requesterUserId: row.userId,
    deciderUserId: caller.userId,
    deciderIsApprover: view.isApprover,
    allowSelfApprovalDuringIncident: view.policy?.allowSelfApprovalDuringIncident ?? false,
    activeIncidentId: view.incidentId,
    principalMatched: row.principalMatched,
  });
  const headroom = view.policy ? jitExtensionHeadroom(row, view.policy.maxDurationMinutes) : 0;
  return {
    id: row.id,
    policyId: row.policyId,
    policyName: row.policyName,
    accountId: row.accountId,
    accountName: row.accountName,
    pluginId: row.pluginId,
    scopeId: row.scopeId,
    scopeName: row.scopeName,
    roleId: row.roleId,
    roleName: row.roleName,
    userId: row.userId,
    userName: row.userName,
    principalId: row.principalId,
    principalName: row.principalName,
    principalKind: row.principalKind === "group" ? "group" : "user",
    principalMatched: row.principalMatched,
    reason: row.reason,
    ticket: row.ticket,
    durationMinutes: row.durationMinutes,
    status,
    requestExpiresAt: row.requestExpiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    decidedByName: row.decidedByName,
    decisionNote: row.decisionNote,
    selfApproved: row.selfApproved,
    incidentId: row.incidentId,
    grantedAt: row.grantedAt?.toISOString() ?? null,
    grantExpiresAt: row.grantExpiresAt?.toISOString() ?? null,
    preexisting: row.preexisting,
    extendedMinutes: row.extendedMinutes,
    endedAt: row.endedAt?.toISOString() ?? null,
    endedByName: row.endedByName,
    endReason: (row.endReason as JitEndReason | null) ?? null,
    lastError: row.lastError,
    revokeAttempts: row.revokeAttempts,
    createdAt: row.createdAt.toISOString(),
    canDecide: status === "pending" && row.requestExpiresAt.getTime() > now && decide.allowed,
    canCancel: status === "pending" && isRequester,
    canExtend:
      status === "active" &&
      !row.preexisting &&
      headroom > 0 &&
      view.isApprover &&
      (!isRequester || decide.allowed),
    canRevoke:
      (status === "active" || status === "revoke_failed") &&
      (isRequester || view.isApprover || hasPermission(caller.permissions, "org:settings:write")),
  };
}

async function requestRow(
  organizationId: string,
  requestId: string,
): Promise<JitRequestRow | null> {
  const [row] = await db
    .select()
    .from(jitAccessRequests)
    .where(
      and(
        eq(jitAccessRequests.organizationId, organizationId),
        eq(jitAccessRequests.id, requestId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface JitRequestFilterInput {
  status?: JitRequestStatus;
  mine?: boolean;
  holding?: boolean;
  limit?: number;
}

export async function listJitRequests(
  organizationId: string,
  caller: JitCaller,
  filters: JitRequestFilterInput = {},
): Promise<JitAccessRequest[]> {
  const conditions = [eq(jitAccessRequests.organizationId, organizationId)];
  if (filters.status) conditions.push(eq(jitAccessRequests.status, filters.status));
  if (filters.holding) {
    conditions.push(inArray(jitAccessRequests.status, [...JIT_HOLDING_STATUSES]));
  }
  if (filters.mine) conditions.push(eq(jitAccessRequests.userId, caller.userId));
  const rows = await db
    .select()
    .from(jitAccessRequests)
    .where(and(...conditions))
    .orderBy(desc(jitAccessRequests.createdAt))
    .limit(Math.min(Math.max(filters.limit ?? 100, 1), 200));
  const evaluate = approverEvaluator(organizationId, caller);
  return Promise.all(rows.map(async (r) => toRequest(r, caller, await evaluate(r.policyId))));
}

export async function getJitRequest(
  organizationId: string,
  requestId: string,
  caller: JitCaller,
): Promise<JitAccessRequest | null> {
  const row = await requestRow(organizationId, requestId);
  if (!row) return null;
  return toRequest(row, caller, await approverEvaluator(organizationId, caller)(row.policyId));
}

/* ------------------------------------------------------------------ *
 * Principals.
 * ------------------------------------------------------------------ */

async function requestablePolicy(
  organizationId: string,
  policyId: string,
  caller: JitCaller,
): Promise<{ row: PolicyRow; decl: JitAccessDeclaration }> {
  const row = await policyRow(organizationId, policyId);
  if (!row) throw new JitAccessError("No such policy.", 404);
  const decl = await declarationFor(row.pluginId);
  if (!decl) {
    throw new JitAccessError("This policy's provider no longer supports just-in-time access.", 400);
  }
  if (!jitMayRequest(row, caller)) {
    throw new JitAccessError(
      row.enabled ? "This policy does not let you request access." : "This policy is turned off.",
      403,
      "not_requester",
    );
  }
  return { row, decl };
}

export async function resolveJitPrincipalForCaller(
  organizationId: string,
  policyId: string,
  caller: JitCaller,
): Promise<JitPrincipalResolution> {
  const { row, decl } = await requestablePolicy(organizationId, policyId, caller);
  if (!caller.email) {
    return { principal: null, canPick: decl.principalPicker, labels: labelsOf(decl) };
  }
  try {
    const client = await jitClient(organizationId, row.accountId);
    const principal = await client.resolveJitPrincipal!({ email: caller.email, name: caller.name });
    return { principal, canPick: decl.principalPicker, labels: labelsOf(decl) };
  } catch (err) {
    wrapProviderError(err);
  }
}

export async function listJitPrincipalsForPolicy(
  organizationId: string,
  policyId: string,
  caller: JitCaller,
  query?: string,
): Promise<JitPrincipalOption[]> {
  const { row, decl } = await requestablePolicy(organizationId, policyId, caller);
  if (!decl.principalPicker) return [];
  try {
    const client = await jitClient(organizationId, row.accountId);
    const all = await client.listJitPrincipals!(query);
    return all.slice(0, JIT_LIMITS.maxPrincipalsPerList);
  } catch (err) {
    wrapProviderError(err);
  }
}

/* ------------------------------------------------------------------ *
 * Requests: raising.
 * ------------------------------------------------------------------ */

export async function createJitRequest(
  organizationId: string,
  input: JitCreateRequestInput,
  caller: JitCaller,
  via: string,
): Promise<JitAccessRequest> {
  const { row: policy, decl } = await requestablePolicy(organizationId, input.policyId, caller);
  const target = policy.targets.find(
    (t) => t.scopeId === input.scopeId && t.roleId === input.roleId,
  );
  if (!target) throw new JitAccessError("That scope and role are not in this policy.", 400);

  const duration = Math.trunc(input.durationMinutes);
  if (duration < JIT_LIMITS.minDurationMinutes || duration > policy.maxDurationMinutes) {
    throw new JitAccessError(
      `Duration must be between ${JIT_LIMITS.minDurationMinutes} and ${policy.maxDurationMinutes} minutes.`,
      400,
    );
  }
  const reason = input.reason.trim();
  if (policy.requireReason && reason.length < JIT_LIMITS.minReasonLength) {
    throw new JitAccessError(
      `Give a reason of at least ${JIT_LIMITS.minReasonLength} characters; an unexplained grant is not auditable.`,
      400,
    );
  }
  const ticket = input.ticket?.trim() || null;
  if (policy.requireTicket && !ticket) {
    throw new JitAccessError("This policy requires a ticket reference.", 400);
  }

  // The principal: resolved from the caller's own email, or picked from the
  // provider's own list. Never a free-typed id: a request can only name a
  // principal the plugin itself returned.
  let principal: JitPrincipalOption | null = null;
  let principalMatched = false;
  let client;
  try {
    client = await jitClient(organizationId, policy.accountId);
    if (caller.email) {
      principal = await client.resolveJitPrincipal!({ email: caller.email, name: caller.name });
    }
  } catch (err) {
    wrapProviderError(err);
  }
  if (input.principalId && principal?.id !== input.principalId) {
    if (!decl.principalPicker) {
      throw new JitAccessError("This provider does not let you pick a different principal.", 400);
    }
    let options: JitPrincipalOption[];
    try {
      options = await client.listJitPrincipals!();
    } catch (err) {
      wrapProviderError(err);
    }
    principal = options.find((p) => p.id === input.principalId) ?? null;
    if (!principal) throw new JitAccessError("That principal is not one the provider lists.", 400);
  } else if (principal) {
    principalMatched = true;
  }
  if (!principal) {
    throw new JitAccessError(
      `No ${decl.principalLabel} matches your email address.` +
        (decl.principalPicker ? " Pick yours from the list instead." : ""),
      400,
      "no_principal",
    );
  }

  // One live or pending request per person, scope and role: a second would
  // be a second grant of the same thing, and revoking one would end both.
  const [dup] = await db
    .select({ id: jitAccessRequests.id })
    .from(jitAccessRequests)
    .where(
      and(
        eq(jitAccessRequests.organizationId, organizationId),
        eq(jitAccessRequests.accountId, policy.accountId),
        eq(jitAccessRequests.scopeId, target.scopeId),
        eq(jitAccessRequests.roleId, target.roleId),
        eq(jitAccessRequests.principalId, principal.id),
        inArray(jitAccessRequests.status, ["pending", ...JIT_HOLDING_STATUSES]),
      ),
    )
    .limit(1);
  if (dup) {
    throw new JitAccessError(
      "There is already a pending or active request for this role and principal.",
      409,
      "duplicate",
    );
  }

  const id = randomUUID();
  const requestExpiresAt = new Date(Date.now() + policy.requestTimeoutMinutes * 60_000);
  const accountName = (await accountNames(organizationId, [policy.accountId])).get(
    policy.accountId,
  );
  const [row] = await db
    .insert(jitAccessRequests)
    .values({
      id,
      organizationId,
      policyId: policy.id,
      policyName: policy.name,
      accountId: policy.accountId,
      accountName: accountName ?? null,
      pluginId: policy.pluginId,
      scopeId: target.scopeId,
      scopeName: target.scopeName,
      roleId: target.roleId,
      roleName: target.roleName,
      userId: caller.userId,
      userName: caller.name,
      userEmail: caller.email,
      principalId: principal.id,
      principalName: principal.name,
      principalKind: principal.kind,
      principalMatched,
      reason,
      ticket,
      durationMinutes: duration,
      status: "pending",
      requestExpiresAt,
      nextActionAt: requestExpiresAt,
    })
    .returning();
  const actor: JitActor = { userId: caller.userId, name: caller.name, via };
  await auditJit(row!, "requested", actor, {
    policyId: policy.id,
    durationMinutes: duration,
    reason,
    ticket,
    principalMatched,
  });

  void keepAlive(notifyApprovers(row!, policy.requestTimeoutMinutes));
  return toRequest(row!, caller, await approverEvaluator(organizationId, caller)(policy.id));
}

function requestHeadline(row: JitRequestRow): string {
  return `${row.userName ?? "A member"} is requesting ${row.roleName} on ${row.scopeName}`;
}

function requestSummary(row: JitRequestRow): string {
  return `${row.roleName} on ${row.scopeName}${row.accountName ? ` (${row.accountName})` : ""}`;
}

/** Fan the request out to approvers. Never throws: the queue holds it either way. */
async function notifyApprovers(row: JitRequestRow, timeoutMinutes: number): Promise<void> {
  try {
    const who = row.userName ?? "A member";
    const lines = [
      `Role: ${row.roleName}`,
      `Where: ${row.scopeName}${row.accountName ? ` on ${row.accountName}` : ""}`,
      `Granted to: ${row.principalName}${row.principalMatched ? "" : " (NOT resolved from the requester's own email)"}`,
      `Duration if approved: ${row.durationMinutes} minutes`,
      ...(row.ticket ? [`Ticket: ${row.ticket}`] : []),
      `Timeout: ${formatApprovalExpiry(row.requestExpiresAt, timeoutMinutes)}; no decision counts as a denial.`,
    ];
    await fanOutApprovalRequest({
      organizationId: row.organizationId,
      kind: "jit",
      approvalId: row.id,
      title: requestHeadline(row),
      message: row.reason,
      detailLines: lines,
      context: `${requestSummary(row)} · ${row.durationMinutes}m · ${formatApprovalExpiry(row.requestExpiresAt, timeoutMinutes)}`,
      url: appPath(`/org/${row.organizationId}/jit-access`),
      push: {
        type: "jit_access_request",
        orgId: row.organizationId,
        requestId: row.id,
        requestedByName: who,
        summary: requestSummary(row),
        durationMinutes: row.durationMinutes,
        actionable: true,
      },
      slackLead: `*${who}* is asking for \`${row.roleName}\` on \`${row.scopeName}\` for ${row.durationMinutes} minutes.`,
      teamsLead: `${who} is asking for ${row.roleName} on ${row.scopeName} for ${row.durationMinutes} minutes.`,
    });
  } catch (err) {
    console.error(`[jit-access] notifying approvers about ${row.id} failed:`, err);
  }
}

/** Tell the requester what happened to their request. Never throws. */
async function notifyRequester(row: JitRequestRow, outcome: string): Promise<void> {
  try {
    await sendPushToOrgUser(row.organizationId, row.userId, "workflowPages", {
      title: `Just-in-time access ${outcome}`,
      body: `${requestSummary(row)}${row.decidedByName ? `, by ${row.decidedByName}` : ""}`,
      data: {
        type: "jit_access_request",
        orgId: row.organizationId,
        requestId: row.id,
        requestedByName: row.userName ?? "A member",
        summary: requestSummary(row),
        durationMinutes: row.durationMinutes,
        actionable: false,
      },
    });
  } catch (err) {
    console.error(`[jit-access] notifying requester of ${row.id} failed:`, err);
  }
}

function retireSlack(
  row: JitRequestRow,
  decision: "approved" | "denied" | "expired",
  via?: string,
) {
  void keepAlive(
    updateSlackApprovalMessages(row.organizationId, "jit", row.id, {
      decision,
      decidedByName: row.decidedByName,
      ...(via ? { via } : {}),
      title: `Approval needed: ${requestHeadline(row)}`,
      body: row.reason,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Requests: deciding, cancelling, extending, revoking.
 * ------------------------------------------------------------------ */

const DECISION_ERRORS: Record<string, string> = {
  not_approver: "You are not one of this policy's approvers.",
  self_approval: "You cannot decide your own request. Cancel it instead, or ask another approver.",
  self_approval_unmatched_principal:
    "Self-approval during an incident only covers your own principal, and this request names another.",
};

export async function decideJitRequest(
  organizationId: string,
  requestId: string,
  decision: "approve" | "deny",
  caller: JitCaller,
  opts: { note?: string | null; via: string },
): Promise<JitAccessRequest> {
  const row = await requestRow(organizationId, requestId);
  if (!row) throw new JitAccessError("Not found", 404);
  const view = await approverEvaluator(organizationId, caller)(row.policyId);
  const check = jitCanDecide({
    decision,
    requesterUserId: row.userId,
    deciderUserId: caller.userId,
    deciderIsApprover: view.isApprover,
    allowSelfApprovalDuringIncident: view.policy?.allowSelfApprovalDuringIncident ?? false,
    activeIncidentId: view.incidentId,
    principalMatched: row.principalMatched,
  });
  if (!check.allowed) throw new JitAccessError(DECISION_ERRORS[check.code]!, 403, check.code);
  if (row.status !== "pending" || row.requestExpiresAt.getTime() <= Date.now()) {
    throw new JitAccessError("This request has already been decided or has timed out.", 409);
  }

  const now = new Date();
  const approve = decision === "approve";
  const [updated] = await db
    .update(jitAccessRequests)
    .set({
      status: approve ? "granting" : "denied",
      decidedAt: now,
      decidedByUserId: caller.userId,
      decidedByName: caller.name,
      decisionNote: opts.note?.trim() || null,
      selfApproved: approve && check.selfApproved,
      incidentId: approve && check.selfApproved ? view.incidentId : null,
      // The approval holds the lease while it grants inline; where plugin
      // code cannot run (the web edge), the sweep picks it up at once.
      nextActionAt: approve
        ? new Date(now.getTime() + (pluginCodeAvailable() ? JIT_LEASE_MS : 0))
        : null,
      ...(approve ? {} : { endedAt: now }),
      updatedAt: now,
    })
    .where(
      and(
        eq(jitAccessRequests.id, row.id),
        eq(jitAccessRequests.organizationId, organizationId),
        eq(jitAccessRequests.status, "pending"),
      ),
    )
    .returning();
  if (!updated)
    throw new JitAccessError("This request has already been decided or has timed out.", 409);

  const actor: JitActor = { userId: caller.userId, name: caller.name, via: opts.via };
  await auditJit(updated, approve ? "approved" : "denied", actor, {
    note: updated.decisionNote,
    selfApproved: updated.selfApproved,
    incidentId: updated.incidentId,
    durationMinutes: updated.durationMinutes,
  });
  retireSlack(updated, approve ? "approved" : "denied", opts.via);

  let final = updated;
  if (approve && pluginCodeAvailable()) final = await executeGrant(updated);
  void keepAlive(
    notifyRequester(
      final,
      !approve
        ? "denied"
        : final.status === "active"
          ? "granted"
          : final.status === "granting"
            ? "approved, granting"
            : "approved, but the grant failed",
    ),
  );
  return toRequest(final, caller, view);
}

export async function cancelJitRequest(
  organizationId: string,
  requestId: string,
  caller: JitCaller,
  via: string,
): Promise<JitAccessRequest> {
  const row = await requestRow(organizationId, requestId);
  // Somebody else's request reads as absent: cancelling is the requester's alone.
  if (!row || row.userId !== caller.userId) throw new JitAccessError("Not found", 404);
  const [updated] = await db
    .update(jitAccessRequests)
    .set({
      status: "cancelled",
      endedAt: new Date(),
      nextActionAt: null,
      decisionNote: "Cancelled by the requester.",
      updatedAt: new Date(),
    })
    .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "pending")))
    .returning();
  if (!updated) throw new JitAccessError("Only a pending request can be cancelled.", 409);
  await auditJit(updated, "cancelled", { userId: caller.userId, name: caller.name, via });
  retireSlack(updated, "expired");
  return toRequest(updated, caller, await approverEvaluator(organizationId, caller)(row.policyId));
}

export async function extendJitRequest(
  organizationId: string,
  requestId: string,
  minutes: number,
  caller: JitCaller,
  via: string,
): Promise<JitAccessRequest> {
  const row = await requestRow(organizationId, requestId);
  if (!row) throw new JitAccessError("Not found", 404);
  const view = await approverEvaluator(organizationId, caller)(row.policyId);
  const shaped = toRequest(row, caller, view);
  if (!view.isApprover) {
    throw new JitAccessError(DECISION_ERRORS["not_approver"]!, 403, "not_approver");
  }
  if (row.userId === caller.userId && !shaped.canExtend) {
    throw new JitAccessError(DECISION_ERRORS["self_approval"]!, 403, "self_approval");
  }
  if (row.status !== "active" || !row.grantExpiresAt || row.preexisting) {
    throw new JitAccessError("Only an active grant can be extended.", 409);
  }
  const add = Math.trunc(minutes);
  const headroom = jitExtensionHeadroom(row, view.policy!.maxDurationMinutes);
  if (add < 1 || add > headroom) {
    throw new JitAccessError(
      headroom === 0
        ? "This grant is already at the policy's maximum duration."
        : `Extend by between 1 and ${headroom} minutes.`,
      400,
    );
  }
  const newExpiry = new Date(row.grantExpiresAt.getTime() + add * 60_000);
  // Provider first: a provider-enforced expiry (a GCP IAM Condition) must
  // move before the host promises the longer window. If the database write
  // then fails, the host still revokes at the old time, which is safe.
  const decl = await declarationFor(row.pluginId);
  if (decl?.providerEnforcedExpiry) {
    try {
      const client = await jitClient(organizationId, row.accountId);
      await client.grantJitAccess!({
        grantId: row.id,
        scopeId: row.scopeId,
        roleId: row.roleId,
        principal: {
          id: row.principalId,
          name: row.principalName,
          kind: row.principalKind === "group" ? "group" : "user",
        },
        expiresAt: newExpiry,
        reason: row.reason,
        ref: row.grantRef,
      });
    } catch (err) {
      wrapProviderError(err);
    }
  }
  const [updated] = await db
    .update(jitAccessRequests)
    .set({
      grantExpiresAt: newExpiry,
      extendedMinutes: row.extendedMinutes + add,
      nextActionAt: newExpiry,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jitAccessRequests.id, row.id),
        eq(jitAccessRequests.status, "active"),
        eq(jitAccessRequests.grantExpiresAt, row.grantExpiresAt),
      ),
    )
    .returning();
  if (!updated) throw new JitAccessError("The grant changed while extending; try again.", 409);
  await auditJit(
    updated,
    "extended",
    { userId: caller.userId, name: caller.name, via },
    {
      minutes: add,
      grantExpiresAt: newExpiry.toISOString(),
    },
  );
  return toRequest(updated, caller, view);
}

export async function revokeJitRequest(
  organizationId: string,
  requestId: string,
  caller: JitCaller,
  via: string,
): Promise<JitAccessRequest> {
  const row = await requestRow(organizationId, requestId);
  if (!row) throw new JitAccessError("Not found", 404);
  const view = await approverEvaluator(organizationId, caller)(row.policyId);
  const shaped = toRequest(row, caller, view);
  if (row.status === "granting" || row.status === "revoking") {
    throw new JitAccessError(
      "A provider call is in flight for this grant; try again shortly.",
      409,
    );
  }
  if (!shaped.canRevoke) {
    if (row.status !== "active" && row.status !== "revoke_failed") {
      throw new JitAccessError("This grant is not active.", 409);
    }
    throw new JitAccessError("Only the holder, an approver or an admin can revoke this.", 403);
  }
  const actor: JitActor = { userId: caller.userId, name: caller.name, via };
  // Provider calls are plugin code: on the web edge the sweep does the work,
  // so the row is made due now and reported as revoking.
  if (!pluginCodeAvailable()) {
    const [queued] = await db
      .update(jitAccessRequests)
      .set({
        nextActionAt: new Date(),
        endReason: row.endReason ?? "revoked",
        endedByUserId: caller.userId,
        endedByName: caller.name,
        grantExpiresAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jitAccessRequests.id, row.id),
          inArray(jitAccessRequests.status, ["active", "revoke_failed"]),
        ),
      )
      .returning();
    return toRequest(queued ?? row, caller, view);
  }
  const after = await executeRevoke(row, "revoked", actor);
  return toRequest(after, caller, view);
}

/* ------------------------------------------------------------------ *
 * The sweep, and the access review's view of it.
 * ------------------------------------------------------------------ */

async function timeOutRequest(row: JitRequestRow): Promise<void> {
  const [expired] = await db
    .update(jitAccessRequests)
    .set({ status: "timed_out", endedAt: new Date(), nextActionAt: null, updatedAt: new Date() })
    .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "pending")))
    .returning();
  if (!expired) return;
  await auditJit(expired, "timed_out", { userId: null, name: null, via: "the expiry sweep" });
  retireSlack(expired, "expired");
  await notifyRequester(expired, "timed out");
}

/** The `jit-access-expiry` poller pass. */
export function runJitAccessExpiryPass(opts: { limit?: number } = {}): Promise<JitSweepStats> {
  return runJitAccessSweep({ ...opts, onTimeout: timeOutRequest });
}

/** How long past its window a grant may still read as held before the review flags it. */
const OVERDUE_GRACE_MS = 10 * 60 * 1000;

/**
 * Grants the access review should flag: revocation failed, or the row still
 * says the access is held well after its window ended (the sweep is behind
 * or stuck). Evidence-only, like every other review finding.
 */
export async function listJitGrantIssues(organizationId: string): Promise<JitGrantIssue[]> {
  const rows = await db
    .select()
    .from(jitAccessRequests)
    .where(
      and(
        eq(jitAccessRequests.organizationId, organizationId),
        inArray(jitAccessRequests.status, [...JIT_HOLDING_STATUSES]),
      ),
    );
  const now = Date.now();
  const issues: JitGrantIssue[] = [];
  for (const row of rows) {
    const overdue = row.grantExpiresAt && row.grantExpiresAt.getTime() + OVERDUE_GRACE_MS < now;
    const kind: JitGrantIssue["kind"] | null =
      row.status === "revoke_failed"
        ? row.lastError?.includes("still reports the grant")
          ? "still_present"
          : "revoke_failed"
        : overdue
          ? "overdue"
          : null;
    if (!kind) continue;
    issues.push({
      requestId: row.id,
      kind,
      accountId: row.accountId,
      accountName: row.accountName,
      pluginId: row.pluginId,
      scopeName: row.scopeName,
      roleName: row.roleName,
      principalName: row.principalName,
      userName: row.userName,
      grantExpiresAt: row.grantExpiresAt?.toISOString() ?? null,
      lastError: row.lastError,
      revokeAttempts: row.revokeAttempts,
    });
  }
  return issues;
}
