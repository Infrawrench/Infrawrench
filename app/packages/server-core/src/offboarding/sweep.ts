/**
 * The offboarding sweep: everything tied to one person, read from state the
 * organization already has. No provider API calls, ever: principals and
 * resources are synced rows, seats are the seat pass's inventory, and the rest
 * is Infrawrench's own records. That keeps a sweep cheap enough to rerun
 * whenever the checklist is opened, and safe on the edge (manifests only).
 *
 * What lines up against a person, and how:
 *
 * - **Their Infrawrench membership, API keys and SSH keys**, by user id, from
 *   the users whose email is theirs (or an email alias).
 * - **Cloud principals and other synced resources**, by any field (at any
 *   depth: an `email`, a `createdBy`, an `owner` tag) or the name holding
 *   their email or an alias, plus everything the ownership records name them
 *   as owner of. Principal types get the plugin's declared removal
 *   (`principalRole.revokeActionId` / `offboardByDelete`); everything else is
 *   offered for transfer to another owner.
 * - **Paid seats**, by the seat's email, then its login or member id.
 * - **On-call** rotations they sit in and covers they have not served yet.
 * - **Active leases** they created and **just-in-time grants** they hold.
 *
 * Weaker matches (the part of the email before the `@`, the same name at
 * another domain, their full name) are returned as `possible`; the checklist
 * holds them back until a person confirms them.
 */
import { and, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  describeIdentityMatch,
  isEmailAddress,
  matchIdentityFields,
  matchIdentityValue,
  normalizeIdentityValue,
  strongerMatch,
  upcomingOnCallShifts,
  type IdentityMatch,
  type OffboardingActionId,
  type OffboardingCandidate,
  type OffboardingIdentity,
  type OffboardingMatchConfidence,
} from "@infrawrench/client-core";
import { resolvePrincipalKeys } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import {
  accounts,
  apiKeys,
  jitAccessRequests,
  organizationMembers,
  resourceOwnership,
  resources,
  sshKeys,
  users,
} from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { listSeats } from "../seats/feed";
import { listOnCallOverrides, listOnCallSchedules } from "../on-call/store";
import { listLeaseRecords } from "../leases/store";

/** How many matching resources one sweep reads; past it the scan says so. */
export const OFFBOARDING_RESOURCE_SCAN_LIMIT = 2000;

/** JIT statuses that may still hold, or be about to hold, access upstream. */
const LIVE_JIT_STATUSES = ["pending", "granting", "active", "revoking", "revoke_failed"];

export interface OffboardingSubject {
  /** Users whose email is the person's (or an email alias), member or not. */
  userIds: string[];
  /** The user whose email is exactly theirs, when there is one. */
  primaryUserId: string | null;
  name: string | null;
  /** Whether they are still a member of the organization. */
  memberUserIds: string[];
}

export interface OffboardingSweepResult {
  subject: OffboardingSubject;
  candidates: OffboardingCandidate[];
  /** True when the resource scan hit its limit and may have missed rows. */
  truncated: boolean;
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The emails a person signs in with: their own and any alias shaped like one. */
function emailsOf(identity: OffboardingIdentity): string[] {
  const out = new Set([normalizeIdentityValue(identity.email)]);
  for (const alias of identity.aliases)
    if (isEmailAddress(alias)) out.add(normalizeIdentityValue(alias));
  return [...out];
}

/** Resolve the person to Infrawrench users, members or not. */
export async function resolveOffboardingSubject(
  organizationId: string,
  identity: OffboardingIdentity,
): Promise<OffboardingSubject> {
  const emails = emailsOf(identity);
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.displayName })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, emails));
  const userIds = rows.map((r) => r.id);
  const primary = rows.find((r) => normalizeIdentityValue(r.email) === emails[0]) ?? null;
  const members =
    userIds.length === 0
      ? []
      : await db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              inArray(organizationMembers.userId, userIds),
            ),
          );
  return {
    userIds,
    primaryUserId: primary?.id ?? null,
    name: primary?.name ?? rows[0]?.name ?? null,
    memberUserIds: members.map((m) => m.userId),
  };
}

interface Accumulator {
  byKey: Map<string, OffboardingCandidate>;
}

/** Add a candidate, or merge it into the row already found under its key. */
function add(acc: Accumulator, candidate: OffboardingCandidate): void {
  const existing = acc.byKey.get(candidate.key);
  if (!existing) {
    acc.byKey.set(candidate.key, candidate);
    return;
  }
  const stronger = strongerMatch(existing, candidate) === candidate;
  acc.byKey.set(candidate.key, {
    ...existing,
    ...(stronger ? { confidence: candidate.confidence } : {}),
    matchReason:
      existing.matchReason === candidate.matchReason
        ? existing.matchReason
        : `${stronger ? candidate.matchReason : existing.matchReason}; ${
            stronger ? existing.matchReason : candidate.matchReason
          }`,
    actions: [...new Set([...existing.actions, ...candidate.actions])],
    ref: { ...existing.ref, ...candidate.ref },
  });
}

/**
 * Sweep the organization for everything tied to `identity`. Pure reads; the
 * caller persists the result (`store.ts`) or returns it as a preview.
 */
export async function sweepOffboarding(
  organizationId: string,
  identity: OffboardingIdentity,
  opts: { now?: Date } = {},
): Promise<OffboardingSweepResult> {
  const now = opts.now ?? new Date();
  const subject = await resolveOffboardingSubject(organizationId, identity);
  const fullIdentity: OffboardingIdentity = { ...identity, name: identity.name ?? subject.name };
  const acc: Accumulator = { byKey: new Map() };

  const [, resourcesResult] = await Promise.all([
    collectInfrawrench(organizationId, subject, identity, now, acc),
    collectResources(organizationId, subject, fullIdentity, acc),
    collectSeats(organizationId, fullIdentity, acc),
  ]);

  return {
    subject,
    candidates: [...acc.byKey.values()],
    truncated: resourcesResult.truncated,
  };
}

// ---------------------------------------------------------------------------
// Infrawrench's own records
// ---------------------------------------------------------------------------

async function collectInfrawrench(
  organizationId: string,
  subject: OffboardingSubject,
  identity: OffboardingIdentity,
  now: Date,
  acc: Accumulator,
): Promise<void> {
  const ids = subject.userIds;
  const email = normalizeIdentityValue(identity.email);
  const exact = (userId: string): OffboardingMatchConfidence =>
    userId === subject.primaryUserId ? "exact" : "alias";
  const reasonFor = (userId: string) =>
    userId === subject.primaryUserId
      ? "Their Infrawrench account"
      : "An Infrawrench account under an alias";

  for (const userId of subject.memberUserIds) {
    add(acc, {
      key: `member:${userId}`,
      kind: "member",
      title: subject.name ?? identity.email,
      detail: null,
      pluginId: null,
      providerName: null,
      accountId: null,
      accountName: null,
      resourceId: null,
      resourceTypeId: null,
      confidence: exact(userId),
      matchReason: reasonFor(userId),
      actions: ["remove-member"],
      ref: { userId },
    });
  }

  const jitFilter: SQL[] = [sql`lower(${jitAccessRequests.userEmail}) = ${email}`];
  if (ids.length > 0) jitFilter.push(inArray(jitAccessRequests.userId, ids));

  const [keys, sshRows, schedules, covers, leases, grants] = await Promise.all([
    ids.length === 0
      ? []
      : db
          .select({
            id: apiKeys.id,
            userId: apiKeys.userId,
            name: apiKeys.name,
            prefix: apiKeys.prefix,
            expiresAt: apiKeys.expiresAt,
          })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.organizationId, organizationId),
              inArray(apiKeys.userId, ids),
              isNull(apiKeys.revokedAt),
              or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
            ),
          ),
    ids.length === 0
      ? []
      : db
          .select({
            id: sshKeys.id,
            userId: sshKeys.userId,
            name: sshKeys.name,
            fingerprint: sshKeys.fingerprint,
          })
          .from(sshKeys)
          .where(and(eq(sshKeys.organizationId, organizationId), inArray(sshKeys.userId, ids))),
    ids.length === 0 ? [] : listOnCallSchedules(organizationId),
    ids.length === 0 ? [] : listOnCallOverrides(organizationId, { from: now }),
    ids.length === 0 ? [] : listLeaseRecords(organizationId),
    db
      .select({
        id: jitAccessRequests.id,
        userId: jitAccessRequests.userId,
        status: jitAccessRequests.status,
        accountId: jitAccessRequests.accountId,
        accountName: jitAccessRequests.accountName,
        pluginId: jitAccessRequests.pluginId,
        scopeName: jitAccessRequests.scopeName,
        roleName: jitAccessRequests.roleName,
        principalName: jitAccessRequests.principalName,
        grantExpiresAt: jitAccessRequests.grantExpiresAt,
      })
      .from(jitAccessRequests)
      .where(
        and(
          eq(jitAccessRequests.organizationId, organizationId),
          inArray(jitAccessRequests.status, LIVE_JIT_STATUSES),
          or(...jitFilter),
        ),
      ),
  ]);

  for (const key of keys) {
    add(acc, {
      key: `api-key:${key.id}`,
      kind: "api-key",
      title: key.name,
      detail: `${key.prefix}…`,
      pluginId: null,
      providerName: null,
      accountId: null,
      accountName: null,
      resourceId: null,
      resourceTypeId: null,
      confidence: exact(key.userId),
      matchReason: "Minted by their Infrawrench account",
      actions: ["revoke-api-key"],
      ref: { apiKeyId: key.id },
    });
  }

  for (const key of sshRows) {
    add(acc, {
      key: `ssh-key:${key.id}`,
      kind: "ssh-key",
      title: key.name,
      detail: key.fingerprint,
      pluginId: null,
      providerName: null,
      accountId: null,
      accountName: null,
      resourceId: null,
      resourceTypeId: null,
      confidence: exact(key.userId),
      matchReason: "Held by their Infrawrench account",
      actions: ["delete-ssh-key"],
      ref: { sshKeyId: key.id },
    });
  }

  const idSet = new Set(ids);
  for (const schedule of schedules) {
    const participant = schedule.participants.find((p) => idSet.has(p.userId));
    if (!participant) continue;
    const next = upcomingOnCallShifts(schedule, now.getTime(), 60).find(
      (shift) => shift.userId === participant.userId,
    );
    add(acc, {
      key: `on-call:${schedule.id}`,
      kind: "on-call",
      title: schedule.name,
      detail: next ? `${next.startsAt.slice(0, 10)} to ${next.endsAt.slice(0, 10)}` : null,
      pluginId: null,
      providerName: null,
      accountId: null,
      accountName: null,
      resourceId: null,
      resourceTypeId: null,
      confidence: exact(participant.userId),
      matchReason: schedule.enabled ? "In the rotation" : "In the rotation (switched off)",
      actions: ["reassign-on-call", "remove-from-rotation"],
      ref: { scheduleId: schedule.id, userId: participant.userId },
    });
  }

  const scheduleNames = new Map(schedules.map((s) => [s.id, s.name]));
  for (const cover of covers) {
    if (!idSet.has(cover.userId)) continue;
    add(acc, {
      key: `on-call-cover:${cover.id}`,
      kind: "on-call-cover",
      title: scheduleNames.get(cover.scheduleId) ?? cover.scheduleId,
      detail: `${cover.startsAt.slice(0, 16).replace("T", " ")} to ${cover.endsAt
        .slice(0, 16)
        .replace("T", " ")}`,
      pluginId: null,
      providerName: null,
      accountId: null,
      accountName: null,
      resourceId: null,
      resourceTypeId: null,
      confidence: exact(cover.userId),
      matchReason: "Covering a shift",
      actions: ["cancel-cover"],
      ref: { overrideId: cover.id },
    });
  }

  for (const lease of leases) {
    if (lease.status !== "active" || !lease.createdByUserId || !idSet.has(lease.createdByUserId)) {
      continue;
    }
    add(acc, {
      key: `lease:${lease.id}`,
      kind: "lease",
      title: lease.displayName,
      detail: `${lease.autoDelete ? "Auto-deletes" : "Expires"} ${lease.expiresAt.toISOString().slice(0, 10)}`,
      pluginId: lease.pluginId,
      providerName: null,
      accountId: lease.accountId,
      accountName: null,
      resourceId: lease.resourceId,
      resourceTypeId: lease.resourceTypeId,
      confidence: exact(lease.createdByUserId),
      matchReason: "Set the lease",
      actions: ["cancel-lease"],
      ref: { leaseId: lease.id },
    });
  }

  for (const grant of grants) {
    const holding = grant.status === "active" || grant.status === "revoke_failed";
    add(acc, {
      key: `jit:${grant.id}`,
      kind: "jit-grant",
      title: `${grant.roleName} on ${grant.scopeName}`,
      detail: `${grant.principalName} · ${grant.status.replace(/_/g, " ")}`,
      pluginId: grant.pluginId,
      providerName: null,
      accountId: grant.accountId,
      accountName: grant.accountName,
      resourceId: null,
      resourceTypeId: null,
      confidence: grant.userId && idSet.has(grant.userId) ? exact(grant.userId) : "exact",
      matchReason: holding ? "Holding a just-in-time grant" : "Requested a just-in-time grant",
      actions: holding ? ["revoke-jit"] : [],
      ref: { requestId: grant.id },
    });
  }
}

// ---------------------------------------------------------------------------
// Synced resources: principals, and anything naming or owned by them
// ---------------------------------------------------------------------------

interface TypeInfo {
  pluginName: string;
  typeName: string;
  principalActions: OffboardingActionId[] | null;
  revokeActionId: string | null;
}

async function typeIndex(): Promise<Map<string, TypeInfo>> {
  const index = new Map<string, TypeInfo>();
  for (const { plugin } of await loadPlugins()) {
    for (const type of plugin.resourceTypes) {
      const declared = type.principalRole ? resolvePrincipalKeys(type.principalRole) : null;
      const actions: OffboardingActionId[] = [];
      if (declared?.revokeActionId) actions.push("revoke");
      // Deleting is only offered where the type can be deleted at all.
      if (declared?.offboardByDelete && type.supportsDelete !== false) actions.push("remove");
      index.set(`${plugin.manifest.id}/${type.id}`, {
        pluginName: plugin.manifest.displayName,
        typeName: type.displayName,
        principalActions: declared ? actions : null,
        revokeActionId: declared?.revokeActionId ?? null,
      });
    }
  }
  return index;
}

/** The search terms a resource row has to contain to be worth matching in full. */
function searchTerms(identity: OffboardingIdentity): string[] {
  const terms = new Set<string>([normalizeIdentityValue(identity.email)]);
  for (const alias of identity.aliases) terms.add(normalizeIdentityValue(alias).replace(/^@/, ""));
  const local = normalizeIdentityValue(identity.email).split("@")[0] ?? "";
  if (local.length >= 3) terms.add(local);
  const name = identity.name ? normalizeIdentityValue(identity.name) : "";
  if (name.includes(" ")) terms.add(name);
  return [...terms].filter((t) => t.length >= 2);
}

async function collectResources(
  organizationId: string,
  subject: OffboardingSubject,
  identity: OffboardingIdentity,
  acc: Accumulator,
): Promise<{ truncated: boolean }> {
  const terms = searchTerms(identity);
  const textMatch = or(
    ...terms.flatMap((term) => {
      const pattern = likePattern(term);
      return [
        sql`${resources.displayName} ilike ${pattern}`,
        sql`${resources.externalId} ilike ${pattern}`,
        sql`${resources.fieldsJson}::text ilike ${pattern}`,
      ];
    }),
  );

  const [types, accountRows, matched, owned] = await Promise.all([
    typeIndex(),
    db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
      })
      .from(resources)
      .where(
        and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt), textMatch),
      )
      .limit(OFFBOARDING_RESOURCE_SCAN_LIMIT + 1),
    subject.userIds.length === 0
      ? []
      : db
          .select({
            resourceId: resourceOwnership.resourceId,
            accountId: resourceOwnership.accountId,
            pluginId: resourceOwnership.pluginId,
            resourceTypeId: resourceOwnership.resourceTypeId,
            resourceName: resourceOwnership.resourceName,
            ownerUserId: resourceOwnership.ownerUserId,
          })
          .from(resourceOwnership)
          .where(
            and(
              eq(resourceOwnership.organizationId, organizationId),
              inArray(resourceOwnership.ownerUserId, subject.userIds),
            ),
          ),
  ]);
  const accountNames = new Map(accountRows.map((a) => [a.id, a.displayName]));
  const truncated = matched.length > OFFBOARDING_RESOURCE_SCAN_LIMIT;

  const candidateFor = (
    row: {
      id: string;
      pluginId: string;
      resourceTypeId: string;
      accountId: string;
      displayName: string;
    },
    match: { confidence: IdentityMatch["confidence"]; reason: string },
    extraActions: OffboardingActionId[],
  ): OffboardingCandidate | null => {
    // A resource on a disconnected account has nothing to act on and nobody to ask.
    if (!accountNames.has(row.accountId)) return null;
    const info = types.get(`${row.pluginId}/${row.resourceTypeId}`);
    const principal = info?.principalActions != null;
    const ref: Record<string, string> = {
      resourceId: row.id,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
      accountId: row.accountId,
    };
    if (info?.revokeActionId) ref["revokeActionId"] = info.revokeActionId;
    return {
      key: `resource:${row.id}`,
      kind: principal ? "principal" : "resource",
      title: row.displayName,
      detail: info?.typeName ?? row.resourceTypeId,
      pluginId: row.pluginId,
      providerName: info?.pluginName ?? row.pluginId,
      accountId: row.accountId,
      accountName: accountNames.get(row.accountId) ?? null,
      resourceId: row.id,
      resourceTypeId: row.resourceTypeId,
      confidence: match.confidence,
      matchReason: match.reason,
      actions: [...(principal ? (info?.principalActions ?? []) : []), ...extraActions],
      ref,
    };
  };

  for (const row of matched.slice(0, OFFBOARDING_RESOURCE_SCAN_LIMIT)) {
    const byName = strongerMatch(
      ((m) => (m ? { ...m, where: "the name" } : null))(
        matchIdentityValue(row.displayName, identity),
      ),
      ((m) => (m ? { ...m, where: "the id" } : null))(
        row.externalId ? matchIdentityValue(row.externalId, identity) : null,
      ),
    );
    const byField = ((m) => (m ? { ...m, where: m.field ? `"${m.field}"` : "a field" } : null))(
      matchIdentityFields(row.fieldsJson, identity),
    );
    const best = strongerMatch(byName, byField);
    // The text prefilter is a substring search; only a whole-value match counts.
    if (!best) continue;
    const candidate = candidateFor(
      row,
      { confidence: best.confidence, reason: describeIdentityMatch(best, best.where) },
      // Something that names them but is not their access is handed on.
      types.get(`${row.pluginId}/${row.resourceTypeId}`)?.principalActions != null
        ? []
        : ["transfer-ownership"],
    );
    if (candidate) add(acc, candidate);
  }

  for (const row of owned) {
    if (!row.ownerUserId) continue;
    const candidate = candidateFor(
      {
        id: row.resourceId,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
        accountId: row.accountId,
        displayName: row.resourceName,
      },
      {
        confidence: row.ownerUserId === subject.primaryUserId ? "exact" : "alias",
        reason: "Recorded as the owner",
      },
      ["transfer-ownership"],
    );
    if (candidate) add(acc, candidate);
  }

  return { truncated };
}

// ---------------------------------------------------------------------------
// Paid seats
// ---------------------------------------------------------------------------

async function collectSeats(
  organizationId: string,
  identity: OffboardingIdentity,
  acc: Accumulator,
): Promise<void> {
  // Unscoped: offboarding is gated on `team:remove`, and a seat the caller's
  // cost scope hides is still a seat the person holds.
  const { seats } = await listSeats(organizationId, { unscoped: true, withoutRemediation: true });
  for (const seat of seats) {
    const byEmail = seat.email ? matchIdentityValue(seat.email, identity) : null;
    const byLogin = seat.login ? matchIdentityValue(seat.login, identity) : null;
    const byName = seat.name ? matchIdentityValue(seat.name, identity) : null;
    const best = strongerMatch(
      strongerMatch(
        byEmail ? { ...byEmail, where: "the seat's email" } : null,
        byLogin ? { ...byLogin, where: "the seat's login" } : null,
      ),
      byName ? { ...byName, where: "the seat's name" } : null,
    );
    if (!best) continue;
    const pending = seat.pendingRemovalOn !== null;
    add(acc, {
      key: `seat:${seat.id}`,
      kind: "seat",
      title: seat.product,
      detail: `${seat.seatType}${pending ? " · removal pending" : ""}`,
      pluginId: seat.pluginId,
      providerName: seat.pluginName,
      accountId: seat.accountId,
      accountName: seat.accountName,
      resourceId: null,
      resourceTypeId: seat.resource?.resourceTypeId ?? null,
      confidence: best.confidence,
      matchReason: describeIdentityMatch(best, best.where),
      actions: seat.removable && !pending ? ["remove-seat"] : [],
      ref: { seatId: seat.id },
    });
  }
}
