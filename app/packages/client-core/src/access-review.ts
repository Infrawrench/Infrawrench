/**
 * Cross-cloud access review — the principals that live *inside the customer's
 * clouds*: IAM users and roles, GCP service accounts, Azure app registrations
 * and managed identities, directory users and groups, role bindings, and the
 * long-lived API keys providers hand out.
 *
 * Three adjacent things this is deliberately **not**:
 *
 * - Infrawrench's own team roles and permissions — who can use Infrawrench.
 * - Credential hygiene — the API keys, SSH keys and unused member permissions
 *   *Infrawrench itself* holds, computed from Postgres we own.
 * - Posture checks — per-resource exposure rules over any resource type.
 *
 * Plugins mark principal types with `principalRole`
 * (`PrincipalRoleDeclaration` in `@infrawrench/plugin-base`) and this module is
 * the shared pure half that turns stored rows + those declarations into the
 * review every surface renders. Rows in, findings out: no plugin client, no
 * credentials, no provider API calls, ever — the `orphanRule` / expiry-radar /
 * posture contract.
 *
 * Findings have no identity of their own — they are recomputed from scratch on
 * every read — so an operator's decision to accept one is stored against
 * `(resourceId, ruleId)` and applied here, at the end of the computation. A
 * dismissed finding is still evaluated; it is only *partitioned* out of the
 * list, so accepting a risk stays reviewable and reversible rather than being
 * a delete. That is the same mechanism the posture screen uses, down to the
 * key, which is why both share one dismissal store.
 *
 * **The load-bearing honesty rule: absent evidence is `unknown`, never
 * "stale".** A principal whose type declares no `lastUsedKey`, or whose stored
 * value is empty or unparseable, has `lastUsedAt: null` and `activity:
 * "unknown"`, and can never produce a stale finding. Half the providers here
 * cannot tell us when a key was last used without a second API call this
 * feature refuses to make, and a review that guessed would spend its first
 * week teaching people to ignore it.
 *
 * The plugin-base import is type-only on purpose (the expiry radar's stance):
 * this module must stay free of a *runtime* dependency on plugin-base so the
 * mobile bundle doesn't pull in zod for the sake of a few interfaces. The key
 * defaults are therefore restated here and asserted against plugin-base's
 * exported constants by a test.
 */
import type { PrincipalRole, PrincipalRoleDeclaration } from "@infrawrench/plugin-base";

import type { ExpiryListResponse } from "./expiry";
import type { CloudFetch } from "./fetch";
import type { ResourceOwnerAnnotation } from "./ownership";

export type { PrincipalRole, PrincipalRoleDeclaration } from "@infrawrench/plugin-base";

/**
 * How bad a finding is. Structurally the posture scale, declared separately on
 * purpose: two sibling modules under one barrel re-exporting the same name
 * makes `export *` ambiguous and the dts rollup drops it (the `ShowbackReport`
 * incident).
 */
export type AccessReviewSeverity = "critical" | "high" | "medium" | "low";

/** Severities in escalation order, worst first. */
export const ACCESS_REVIEW_SEVERITIES: readonly AccessReviewSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

/** Human labels for the severity buckets, shared by every surface. */
export const ACCESS_REVIEW_SEVERITY_LABELS: Record<AccessReviewSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Human labels for the principal roles, shared by every surface. */
export const PRINCIPAL_ROLE_LABELS: Record<PrincipalRole, string> = {
  user: "User",
  group: "Group",
  role: "Role",
  "service-account": "Service account",
  key: "Key",
  binding: "Binding",
};

/**
 * The rules the review can raise. Stable strings — they are half of a
 * dismissal's key, so renaming one silently un-dismisses every decision made
 * against it.
 *
 * The `access-review:` prefix is what keeps them from colliding with
 * plugin-declared posture rule ids in the shared `posture_dismissals` table; a
 * registry test asserts no plugin claims the namespace.
 */
export const ACCESS_REVIEW_RULE_IDS = {
  /** Last used longer ago than the review's staleness window. */
  stale: "access-review:stale-principal",
  /** Holds administrative or wildcard permissions. */
  admin: "access-review:admin-principal",
  /** A key whose rotation budget (from the expiry radar) has run out. */
  rotation: "access-review:key-past-rotation",
  /** Nobody is recorded as owning it. */
  unowned: "access-review:no-recorded-owner",
  /** A user identity with multi-factor authentication switched off. */
  noMfa: "access-review:no-mfa",
} as const;

/** One rule's id. */
export type AccessReviewRuleId =
  (typeof ACCESS_REVIEW_RULE_IDS)[keyof typeof ACCESS_REVIEW_RULE_IDS];

/**
 * What the review could establish about a principal's last use.
 *
 * `unknown` is a first-class answer, not a failure: it means the type declares
 * no last-used field, or the lister stored nothing parseable. It never becomes
 * `stale`.
 */
export type PrincipalActivity = "active" | "stale" | "unknown";

/** Default staleness window. Overridable per request; see `ACCESS_REVIEW_STALE_DAY_OPTIONS`. */
export const DEFAULT_ACCESS_REVIEW_STALE_DAYS = 90;

/** The windows every surface offers, so the switcher and the API agree. */
export const ACCESS_REVIEW_STALE_DAY_OPTIONS: readonly number[] = [30, 90, 180, 365];

/** Hard bounds on `staleDays`, enforced by the API and the clients alike. */
export const ACCESS_REVIEW_STALE_DAYS_MIN = 1;
export const ACCESS_REVIEW_STALE_DAYS_MAX = 3650;

/** Field key a `principalRole` reads for last use when it names none. */
export const DEFAULT_PRINCIPAL_LAST_USED_KEY = "lastUsedAt";
/** Field key a `principalRole` reads for creation when it names none. */
export const DEFAULT_PRINCIPAL_CREATED_KEY = "createdAt";

/**
 * One principal in the review, with everything the row renders and everything
 * the findings were computed from.
 */
export interface AccessPrincipal {
  /** Infrawrench resource id. */
  resourceId: string;
  pluginId: string;
  /** Plugin display name, e.g. "AWS". */
  pluginName: string;
  resourceTypeId: string;
  /** Display name of the resource type, e.g. "IAM User". */
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  displayName: string;
  /** Provider-native id, when known. */
  externalId: string | null;
  role: PrincipalRole;
  /** ISO instant of last use, or null when the review has no evidence. */
  lastUsedAt: string | null;
  /** Whole days since `lastUsedAt`; null when unknown. */
  daysSinceLastUsed: number | null;
  activity: PrincipalActivity;
  /** ISO instant the principal was created, or null when not synced. */
  createdAt: string | null;
  /** Whole days since `createdAt`; null when unknown. */
  ageDays: number | null;
  /** True when the admin indicator matched. Null when the type declares none. */
  admin: boolean | null;
  /**
   * MFA state: true/false only where the type declares an `mfaKey`, null
   * everywhere else — "we do not sync that" is not "MFA is off".
   */
  mfa: boolean | null;
  /** The principal this one hangs off (a key's owner, a binding's subject). */
  parent: string | null;
  /** Who owns it, from the resource-ownership join. Null when nobody is named. */
  owner: ResourceOwnerAnnotation | null;
  /**
   * `actionId` the type declares as its revoke action, or null. The surface
   * dispatches it through the ordinary invoke-action path.
   */
  revokeActionId: string | null;
}

/** One rule raised against one principal. A principal can carry several. */
export interface AccessFinding {
  /** Infrawrench resource id — the first half of a dismissal's key. */
  resourceId: string;
  ruleId: AccessReviewRuleId;
  /** Short rule title, e.g. "Unused for 90+ days". */
  title: string;
  severity: AccessReviewSeverity;
  /** Why this principal is flagged, in a sentence a reviewer can act on. */
  reason: string;
  /** The principal the finding is about, denormalized so a row renders alone. */
  principal: AccessPrincipal;
}

/**
 * An operator's decision to accept one finding on one principal — the break-glass
 * role really is meant to be admin, the shared key really is rotated out of band.
 *
 * Keyed by `(resourceId, ruleId)` rather than by a finding row, because a
 * finding is recomputed from scratch on every read and has no identity of its
 * own. Both halves are stable: resource ids come from the plugin's lister and
 * rule ids are constants in this module.
 */
export interface AccessReviewDismissal {
  resourceId: string;
  ruleId: string;
  /** ISO instant the dismissal was recorded. */
  dismissedAt: string;
  /** Who accepted it — display name or email; null when unknown. */
  dismissedBy: string | null;
  /** The operator's note, when they left one. */
  reason: string | null;
}

/** A finding that matched, and the dismissal holding it off the list. */
export interface DismissedAccessFinding extends AccessFinding {
  dismissal: AccessReviewDismissal;
}

/** Wire shape of `GET /api/org/:orgId/access-review`. */
export interface AccessReviewResponse {
  /** Every synced principal, worst-flagged first. Never filtered by dismissals. */
  principals: AccessPrincipal[];
  /** Live findings, worst severity first. Dismissed ones are **not** here. */
  findings: AccessFinding[];
  /** `findings.length`. */
  totalCount: number;
  /** Live finding count per severity; every bucket present, zeros included. */
  counts: Record<AccessReviewSeverity, number>;
  /** Live finding count per rule; every rule present, zeros included. */
  byRule: Record<AccessReviewRuleId, number>;
  /** Principal count per role; every role present, zeros included. */
  byRole: Record<PrincipalRole, number>;
  /**
   * Findings a dismissal is currently suppressing, most recently dismissed
   * first. Only dismissals whose rule still matches appear.
   */
  dismissed: DismissedAccessFinding[];
  /** `dismissed.length`, so a caller can badge the count without the rows. */
  dismissedCount: number;
  /**
   * How many principals the review could establish no last-use evidence for.
   * Rendered on every surface: "we found nothing" and "we could not look" must
   * not read the same.
   */
  unknownActivityCount: number;
  /** The staleness window this review was computed against, in days. */
  staleDays: number;
  generatedAt: string;
}

/** The part of a resource type definition the scan reads. */
export interface AccessScanResourceType {
  id: string;
  displayName: string;
  principalRole?: PrincipalRoleDeclaration | undefined;
}

/** The part of a loaded plugin the scan reads. */
export interface AccessScanPlugin {
  id: string;
  displayName: string;
  resourceTypes: readonly AccessScanResourceType[];
}

/** The part of an account row the scan reads. */
export interface AccessScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/**
 * The part of a stored resource row the scan reads. Hosts map their own store
 * onto this — Postgres jsonb, SQLite TEXT bags — so the computation never
 * learns which database it is looking at.
 */
export interface AccessScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  /** The instance's stored `fields` bag; a missing/!object bag reads as empty. */
  fields: unknown;
}

export interface AccessScanInput {
  plugins: readonly AccessScanPlugin[];
  accounts: readonly AccessScanAccount[];
  resources: readonly AccessScanResource[];
  /**
   * Who owns each resource, keyed by resource id — the resource-ownership
   * join. Omitted means "no owner records", which produces an unowned finding
   * for every principal; hosts that have no ownership store should pass an
   * empty map and suppress the rule instead (see `includeUnowned`).
   */
  owners?: ReadonlyMap<string, ResourceOwnerAnnotation> | undefined;
  /**
   * Accepted findings, keyed by `(resourceId, ruleId)`. Omitted means none —
   * the safe direction: unknown dismissals show the finding rather than hide
   * it.
   */
  dismissals?: readonly AccessReviewDismissal[] | undefined;
}

export interface AccessScanOptions {
  /** Scan instant; defaults to `Date.now()`. */
  now?: number;
  /** Staleness window in days. Defaults to {@link DEFAULT_ACCESS_REVIEW_STALE_DAYS}. */
  staleDays?: number;
  /**
   * The org's expiry feed over the same rows. Key-rotation findings are taken
   * from it rather than recomputed: the expiry radar already owns "this
   * credential is past its rotation budget", complete with each plugin's own
   * budget, and a second implementation here would drift from it.
   *
   * Passed in rather than computed inside for the reason the posture module
   * takes `dns`: it is a different scan over the same rows, and every other
   * rule here is a pure per-principal predicate.
   */
  expiry?: ExpiryListResponse;
  /**
   * Whether to raise the "no recorded owner" rule. Hosts with no ownership
   * store pass `false` — flagging every principal as unowned when the concept
   * does not exist would be a lie, not a finding. Defaults to true.
   */
  includeUnowned?: boolean;
}

const MS_PER_DAY = 86_400_000;

const SEVERITY_RANK: Record<AccessReviewSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TRUE_WORDS = new Set(["true", "1", "yes", "enabled", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "disabled", "off"]);

/**
 * Parse a stored field value as a point in time, epoch milliseconds — the same
 * tolerance as the expiry radar's `parseExpiryInstant` and the posture
 * module's `parseInstant`. Anything unparseable is null, which is what keeps
 * a garbled timestamp out of the stale bucket. Small numbers (< 1e8) are
 * rejected rather than guessed at, so a port or a count never reads as a date.
 */
function parseInstant(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1e8) return null;
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseInstant(Number(trimmed));
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  // Go-style timestamps carry a zone name after the numeric offset that
  // Date.parse rejects.
  const goStyle = trimmed.replace(/ [A-Z]{3,4}$/, "");
  if (goStyle !== trimmed) {
    const reparsed = Date.parse(goStyle);
    if (!Number.isNaN(reparsed)) return reparsed;
  }
  return null;
}

/**
 * Read a declared boolean-ish field. Returns null for absent and for strings
 * outside the known word lists — an unrecognised value must not be read as
 * `false` and turned into an accusation.
 */
function readFlag(raw: unknown): boolean | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return null;
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

/** Read a declared string field, trimmed; empty and absent both read as null. */
function readText(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  return text === "" ? null : text;
}

/**
 * Whether a principal's admin indicator says "administrative".
 *
 * With `adminValues` the whole stored value is compared case-insensitively
 * against the list — not a substring match. That is the `sourceRanges equals
 * "0.0.0.0/0"` stance the posture rules already take: matching a fragment of a
 * comma-joined list would call a role with `widgets:read` administrative
 * because some other entry happened to contain `admin`. Without
 * `adminValues` the field is read as a boolean.
 *
 * Returns null when the type declares no indicator — "we do not know", which
 * never becomes a finding.
 */
function readAdmin(
  fields: Record<string, unknown>,
  indicatorKey: string | null,
  adminValues: readonly string[] | null,
): boolean | null {
  if (!indicatorKey) return null;
  const raw = fields[indicatorKey];
  if (raw == null || raw === "") return null;
  if (!adminValues) return readFlag(raw);
  const actual = String(raw).trim().toLowerCase();
  return adminValues.some((v) => v.trim().toLowerCase() === actual);
}

/**
 * The identity of a finding, and therefore of a dismissal: the principal it is
 * on and the rule that matched. Every surface keys rows, dismissal lookups and
 * API calls off this one function.
 *
 * NUL is the separator for the reason `postureFindingKey` uses it: neither
 * half is length-prefixed and both can contain punctuation, so any printable
 * delimiter could be forged into a collision.
 */
export function accessFindingKey(finding: { resourceId: string; ruleId: string }): string {
  return `${finding.resourceId}\u0000${finding.ruleId}`;
}

/** Clamp a requested staleness window into the documented bounds. */
export function normalizeStaleDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ACCESS_REVIEW_STALE_DAYS;
  const rounded = Math.round(value);
  if (rounded < ACCESS_REVIEW_STALE_DAYS_MIN) return ACCESS_REVIEW_STALE_DAYS_MIN;
  if (rounded > ACCESS_REVIEW_STALE_DAYS_MAX) return ACCESS_REVIEW_STALE_DAYS_MAX;
  return rounded;
}

function emptyCounts(): Record<AccessReviewSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

function emptyByRule(): Record<AccessReviewRuleId, number> {
  return {
    [ACCESS_REVIEW_RULE_IDS.stale]: 0,
    [ACCESS_REVIEW_RULE_IDS.admin]: 0,
    [ACCESS_REVIEW_RULE_IDS.rotation]: 0,
    [ACCESS_REVIEW_RULE_IDS.unowned]: 0,
    [ACCESS_REVIEW_RULE_IDS.noMfa]: 0,
  };
}

function emptyByRole(): Record<PrincipalRole, number> {
  return { user: 0, group: 0, role: 0, "service-account": 0, key: 0, binding: 0 };
}

/** An empty review, for hosts that need a placeholder before the first load. */
export function emptyAccessReview(
  staleDays = DEFAULT_ACCESS_REVIEW_STALE_DAYS,
  now = Date.now(),
): AccessReviewResponse {
  return {
    principals: [],
    findings: [],
    totalCount: 0,
    counts: emptyCounts(),
    byRule: emptyByRule(),
    byRole: emptyByRole(),
    dismissed: [],
    dismissedCount: 0,
    unknownActivityCount: 0,
    staleDays,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Build the principal rows for a workspace: every stored resource whose type
 * declares `principalRole`, with its activity, age, admin flag, MFA state,
 * parent and owner resolved from already-synced fields.
 *
 * Exported because the CSV/JSON export and the findings both read it, and
 * because it is the half worth testing without any rule logic in the way.
 */
export function collectAccessPrincipals(
  input: AccessScanInput,
  options: AccessScanOptions = {},
): AccessPrincipal[] {
  const now = options.now ?? Date.now();
  const staleDays = normalizeStaleDays(options.staleDays);
  const owners = input.owners;

  // pluginId → { pluginName, types: typeId → { typeName, declaration } }
  const index = new Map<
    string,
    {
      pluginName: string;
      types: Map<string, { typeName: string; declaration: PrincipalRoleDeclaration }>;
    }
  >();
  for (const plugin of input.plugins) {
    const types = new Map<string, { typeName: string; declaration: PrincipalRoleDeclaration }>();
    for (const type of plugin.resourceTypes) {
      if (type.principalRole)
        types.set(type.id, { typeName: type.displayName, declaration: type.principalRole });
    }
    if (types.size > 0) index.set(plugin.id, { pluginName: plugin.displayName, types });
  }
  if (index.size === 0) return [];

  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const principals: AccessPrincipal[] = [];

  for (const r of input.resources) {
    const pluginEntry = index.get(r.pluginId);
    const typeEntry = pluginEntry?.types.get(r.resourceTypeId);
    if (!pluginEntry || !typeEntry) continue;
    // A resource whose account is gone is not a principal anybody can act on.
    const account = accountMap.get(r.accountId);
    if (!account) continue;

    const fields =
      r.fields && typeof r.fields === "object" && !Array.isArray(r.fields)
        ? (r.fields as Record<string, unknown>)
        : {};
    const d = typeEntry.declaration;
    const lastUsedKey = d.lastUsedKey ?? DEFAULT_PRINCIPAL_LAST_USED_KEY;
    const createdKey = d.createdKey ?? DEFAULT_PRINCIPAL_CREATED_KEY;

    const lastUsedMs = parseInstant(fields[lastUsedKey]);
    const createdMs = parseInstant(fields[createdKey]);
    const daysSinceLastUsed =
      lastUsedMs === null ? null : Math.floor((now - lastUsedMs) / MS_PER_DAY);
    // `unknown` is the answer whenever there is no parseable evidence. It is
    // never promoted to `stale`, however old the principal is.
    const activity: PrincipalActivity =
      daysSinceLastUsed === null ? "unknown" : daysSinceLastUsed >= staleDays ? "stale" : "active";

    principals.push({
      resourceId: r.id,
      pluginId: r.pluginId,
      pluginName: pluginEntry.pluginName,
      resourceTypeId: r.resourceTypeId,
      resourceTypeName: typeEntry.typeName,
      accountId: r.accountId,
      accountName: account.displayName,
      displayName: r.displayName,
      externalId: r.externalId,
      role: d.role,
      lastUsedAt: lastUsedMs === null ? null : new Date(lastUsedMs).toISOString(),
      daysSinceLastUsed,
      activity,
      createdAt: createdMs === null ? null : new Date(createdMs).toISOString(),
      ageDays: createdMs === null ? null : Math.floor((now - createdMs) / MS_PER_DAY),
      admin: readAdmin(fields, d.adminIndicatorKey ?? null, d.adminValues ?? null),
      mfa: d.mfaKey ? readFlag(fields[d.mfaKey]) : null,
      parent: d.parentKey ? readText(fields[d.parentKey]) : null,
      owner: owners?.get(r.id) ?? null,
      revokeActionId: d.revokeActionId ?? null,
    });
  }

  principals.sort(
    (a, b) =>
      a.accountName.localeCompare(b.accountName) ||
      a.resourceTypeName.localeCompare(b.resourceTypeName) ||
      a.displayName.localeCompare(b.displayName) ||
      a.resourceId.localeCompare(b.resourceId),
  );
  return principals;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * The rules, in one place, each raised only when it has evidence.
 *
 * - **stale** — a *known* last use older than the window. Never raised on
 *   `unknown`.
 * - **admin** — the declared indicator matched. Never raised where the type
 *   declares none.
 * - **rotation** — taken from the expiry radar, not recomputed here.
 * - **unowned** — no ownership record names anybody.
 * - **noMfa** — the declared `mfaKey` read false. Never raised on null.
 */
function findingsFor(
  principal: AccessPrincipal,
  staleDays: number,
  rotationDue: Map<string, { label: string; daysRemaining: number }>,
  includeUnowned: boolean,
): AccessFinding[] {
  const out: AccessFinding[] = [];
  const where = `${principal.resourceTypeName} "${principal.displayName}" in ${principal.accountName}`;

  if (principal.activity === "stale" && principal.daysSinceLastUsed !== null) {
    out.push({
      resourceId: principal.resourceId,
      ruleId: ACCESS_REVIEW_RULE_IDS.stale,
      title: `Unused for ${staleDays}+ days`,
      // An admin principal nobody has touched in months is the combination
      // that actually gets exploited, so it pages a level higher.
      severity: principal.admin === true ? "high" : "medium",
      reason:
        `${where} was last used ${plural(principal.daysSinceLastUsed, "day")} ago. ` +
        `Standing access nobody exercises is access nobody notices being abused — revoke it, ` +
        `or record why it has to stay.`,
      principal,
    });
  }

  if (principal.admin === true) {
    out.push({
      resourceId: principal.resourceId,
      ruleId: ACCESS_REVIEW_RULE_IDS.admin,
      title: "Administrative or wildcard permissions",
      severity: "high",
      reason:
        `${where} holds administrative or wildcard permissions. Confirm it still needs them, ` +
        `and that the people who can use it are the people you would name if asked.`,
      principal,
    });
  }

  const rotation = rotationDue.get(principal.resourceId);
  if (rotation) {
    out.push({
      resourceId: principal.resourceId,
      ruleId: ACCESS_REVIEW_RULE_IDS.rotation,
      title: "Past its rotation budget",
      severity: rotation.daysRemaining < -180 ? "high" : "medium",
      reason:
        `${where} is ${plural(Math.abs(rotation.daysRemaining), "day")} past the rotation ` +
        `budget its provider plugin declares (${rotation.label}). Rotate it, or shorten the ` +
        `budget if this one is genuinely meant to be long-lived.`,
      principal,
    });
  }

  if (includeUnowned && principal.owner === null) {
    out.push({
      resourceId: principal.resourceId,
      ruleId: ACCESS_REVIEW_RULE_IDS.unowned,
      title: "No recorded owner",
      severity: "low",
      reason:
        `Nobody is recorded as owning ${where}. An access review is only as good as its ` +
        `ability to ask somebody "do you still need this?" — record an owner on the resource.`,
      principal,
    });
  }

  if (principal.mfa === false) {
    out.push({
      resourceId: principal.resourceId,
      ruleId: ACCESS_REVIEW_RULE_IDS.noMfa,
      title: "No multi-factor authentication",
      severity: principal.admin === true ? "critical" : "high",
      reason: `${where} signs in without a second factor. A stolen password is the whole account.`,
      principal,
    });
  }

  return out;
}

/**
 * Which principals the expiry radar says are past a rotation budget.
 *
 * Only `basis: "age"` items count: those are the radar's `from: "created"`
 * rules, i.e. "this credential has been alive too long". An absolute
 * `expiresAt` is a different fact — the credential stops working on its own —
 * and the radar already alerts on it; repeating it here would double-report
 * every expiring token as an access-review finding.
 */
function rotationDueByResource(
  expiry: ExpiryListResponse | undefined,
): Map<string, { label: string; daysRemaining: number }> {
  const out = new Map<string, { label: string; daysRemaining: number }>();
  if (!expiry) return out;
  for (const item of expiry.items) {
    if (item.basis !== "age") continue;
    if (item.daysRemaining >= 0) continue;
    const existing = out.get(item.resourceId);
    // Worst (most overdue) wins when a principal carries several budgets.
    if (existing && existing.daysRemaining <= item.daysRemaining) continue;
    out.set(item.resourceId, { label: item.label, daysRemaining: item.daysRemaining });
  }
  return out;
}

/**
 * Compute the access review for a workspace: every declared principal, plus
 * every rule that has evidence against it.
 *
 * Pure and deterministic — two hosts reading the same rows render the same
 * review. Findings sort by severity rank, then account, then principal name,
 * then rule id, so the order is stable across refreshes.
 *
 * Dismissed findings are computed exactly like the rest and then *partitioned
 * out* — they leave `findings`/`counts`/`byRule`/`totalCount` (so nothing the
 * org has accepted can page anyone) and reappear in `dismissed` with the note
 * and author attached (so accepting a risk is reviewable, not a delete). The
 * `principals` list is **not** filtered: an inventory that hid a principal
 * because one of its findings was accepted would be a lying inventory.
 */
export function computeAccessReview(
  input: AccessScanInput,
  options: AccessScanOptions = {},
): AccessReviewResponse {
  const now = options.now ?? Date.now();
  const staleDays = normalizeStaleDays(options.staleDays);
  const includeUnowned = options.includeUnowned ?? true;

  const principals = collectAccessPrincipals(input, { ...options, now, staleDays });
  const rotationDue = rotationDueByResource(options.expiry);
  const dismissals = new Map(
    (input.dismissals ?? []).map((d) => [accessFindingKey(d), d] as const),
  );

  const findings: AccessFinding[] = [];
  const dismissed: DismissedAccessFinding[] = [];
  for (const principal of principals) {
    for (const finding of findingsFor(principal, staleDays, rotationDue, includeUnowned)) {
      const dismissal = dismissals.get(accessFindingKey(finding));
      if (dismissal) dismissed.push({ ...finding, dismissal });
      else findings.push(finding);
    }
  }

  const bySeverity = (a: AccessFinding, b: AccessFinding) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.principal.accountName.localeCompare(b.principal.accountName) ||
    a.principal.displayName.localeCompare(b.principal.displayName) ||
    a.ruleId.localeCompare(b.ruleId);

  findings.sort(bySeverity);
  // Most recently dismissed first — the list is read to undo a decision, and
  // the decision most likely to be wrong is the one just made.
  dismissed.sort(
    (a, b) => b.dismissal.dismissedAt.localeCompare(a.dismissal.dismissedAt) || bySeverity(a, b),
  );

  const counts = emptyCounts();
  const byRule = emptyByRule();
  for (const finding of findings) {
    counts[finding.severity] += 1;
    byRule[finding.ruleId] += 1;
  }
  const byRole = emptyByRole();
  let unknownActivityCount = 0;
  for (const principal of principals) {
    byRole[principal.role] += 1;
    if (principal.activity === "unknown") unknownActivityCount += 1;
  }

  return {
    principals,
    findings,
    totalCount: findings.length,
    counts,
    byRule,
    byRole,
    dismissed,
    dismissedCount: dismissed.length,
    unknownActivityCount,
    staleDays,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * The findings worth paging about — critical and high only, exactly as the
 * posture feed decides. Medium and low are review work; they belong on the
 * screen and in the digest, not in somebody's evening.
 */
export function alertableAccessFindings(review: AccessReviewResponse): AccessFinding[] {
  return review.findings.filter((f) => f.severity === "critical" || f.severity === "high");
}

/** Columns of the CSV export, in order. The header row is these labels. */
const CSV_COLUMNS: readonly (readonly [string, (f: AccessFinding) => string])[] = [
  ["Account", (f) => f.principal.accountName],
  ["Provider", (f) => f.principal.pluginName],
  ["Principal", (f) => f.principal.displayName],
  ["Type", (f) => f.principal.resourceTypeName],
  ["Role", (f) => PRINCIPAL_ROLE_LABELS[f.principal.role]],
  ["Provider id", (f) => f.principal.externalId ?? ""],
  ["Owner", (f) => f.principal.owner?.displayName ?? "Unowned"],
  ["Belongs to", (f) => f.principal.parent ?? ""],
  ["Created", (f) => f.principal.createdAt ?? ""],
  ["Last used", (f) => f.principal.lastUsedAt ?? ""],
  // "Unknown" is printed, never blank: a blank cell reads as "not looked up",
  // which for this column is exactly the wrong impression.
  ["Activity", (f) => f.principal.activity],
  ["Admin", (f) => (f.principal.admin === null ? "unknown" : String(f.principal.admin))],
  ["MFA", (f) => (f.principal.mfa === null ? "unknown" : String(f.principal.mfa))],
  ["Rule", (f) => f.ruleId],
  ["Finding", (f) => f.title],
  ["Severity", (f) => f.severity],
  ["Status", (f) => ("dismissal" in f ? "dismissed" : "open")],
  [
    "Accepted by",
    (f) => ("dismissal" in f ? ((f as DismissedAccessFinding).dismissal.dismissedBy ?? "") : ""),
  ],
  [
    "Accepted note",
    (f) => ("dismissal" in f ? ((f as DismissedAccessFinding).dismissal.reason ?? "") : ""),
  ],
  ["Reason", (f) => f.reason],
];

/**
 * RFC 4180 quoting. Everything is quoted rather than only what needs it — the
 * evidence file goes to an auditor who may open it in anything, and a
 * conditionally-quoted column is where a stray provider comma turns into a
 * shifted row.
 *
 * A leading `=`/`+`/`-`/`@` is prefixed with a tab so a spreadsheet renders it
 * as text: principal names come from the customer's cloud, and an export that
 * executes them would be a formula-injection hole in a compliance artifact.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * The review as CSV, one row per finding (open first, then dismissed), for the
 * compliance evidence pack.
 *
 * Dismissed findings are **included and labelled**, not dropped: an auditor's
 * question is "what did you find and what did you decide", and an export that
 * silently omitted the accepted risks would answer only half of it. CRLF line
 * endings, because that is what RFC 4180 says and what Excel expects.
 */
export function accessReviewToCsv(review: AccessReviewResponse): string {
  const rows: AccessFinding[] = [...review.findings, ...review.dismissed];
  const lines = [CSV_COLUMNS.map(([label]) => csvCell(label)).join(",")];
  for (const finding of rows) {
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(finding))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Read `GET /api/org/:orgId/access-review` (permission `resources:read`). */
export async function fetchAccessReview(
  api: CloudFetch,
  orgId: string,
  opts: { staleDays?: number } = {},
): Promise<AccessReviewResponse> {
  const query =
    opts.staleDays === undefined ? "" : `?staleDays=${normalizeStaleDays(opts.staleDays)}`;
  const res = await api.org<AccessReviewResponse>(orgId, `/access-review${query}`);
  return res ?? emptyAccessReview(normalizeStaleDays(opts.staleDays));
}

/** What a caller supplies to accept a finding. */
export interface AccessReviewDismissInput {
  resourceId: string;
  ruleId: string;
  /** Why this one is acceptable. Optional, trimmed and capped server-side. */
  reason?: string | undefined;
}

/**
 * Accept a finding (`POST /api/org/:orgId/access-review/dismissals`,
 * permission `resources:write`). Idempotent: dismissing an already-dismissed
 * finding rewrites the note and the author rather than failing.
 */
export async function dismissAccessFinding(
  api: CloudFetch,
  orgId: string,
  input: AccessReviewDismissInput,
): Promise<AccessReviewDismissal> {
  const res = await api.org<AccessReviewDismissal>(orgId, "/access-review/dismissals", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res) throw new Error("Dismissing the finding returned no dismissal");
  return res;
}

/**
 * Undo a dismissal (`DELETE /api/org/:orgId/access-review/dismissals`).
 *
 * The key travels as query parameters rather than path segments because
 * resource ids are provider-native and routinely contain slashes.
 */
export async function restoreAccessFinding(
  api: CloudFetch,
  orgId: string,
  input: { resourceId: string; ruleId: string },
): Promise<void> {
  const query = new URLSearchParams({ resourceId: input.resourceId, ruleId: input.ruleId });
  await api.org(orgId, `/access-review/dismissals?${query.toString()}`, { method: "DELETE" });
}
