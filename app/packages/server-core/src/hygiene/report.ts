/**
 * Credential hygiene — the credentials an organization is carrying that it
 * probably should not be.
 *
 * Three questions, all answerable from Postgres we already own, with no
 * provider call and nothing to configure:
 *
 *  - **API keys nobody uses.** `api_keys.last_used_at` is stamped on every
 *    authentication, so this one is exact.
 *  - **SSH keys nothing references.** Evidence comes from `audit_logs` rows
 *    that name a key id.
 *  - **Members over-permissioned versus what they actually touch.** The role
 *    says what they may do; the audit log says what they did.
 *
 * The third is the one that needs care, and the care is this: **the audit log
 * only witnesses writes.** Reading a resource list or a cost graph leaves no
 * row, by design. So the report only ever draws "granted but unused"
 * conclusions about the permissions in `WITNESSED_PERMISSIONS`, and every
 * finding carries the window it was computed over. Saying nothing about
 * `resources:read` is correct; saying it looks unused would be confidently
 * wrong, and a governance report that is confidently wrong is worse than no
 * report at all.
 *
 * The second guard is the window itself. An org three days old has three days
 * of audit history, and "unused in 90 days" means nothing against it — so the
 * report measures how much history actually exists and refuses to draw the
 * unused-permission conclusion until there is enough of it.
 */
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "../db/client";
import { apiKeys, auditLogs, organizationMembers, roles, sshKeys, users } from "../db/schema";
import { expandPermission, hasPermission } from "../permissions/catalog";
import { isSystemRoleKey, systemRolePermissions } from "../permissions/system-roles";

import { WITNESSED_PERMISSIONS, permissionsExercised } from "./action-permissions";

/** Default activity window. Bounded by the route. */
export const DEFAULT_HYGIENE_WINDOW_DAYS = 90;
export const MIN_HYGIENE_WINDOW_DAYS = 7;
export const MAX_HYGIENE_WINDOW_DAYS = 365;

/**
 * Least audit history an org needs before "granted but never exercised" is
 * worth saying out loud.
 *
 * Thirty days is roughly one of everything: a monthly close, an on-call
 * rotation, a release train. Below that, a quiet fortnight looks identical to
 * a permission nobody needs, and the report would spend its credibility on
 * findings that evaporate.
 */
const MIN_HISTORY_DAYS_FOR_PERMISSION_FINDINGS = 30;

/**
 * How long an unused API key is merely new rather than forgotten. A key minted
 * this morning for a migration next week is not a finding.
 */
const NEW_KEY_GRACE_DAYS = 14;

export type HygieneSeverity = "high" | "medium" | "low";

export type HygieneFindingKind =
  | "api_key_never_used"
  | "api_key_idle"
  | "api_key_expired_not_revoked"
  | "api_key_wildcard_scope"
  | "api_key_unused_scopes"
  | "ssh_key_never_used"
  | "ssh_key_idle"
  | "member_unused_permissions";

export interface HygieneFinding {
  /** Stable across runs, so a UI can remember what has been looked at. */
  id: string;
  kind: HygieneFindingKind;
  severity: HygieneSeverity;
  /** One line naming the thing and the problem. */
  title: string;
  /** The evidence. */
  detail: string;
  /** What to do about it. */
  recommendation: string;
  entityType: "api-key" | "ssh-key" | "member";
  entityId: string;
  entityName: string;
  /** Structured facts for the table columns and `--json`. */
  facts: Record<string, string | number | boolean | null>;
}

export interface HygieneReport {
  generatedAt: string;
  /** The activity window findings were computed over. */
  windowDays: number;
  /**
   * Days of audit history the org actually has, or null when it has none.
   * Below {@link MIN_HISTORY_DAYS_FOR_PERMISSION_FINDINGS} the unused-permission
   * findings are withheld and {@link HygieneReport.permissionFindingsWithheld}
   * says so.
   */
  auditHistoryDays: number | null;
  /** True when there was not enough history to judge unused permissions. */
  permissionFindingsWithheld: boolean;
  findings: HygieneFinding[];
  counts: Record<HygieneSeverity | "total", number>;
}

const SEVERITY_ORDER: Record<HygieneSeverity, number> = { high: 0, medium: 1, low: 2 };

function clampWindow(days: number | undefined): number {
  if (!days || !Number.isFinite(days)) return DEFAULT_HYGIENE_WINDOW_DAYS;
  return Math.min(MAX_HYGIENE_WINDOW_DAYS, Math.max(MIN_HYGIENE_WINDOW_DAYS, Math.trunc(days)));
}

function daysSince(at: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
}

/** Build the whole report. Read-only; safe to call from a request. */
export async function buildHygieneReport(
  organizationId: string,
  opts: { windowDays?: number; now?: Date } = {},
): Promise<HygieneReport> {
  const now = opts.now ?? new Date();
  const windowDays = clampWindow(opts.windowDays);
  const since = new Date(now.getTime() - windowDays * 86_400_000);

  const [auditHistoryDays, keyFindings, sshFindings] = await Promise.all([
    measureAuditHistory(organizationId, now),
    apiKeyFindings(organizationId, since, now, windowDays),
    sshKeyFindings(organizationId, since, now, windowDays),
  ]);

  const enoughHistory =
    auditHistoryDays !== null && auditHistoryDays >= MIN_HISTORY_DAYS_FOR_PERMISSION_FINDINGS;
  const memberFindings = enoughHistory
    ? await memberPermissionFindings(organizationId, since, windowDays)
    : [];

  const findings = [...keyFindings, ...sshFindings, ...memberFindings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title),
  );

  const counts = { high: 0, medium: 0, low: 0, total: findings.length };
  for (const f of findings) counts[f.severity]++;

  return {
    generatedAt: now.toISOString(),
    windowDays,
    auditHistoryDays,
    permissionFindingsWithheld: !enoughHistory,
    findings,
    counts,
  };
}

/** Days between the org's oldest audit row and now; null when it has none. */
async function measureAuditHistory(organizationId: string, now: Date): Promise<number | null> {
  const [row] = await db
    .select({ oldest: auditLogs.createdAt })
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, organizationId))
    .orderBy(asc(auditLogs.createdAt))
    .limit(1);
  return row?.oldest ? daysSince(row.oldest, now) : null;
}

/* ------------------------------------------------------------------ *
 * API keys.
 * ------------------------------------------------------------------ */

async function apiKeyFindings(
  organizationId: string,
  since: Date,
  now: Date,
  windowDays: number,
): Promise<HygieneFinding[]> {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
      ownerEmail: users.email,
      ownerName: users.displayName,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.organizationId, organizationId), isNull(apiKeys.revokedAt)));

  // Which scopes each key has actually exercised, from the audit rows it
  // authored. `audit_logs.api_key_id` is stamped by the API-key auth path, so
  // this is the same kind of evidence the member finding uses.
  const exercisedByKey = await exercisedPermissionsByApiKey(organizationId, since);

  const findings: HygieneFinding[] = [];
  for (const key of rows) {
    const owner = key.ownerName ?? key.ownerEmail ?? "an unknown owner";
    const label = `${key.name} (${key.prefix}…)`;
    const scopes = Array.isArray(key.scopes) ? (key.scopes as string[]) : [];
    const base = {
      entityType: "api-key" as const,
      entityId: key.id,
      entityName: label,
    };

    if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) {
      findings.push({
        ...base,
        id: `api-key:${key.id}:expired`,
        kind: "api_key_expired_not_revoked",
        // It can no longer authenticate, so this is tidiness rather than
        // exposure — but a list full of dead keys is a list nobody reads.
        severity: "low",
        title: `Expired API key still listed: ${label}`,
        detail: `Expired ${daysSince(key.expiresAt, now)} days ago and has not been revoked. It can no longer authenticate.`,
        recommendation: "Revoke it so the key list reflects what is actually live.",
        facts: {
          owner,
          expiredDaysAgo: daysSince(key.expiresAt, now),
          scopes: scopes.join(", "),
        },
      });
      // An expired key cannot be idle in any meaningful sense; the other
      // findings would be noise on top of this one.
      continue;
    }

    if (scopes.includes("*")) {
      findings.push({
        ...base,
        id: `api-key:${key.id}:wildcard`,
        kind: "api_key_wildcard_scope",
        severity: "high",
        title: `API key with unrestricted scope: ${label}`,
        detail: `Held by ${owner} with the \`*\` scope, so it can do anything its owner can — including deleting resources and reading credentials.`,
        recommendation:
          "Re-mint it with the specific scopes the integration needs. A key is bounded by its owner's role, but `*` means it inherits every widening of that role too.",
        facts: { owner, scopes: "*", lastUsedAt: key.lastUsedAt?.toISOString() ?? null },
      });
    }

    if (!key.lastUsedAt) {
      if (daysSince(key.createdAt, now) >= NEW_KEY_GRACE_DAYS) {
        findings.push({
          ...base,
          id: `api-key:${key.id}:never-used`,
          kind: "api_key_never_used",
          severity: "medium",
          title: `API key never used: ${label}`,
          detail: `Created ${daysSince(key.createdAt, now)} days ago by ${owner} and has never authenticated.`,
          recommendation:
            "Revoke it. A credential that has never been used is one nobody will notice the loss of — in either direction.",
          facts: {
            owner,
            createdDaysAgo: daysSince(key.createdAt, now),
            scopes: scopes.join(", "),
          },
        });
      }
      continue;
    }

    if (key.lastUsedAt.getTime() < since.getTime()) {
      findings.push({
        ...base,
        id: `api-key:${key.id}:idle`,
        kind: "api_key_idle",
        severity: "medium",
        title: `API key unused for ${daysSince(key.lastUsedAt, now)} days: ${label}`,
        detail: `Held by ${owner}; last authenticated ${key.lastUsedAt.toISOString().slice(0, 10)}.`,
        recommendation:
          "Revoke it, or find out what stopped calling. Either answer is better than the current one.",
        facts: {
          owner,
          idleDays: daysSince(key.lastUsedAt, now),
          scopes: scopes.join(", "),
        },
      });
      continue;
    }

    // Only worth saying for a key that IS being used: an idle key's unused
    // scopes are already covered by the idle finding.
    const exercised = exercisedByKey.get(key.id) ?? [];
    const unused = witnessedButUnused(scopes, exercised);
    if (unused.length > 0 && !scopes.includes("*")) {
      findings.push({
        ...base,
        id: `api-key:${key.id}:unused-scopes`,
        kind: "api_key_unused_scopes",
        severity: "low",
        title: `API key carries ${unused.length} scope${unused.length === 1 ? "" : "s"} it never uses: ${label}`,
        detail:
          `In the last ${windowDays} days this key exercised ${exercised.length || "none"} of its ` +
          `write scopes. Unused: ${unused.join(", ")}.`,
        recommendation:
          "Narrow the key to what it actually calls. Only write-shaped scopes are judged here — reads leave no audit trail, so nothing is concluded about them.",
        facts: { owner, unusedScopes: unused.join(", "), windowDays },
      });
    }
  }

  return findings;
}

/** Permissions each API key demonstrated in the window, from its audit rows. */
async function exercisedPermissionsByApiKey(
  organizationId: string,
  since: Date,
): Promise<Map<string, string[]>> {
  const rows = await db
    .selectDistinct({ apiKeyId: auditLogs.apiKeyId, action: auditLogs.action })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        gte(auditLogs.createdAt, since),
        sql`${auditLogs.apiKeyId} is not null`,
      ),
    );

  const actionsByKey = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.apiKeyId) continue;
    const list = actionsByKey.get(row.apiKeyId);
    if (list) list.push(row.action);
    else actionsByKey.set(row.apiKeyId, [row.action]);
  }
  return new Map([...actionsByKey].map(([id, actions]) => [id, permissionsExercised(actions)]));
}

/* ------------------------------------------------------------------ *
 * SSH keys.
 * ------------------------------------------------------------------ */

async function sshKeyFindings(
  organizationId: string,
  since: Date,
  now: Date,
  windowDays: number,
): Promise<HygieneFinding[]> {
  const rows = await db
    .select({
      id: sshKeys.id,
      name: sshKeys.name,
      isImported: sshKeys.isImported,
      hasPrivateKey: sql<boolean>`(${sshKeys.encryptedPrivateKey} is not null)`,
      createdAt: sshKeys.createdAt,
      ownerEmail: users.email,
      ownerName: users.displayName,
    })
    .from(sshKeys)
    .leftJoin(users, eq(sshKeys.userId, users.id))
    .where(eq(sshKeys.organizationId, organizationId));
  if (rows.length === 0) return [];

  const lastUse = await sshKeyLastUse(organizationId, since);

  const findings: HygieneFinding[] = [];
  for (const key of rows) {
    // A key created inside the window has not had a fair chance to be used.
    if (key.createdAt.getTime() > since.getTime()) continue;

    const usedAt = lastUse.get(key.id);
    if (usedAt) continue;

    const owner = key.ownerName ?? key.ownerEmail ?? "an unknown owner";
    // A key whose private half we hold is a live credential sitting in our
    // database; one that was imported public-only is a much smaller thing.
    const severity: HygieneSeverity = key.hasPrivateKey ? "medium" : "low";
    findings.push({
      entityType: "ssh-key",
      entityId: key.id,
      entityName: key.name,
      id: `ssh-key:${key.id}:unused`,
      kind: "ssh_key_never_used",
      severity,
      title: `SSH key unused for at least ${windowDays} days: ${key.name}`,
      detail:
        `Held by ${owner}, added ${key.createdAt.toISOString().slice(0, 10)}. ` +
        (key.hasPrivateKey
          ? "Its private half is stored server-side, so this is a live credential nobody is using."
          : "Public key only.") +
        " Recorded uses cover terminal sessions, fan-out runs, agent forwarding and the ssh_exec tool.",
      recommendation:
        "Delete it, or remove the corresponding entry from the hosts' authorized_keys. Deleting it here does not revoke it on the host.",
      facts: {
        owner,
        addedDaysAgo: daysSince(key.createdAt, now),
        privateKeyStored: key.hasPrivateKey,
        imported: key.isImported,
      },
    });
  }
  return findings;
}

/**
 * When each SSH key was last used, from audit rows that name one.
 *
 * `metadata->>'sshKeyId'` is the shared shape across `ssh.session.opened`,
 * `ssh.fanout.run`, `ssh.exec` and `ssh.agent.session_opened` — every path
 * that dials with an org key. There is no column to index here, so this is a
 * scan of the org's window rather than a lookup; the report is a periodic
 * review rather than a hot path, and the alternative (denormalizing a
 * `last_used_at` onto `ssh_keys` and writing it on every connect) buys speed
 * this does not need at the cost of a write on the terminal's critical path.
 */
async function sshKeyLastUse(organizationId: string, since: Date): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      sshKeyId: sql<string>`${auditLogs.metadata}->>'sshKeyId'`,
      usedAt: sql<Date>`max(${auditLogs.createdAt})`,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        gte(auditLogs.createdAt, since),
        sql`${auditLogs.metadata}->>'sshKeyId' is not null`,
      ),
    )
    .groupBy(sql`${auditLogs.metadata}->>'sshKeyId'`);

  const out = new Map<string, Date>();
  for (const row of rows) {
    if (row.sshKeyId) out.set(row.sshKeyId, new Date(row.usedAt));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Members.
 * ------------------------------------------------------------------ */

/**
 * Write-shaped permissions a principal was granted but never demonstrated.
 *
 * Restricted to {@link WITNESSED_PERMISSIONS} on both sides: a permission the
 * audit log cannot see is neither counted as granted nor reported as unused,
 * because its absence proves nothing.
 */
function witnessedButUnused(granted: readonly string[], exercised: readonly string[]): string[] {
  const expanded = new Set(granted.flatMap((entry) => expandPermission(entry)));
  return WITNESSED_PERMISSIONS.filter((p) => expanded.has(p) && !hasPermission(exercised, p));
}

async function memberPermissionFindings(
  organizationId: string,
  since: Date,
  windowDays: number,
): Promise<HygieneFinding[]> {
  const members = await db
    .select({
      userId: organizationMembers.userId,
      legacyRole: organizationMembers.role,
      roleId: roles.id,
      roleName: roles.name,
      roleIsSystem: roles.isSystem,
      roleSystemKey: roles.systemKey,
      rolePermissions: roles.permissions,
      email: users.email,
      displayName: users.displayName,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .leftJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  if (members.length === 0) return [];

  const exercisedByUser = await exercisedPermissionsByUser(organizationId, since);

  const findings: HygieneFinding[] = [];
  for (const member of members) {
    const systemKey = isSystemRoleKey(member.roleSystemKey)
      ? member.roleSystemKey
      : isSystemRoleKey(member.legacyRole)
        ? member.legacyRole
        : null;
    // Owners are skipped on purpose. An organization must have at least one,
    // the role is `*` by definition, and "the owner did not exercise
    // billing:write this quarter" is not a finding anybody can act on. Every
    // other role — admin, member, custom — is fair game.
    if (systemKey === "owner") continue;

    const granted =
      member.roleIsSystem && systemKey
        ? (systemRolePermissions(systemKey) ?? [])
        : (member.rolePermissions ?? (systemKey ? (systemRolePermissions(systemKey) ?? []) : []));
    if (granted.length === 0) continue;

    const exercised = exercisedByUser.get(member.userId) ?? [];
    const unused = witnessedButUnused(granted, exercised);
    const grantedWitnessed = witnessedButUnused(granted, []).length;
    // Nothing to say when they used everything the log can see, or when their
    // role grants nothing the log can see in the first place.
    if (unused.length === 0 || grantedWitnessed === 0) continue;

    const name = member.displayName ?? member.email ?? member.userId;
    const roleName = member.roleName ?? systemKey ?? "their role";
    // Using none of a broad grant is a different conversation from using most
    // of it, so the severity follows the ratio rather than the raw count.
    const unusedRatio = unused.length / grantedWitnessed;
    const severity: HygieneSeverity = unusedRatio === 1 && grantedWitnessed >= 5 ? "medium" : "low";

    findings.push({
      entityType: "member",
      entityId: member.userId,
      entityName: name,
      id: `member:${member.userId}:unused-permissions`,
      kind: "member_unused_permissions",
      severity,
      title: `${name} has not used ${unused.length} of ${grantedWitnessed} write permissions ${roleName} grants`,
      detail:
        `Over the last ${windowDays} days: ${exercised.length} exercised, ` +
        `${unused.length} never seen — ${unused.slice(0, 8).join(", ")}` +
        `${unused.length > 8 ? `, and ${unused.length - 8} more` : ""}.`,
      recommendation:
        "Consider a narrower role, with break-glass access for the occasional exception. Only write-shaped permissions are judged: reads leave no audit trail, so nothing here says anything about what they can see.",
      facts: {
        role: roleName,
        exercised: exercised.join(", "),
        unused: unused.join(", "),
        windowDays,
      },
    });
  }
  return findings;
}

/** Permissions each member demonstrated in the window. */
async function exercisedPermissionsByUser(
  organizationId: string,
  since: Date,
): Promise<Map<string, string[]>> {
  const rows = await db
    .selectDistinct({ userId: auditLogs.userId, action: auditLogs.action })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        gte(auditLogs.createdAt, since),
        sql`${auditLogs.userId} is not null`,
        // A key's actions are the key's evidence, not the owner's — they may
        // have been minted long ago and be firing from a cron nobody watches.
        isNull(auditLogs.apiKeyId),
      ),
    );

  const actionsByUser = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.userId) continue;
    const list = actionsByUser.get(row.userId);
    if (list) list.push(row.action);
    else actionsByUser.set(row.userId, [row.action]);
  }
  return new Map([...actionsByUser].map(([id, actions]) => [id, permissionsExercised(actions)]));
}
