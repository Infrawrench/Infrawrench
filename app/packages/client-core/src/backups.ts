/**
 * Backup & restore coverage — "what is your actual RPO?".
 *
 * The product already tells you what is expiring and what is oversized;
 * this is the half that tells you what is *unrecoverable*. Plugins declare
 * two things on their resource types — `backupRole` on the types that **are**
 * backups (EBS snapshots, RDS snapshots, Droplet backups, Neon/PlanetScale
 * backups) and `backupPolicy` on the stateful types that **need** them — and
 * this module is the shared pure half that turns stored rows plus those
 * declarations into findings.
 *
 * Rows in, findings out: no plugin client, no credentials, no provider API
 * calls, ever — exactly the `orphanRule` / expiry-radar / posture contract.
 * Everything it knows comes from inventory the poller already synced, which is
 * why the surface is free to compute on read rather than materialising a
 * table.
 *
 * The plugin-base import is type-only on purpose (the expiry and posture
 * stance): this module must stay free of a *runtime* dependency on plugin-base
 * so the mobile bundle doesn't pull in zod for the sake of two interfaces.
 *
 * Four things get reported:
 *
 * - **unprotected** — a stateful resource with no backup in the inventory and
 *   no provider-native automated backup we can see.
 * - **rpo-breach** — the newest backup protecting it is older than the org
 *   policy's `maxRpoHours`. This is the number people think they know.
 * - **retention-below-policy** — the provider-native retention window is
 *   shorter than the org policy's `minRetentionDays`.
 * - **orphaned-snapshot** — a backup whose source resource is gone. Pure
 *   spend, and the one finding that saves rather than costs money.
 *
 * Two silences are deliberate. A snapshot whose `sourceKey` field is absent is
 * **unattributable**, not orphaned — we must never bill someone for deleting a
 * snapshot that is in fact attached to something. And a resource whose
 * automated-backup field carries a value we don't recognise is neither cleared
 * nor flagged: missing data must not alarm.
 */
import type { BackupPolicyDeclaration, BackupRoleDeclaration } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";
import { extractRecordTags } from "./tag-policy";

export type {
  BackupPolicyDeclaration,
  BackupRoleDeclaration,
  BackupRoleKind,
} from "@infrawrench/plugin-base";

/** What kind of gap a finding describes. */
export type BackupFindingKind =
  "unprotected" | "rpo-breach" | "retention-below-policy" | "orphaned-snapshot";

/** How bad it is. Same four-step ladder as posture, for the same reason. */
export type BackupSeverity = "critical" | "high" | "medium" | "low";

/** Severities in escalation order, worst first. */
export const BACKUP_SEVERITIES: readonly BackupSeverity[] = ["critical", "high", "medium", "low"];

/** Human labels for the severity buckets, shared by every surface. */
export const BACKUP_SEVERITY_LABELS: Record<BackupSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Human labels for the finding kinds, shared by every surface. */
export const BACKUP_FINDING_KIND_LABELS: Record<BackupFindingKind, string> = {
  unprotected: "No backup",
  "rpo-breach": "RPO breached",
  "retention-below-policy": "Retention too short",
  "orphaned-snapshot": "Orphaned snapshot",
};

/** How a resource's protection state reads at a glance. */
export type BackupProtectionState =
  /** At least one backup in the inventory, and it is inside the RPO (or no RPO applies). */
  | "protected"
  /** Provider-native automated backups are on; we can't list the restore points. */
  | "automated"
  /** Backups exist but the newest one is older than the policy allows. */
  | "stale"
  /**
   * The type declares a provider-native automated-backup signal, but this
   * instance's value is absent or unrecognised, and no backup is attributable.
   * We have **not assessed** this resource — distinct from `unprotected`,
   * which is a confirmed gap.
   *
   * This is the state a row synced before its plugin declared the field lands
   * in, and it never produces a finding: the whole point of the three-valued
   * `parseFlag` is that missing data must not alarm, and folding "we don't
   * know" into "you have no backup" would put invented gaps in the digest.
   */
  | "unknown"
  /** Nothing protects it that we can see, and we had the data to tell. */
  | "unprotected";

/** One gap, on one resource. A resource can carry more than one. */
export interface BackupFinding {
  /** Infrawrench resource id the finding is on. */
  resourceId: string;
  pluginId: string;
  /** Plugin display name, e.g. "AWS". */
  pluginName: string;
  resourceTypeId: string;
  /** Display name of the resource type, e.g. "EBS Volume". */
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  displayName: string;
  /** Provider-native id, when known. */
  externalId: string | null;
  kind: BackupFindingKind;
  severity: BackupSeverity;
  /** Short headline, e.g. "No backup of this volume". */
  title: string;
  /** Sentence explaining the gap and what would close it. */
  detail: string;
  /** The org policy that judged this, when one did; null for policy-free findings. */
  policyId: string | null;
  policyName: string | null;
  /** Hours since the newest backup protecting the resource; null when there is none. */
  rpoHours: number | null;
  /** The policy's allowance in hours, when one applied. */
  maxRpoHours: number | null;
  /** Provider-native retention window in days, when the lister syncs one. */
  retentionDays: number | null;
  /** The policy's floor in days, when one applied. */
  minRetentionDays: number | null;
  /** Newest backup protecting the resource — its Infrawrench id, name and instant. */
  latestBackupId: string | null;
  latestBackupName: string | null;
  latestBackupAt: string | null;
  /** Size of the orphaned backup in GiB, when the lister syncs one. */
  sizeGb: number | null;
  /**
   * Trailing-30-day spend on an orphaned backup, when billing data joined.
   * Null means "we couldn't price it", never "it is free".
   */
  monthlyCost: number | null;
  currency: string | null;
}

/** One stateful resource and how well it is protected. The coverage table. */
export interface BackupCoverageRow {
  resourceId: string;
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  displayName: string;
  externalId: string | null;
  state: BackupProtectionState;
  /** How many backups in the inventory protect this resource. */
  backupCount: number;
  latestBackupId: string | null;
  latestBackupName: string | null;
  latestBackupAt: string | null;
  /** Hours since the newest backup; null when there is none. */
  rpoHours: number | null;
  /** Whether a provider-native automated backup is switched on, as far as we can tell. */
  automatedBackups: boolean | null;
  retentionDays: number | null;
  /**
   * The policy supplying `maxRpoHours` — the strictest RPO among those
   * selecting this resource. Null when no selecting policy sets an RPO.
   *
   * Tracked separately from the retention policy because the two strictest
   * demands routinely come from different policies ("everything, 24h RPO"
   * alongside "production databases, 30 day retention"), and a row that named
   * one policy for both would link the reader to the wrong one to edit.
   */
  rpoPolicyId: string | null;
  rpoPolicyName: string | null;
  /** The policy supplying `minRetentionDays`; see {@link rpoPolicyId}. */
  retentionPolicyId: string | null;
  retentionPolicyName: string | null;
  maxRpoHours: number | null;
  minRetentionDays: number | null;
}

/** Headline numbers, so a caller can badge the tab without the rows. */
export interface BackupCoverageSummary {
  /** Stateful resources the declarations let us judge at all. */
  statefulCount: number;
  /** Resources with some protection — a backup, or provider-managed backups. */
  protectedCount: number;
  /** Confirmed gaps. This is what the digest reports; it excludes unknowns. */
  unprotectedCount: number;
  /**
   * Resources we could not assess: the type declares a provider-native
   * automated-backup signal but this instance's value was absent or
   * unrecognised. Surfaced rather than folded into either side, the
   * `unattributableBackupCount` stance — "we found no gap" and "we couldn't
   * tell" must not render the same.
   */
  unknownCount: number;
  /** Backups in the inventory, whatever they protect. */
  backupCount: number;
  orphanedBackupCount: number;
  /**
   * Backups whose type declares no joinable source field, or whose source
   * field is empty. Reported rather than hidden: "we found no orphans" and
   * "we couldn't tell" must not render the same.
   */
  unattributableBackupCount: number;
  /** GiB held by orphaned backups, summed over those that report a size. */
  orphanedGb: number | null;
  /** Trailing-30-day spend on orphaned backups, when billing data joined. */
  orphanedMonthlyCost: number | null;
  currency: string | null;
  /**
   * Worst (largest) RPO in hours across resources that have a backup at all.
   * The one number that answers the question in the feature's name.
   */
  worstRpoHours: number | null;
}

/** Wire shape of `GET /api/org/:orgId/backups`. */
export interface BackupCoverageResponse {
  findings: BackupFinding[];
  counts: Record<BackupSeverity, number>;
  kindCounts: Record<BackupFindingKind, number>;
  totalCount: number;
  /** Every stateful resource the declarations let us judge, worst account first. */
  resources: BackupCoverageRow[];
  summary: BackupCoverageSummary;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Org policies
// ---------------------------------------------------------------------------

/**
 * An org-level backup policy: which resources it applies to, and what it
 * demands of them.
 *
 * The selector is deliberately two independent narrowings rather than a query
 * language — resource types and a tag — because those are the two axes people
 * actually reason about ("all production volumes", "every database"). Both
 * empty means the policy applies to every stateful resource, which is the
 * useful default for an org's first policy.
 */
export interface BackupPolicy {
  id: string;
  name: string;
  /** Resource type ids this policy selects; empty = every stateful type. */
  resourceTypeIds: string[];
  /** Tag key that must be present; null = no tag narrowing. */
  tagKey: string | null;
  /** Required value of `tagKey`; null = any value (presence is enough). */
  tagValue: string | null;
  /** Newest backup must be no older than this many hours; null = no RPO demand. */
  maxRpoHours: number | null;
  /** Provider-native retention must be at least this many days; null = no demand. */
  minRetentionDays: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackupPolicyInput {
  name: string;
  resourceTypeIds?: string[];
  tagKey?: string | null;
  tagValue?: string | null;
  maxRpoHours?: number | null;
  minRetentionDays?: number | null;
  enabled?: boolean;
}

/** Bounds the editors preview against and the server enforces. */
export const BACKUP_POLICY_LIMITS = {
  maxNameLength: 120,
  /** One hour is the shortest RPO any of these providers can honour. */
  minRpoHours: 1,
  /** A year — beyond that the policy is not expressing a recovery objective. */
  maxRpoHours: 8760,
  minRetentionDays: 1,
  maxRetentionDays: 3650,
  maxResourceTypeIds: 100,
  maxTagKeyLength: 128,
  maxTagValueLength: 256,
  /** Per org. A policy list longer than this is a rule engine, not a policy. */
  maxPolicies: 100,
} as const;

/**
 * Validate a policy the way the server will, so both editors can refuse before
 * a round trip and the two can never disagree about what is legal. Returns the
 * first problem, or null.
 */
export function validateBackupPolicyInput(input: BackupPolicyInput): string | null {
  const name = input.name?.trim() ?? "";
  if (name === "") return "A policy needs a name";
  if (name.length > BACKUP_POLICY_LIMITS.maxNameLength) {
    return `The name must be at most ${BACKUP_POLICY_LIMITS.maxNameLength} characters`;
  }
  if ((input.resourceTypeIds?.length ?? 0) > BACKUP_POLICY_LIMITS.maxResourceTypeIds) {
    return `A policy can select at most ${BACKUP_POLICY_LIMITS.maxResourceTypeIds} resource types`;
  }
  if (input.tagKey != null && input.tagKey.length > BACKUP_POLICY_LIMITS.maxTagKeyLength) {
    return `The tag key must be at most ${BACKUP_POLICY_LIMITS.maxTagKeyLength} characters`;
  }
  if (input.tagValue != null && input.tagValue.length > BACKUP_POLICY_LIMITS.maxTagValueLength) {
    return `The tag value must be at most ${BACKUP_POLICY_LIMITS.maxTagValueLength} characters`;
  }
  // A value with no key selects nothing and would silently make the policy
  // inert — the `privateValues requires privateKey` stance.
  if (input.tagValue != null && input.tagValue !== "" && !input.tagKey) {
    return "A tag value needs a tag key";
  }
  const rpo = input.maxRpoHours;
  if (rpo != null) {
    if (!Number.isFinite(rpo) || !Number.isInteger(rpo))
      return "maxRpoHours must be a whole number";
    if (rpo < BACKUP_POLICY_LIMITS.minRpoHours || rpo > BACKUP_POLICY_LIMITS.maxRpoHours) {
      return `maxRpoHours must be between ${BACKUP_POLICY_LIMITS.minRpoHours} and ${BACKUP_POLICY_LIMITS.maxRpoHours}`;
    }
  }
  const retention = input.minRetentionDays;
  if (retention != null) {
    if (!Number.isFinite(retention) || !Number.isInteger(retention)) {
      return "minRetentionDays must be a whole number";
    }
    if (
      retention < BACKUP_POLICY_LIMITS.minRetentionDays ||
      retention > BACKUP_POLICY_LIMITS.maxRetentionDays
    ) {
      return `minRetentionDays must be between ${BACKUP_POLICY_LIMITS.minRetentionDays} and ${BACKUP_POLICY_LIMITS.maxRetentionDays}`;
    }
  }
  // A policy that demands nothing can never produce a finding; it would sit in
  // the list looking like protection while providing none.
  if (rpo == null && retention == null) {
    return "A policy must set an RPO, a minimum retention, or both";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan input
// ---------------------------------------------------------------------------

/** The part of a resource type definition the scan reads. */
export interface BackupScanResourceType {
  id: string;
  displayName: string;
  backupRole?: BackupRoleDeclaration | undefined;
  backupPolicy?: BackupPolicyDeclaration | undefined;
}

/** The part of a loaded plugin the scan reads. */
export interface BackupScanPlugin {
  id: string;
  displayName: string;
  resourceTypes: readonly BackupScanResourceType[];
}

/** The part of an account row the scan reads. */
export interface BackupScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/**
 * The part of a stored resource row the scan reads. Hosts map their own store
 * onto this — Postgres jsonb, SQLite TEXT bags — so the computation never
 * learns which database it is looking at.
 */
export interface BackupScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  /** The instance's stored `fields` bag; a missing/!object bag judges nothing. */
  fields: unknown;
}

export interface BackupScanInput {
  plugins: readonly BackupScanPlugin[];
  accounts: readonly BackupScanAccount[];
  resources: readonly BackupScanResource[];
  /** The org's policies. Disabled ones are ignored here rather than filtered by callers. */
  policies?: readonly BackupPolicy[] | undefined;
}

export interface BackupScanOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /**
   * Trailing-window spend keyed `"<accountId> <externalId>"`, exactly the
   * shape the schedules and orphans surfaces already build. Absent or a miss
   * leaves the cost null — never zero, which would read as "free".
   */
  costsByResource?: ReadonlyMap<string, { amount: number; currency: string | null }> | undefined;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;

const SEVERITY_RANK: Record<BackupSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TRUE_WORDS = new Set(["true", "1", "yes", "enabled", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "disabled", "off"]);

/**
 * Parse a stored field value as a point in time, epoch milliseconds — the same
 * tolerance as the expiry radar's `parseExpiryInstant` and posture's
 * `parseInstant`. Null for anything unparseable: an undatable backup is not
 * evidence of a recent one, so it must never satisfy an RPO.
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
  const goStyle = trimmed.replace(/ [A-Z]{3,4}$/, "");
  if (goStyle !== trimmed) {
    const reparsed = Date.parse(goStyle);
    if (!Number.isNaN(reparsed)) return reparsed;
  }
  return null;
}

/**
 * Leading number out of a stored value, so `"8 GiB"` and `8` and `"8.5"` all
 * read as a size. Null rather than 0 for anything else — a size we can't read
 * must not shrink the orphan total.
 */
function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)/.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Three-valued truthiness: true, false, or "we don't know". The posture word
 * lists, plus `on`/`off` which several backup flags use. Unknown strings
 * return null so an unrecognised value neither clears a resource nor flags it.
 *
 * `when: "present"` switches to the other documented reading — any non-empty
 * value is "on" — for fields that carry a datum instead of a flag
 * (DigitalOcean's `nextBackupStart`). There the absent case is still null, but
 * an explicit `""` is a real "off", which is what that lister writes.
 */
function parseFlag(value: unknown, when: "truthy" | "present" = "truthy"): boolean | null {
  if (value == null) return null;
  if (when === "present") {
    if (typeof value === "boolean") return value;
    return String(value).trim() !== "";
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : null;
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  if (word === "") return null;
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

/**
 * Interpolate a `{field}` source template. Returns null when any referenced
 * field is missing or empty — a half-filled template would match the wrong
 * resource, which reads as protection that does not exist.
 */
function renderSourceTemplate(template: string, fields: Record<string, unknown>): string | null {
  let missing = false;
  const rendered = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const raw = fields[key.trim()];
    const text = raw == null ? "" : String(raw).trim();
    if (text === "") missing = true;
    return text;
  });
  return missing ? null : rendered;
}

function asFields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Identity tokens a resource answers to, lowercased. A snapshot's source field
 * holds whichever of these the provider happened to return, so the join has to
 * accept all of them — plus the last segment of a slash path, which is how a
 * GCP snapshot's `sourceDisk` self-link finds a disk stored under its bare
 * name.
 */
function identityTokens(resource: BackupScanResource): string[] {
  const tokens: string[] = [resource.id];
  if (resource.externalId) {
    tokens.push(resource.externalId);
    const lastSegment = resource.externalId.split("/").filter(Boolean).pop();
    if (lastSegment) tokens.push(lastSegment);
  }
  if (resource.displayName) tokens.push(resource.displayName);
  // Deduped: a resource whose id, external id and display name are the same
  // string (the common case for id-named resources) would otherwise appear
  // three times under one token and read as three claimants — i.e. ambiguous,
  // i.e. unmatched.
  return [...new Set(tokens.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
}

/** Candidate tokens a stored source value could be matched by. */
function sourceTokens(value: string): string[] {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return [];
  const tokens = [trimmed];
  const lastSegment = trimmed.split("/").filter(Boolean).pop();
  if (lastSegment && lastSegment !== trimmed) tokens.push(lastSegment);
  return tokens;
}

/** Whether an org policy selects a resource. */
function policySelects(
  policy: BackupPolicy,
  resourceTypeId: string,
  tags: Record<string, string> | null,
): boolean {
  if (policy.resourceTypeIds.length > 0 && !policy.resourceTypeIds.includes(resourceTypeId)) {
    return false;
  }
  if (!policy.tagKey) return true;
  if (!tags) return false;
  // Providers disagree about tag-key casing; the tag-policy surface matches
  // keys case-insensitively and values exactly, and so does this.
  const wanted = policy.tagKey.toLowerCase();
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() !== wanted) continue;
    if (policy.tagValue == null || policy.tagValue === "") return true;
    return value === policy.tagValue;
  }
  return false;
}

interface ResolvedBackup {
  resource: BackupScanResource;
  typeId: string;
  createdAt: number | null;
  sizeGb: number | null;
  /** The resource it protects, once resolved. */
  source: BackupScanResource | null;
  /** True when the type declares no source to read, or the field was empty. */
  unattributable: boolean;
}

/**
 * Compute the org's backup coverage: every stateful resource judged against
 * the backups that protect it, plus the backups that protect nothing.
 *
 * Pure and deterministic — two hosts reading the same rows render the same
 * findings, which is what lets the surface recompute on read rather than
 * materialising a findings table (the posture stance). Resources whose account
 * is missing from `accounts` are skipped: a soft-deleted account's volumes are
 * not an RPO problem.
 */
export function computeBackupCoverage(
  input: BackupScanInput,
  options: BackupScanOptions = {},
): BackupCoverageResponse {
  const now = options.now ?? Date.now();
  const policies = (input.policies ?? []).filter((p) => p.enabled);

  // pluginId → { name, types: typeId → definition }
  const typeIndex = new Map<
    string,
    { pluginName: string; types: Map<string, BackupScanResourceType> }
  >();
  for (const plugin of input.plugins) {
    const types = new Map<string, BackupScanResourceType>();
    for (const type of plugin.resourceTypes) {
      if (type.backupRole || type.backupPolicy) types.set(type.id, type);
    }
    if (types.size > 0) typeIndex.set(plugin.id, { pluginName: plugin.displayName, types });
  }

  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));

  const empty: BackupCoverageResponse = {
    findings: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    kindCounts: {
      unprotected: 0,
      "rpo-breach": 0,
      "retention-below-policy": 0,
      "orphaned-snapshot": 0,
    },
    totalCount: 0,
    resources: [],
    summary: {
      statefulCount: 0,
      protectedCount: 0,
      unprotectedCount: 0,
      unknownCount: 0,
      backupCount: 0,
      orphanedBackupCount: 0,
      unattributableBackupCount: 0,
      orphanedGb: null,
      orphanedMonthlyCost: null,
      currency: null,
      worstRpoHours: null,
    },
    generatedAt: new Date(now).toISOString(),
  };
  if (typeIndex.size === 0) return empty;

  // Account-scoped identity index. Scoping by account rather than by org is
  // what stops a volume called "data" in staging claiming production's
  // snapshots: a snapshot and its source always live in the same account.
  const identityIndex = new Map<string, BackupScanResource[]>();
  const indexKey = (accountId: string, token: string) => `${accountId} ${token}`;
  for (const resource of input.resources) {
    for (const token of identityTokens(resource)) {
      const key = indexKey(resource.accountId, token);
      const bucket = identityIndex.get(key);
      if (bucket) bucket.push(resource);
      else identityIndex.set(key, [resource]);
    }
  }

  // --- Pass 1: resolve every backup to the resource it protects. -----------
  const backups: ResolvedBackup[] = [];
  /** Infrawrench resource id of a source → the backups protecting it. */
  const backupsBySource = new Map<string, ResolvedBackup[]>();

  for (const resource of input.resources) {
    const type = typeIndex.get(resource.pluginId)?.types.get(resource.resourceTypeId);
    const role = type?.backupRole;
    if (!role) continue;
    if (!accountMap.has(resource.accountId)) continue;

    const fields = asFields(resource.fields);
    // The narrowing runs before anything else: a row this type says is not a
    // backup is not counted, not orphaned and not reported.
    if (role.backupTypeKey && role.backupTypeValues) {
      const actual = String(fields[role.backupTypeKey] ?? "")
        .trim()
        .toLowerCase();
      if (!role.backupTypeValues.some((v) => v.toLowerCase() === actual)) continue;
    }

    const createdAt = parseInstant(fields[role.createdKey ?? "createdAt"]);
    const rawSize = parseNumber(fields[role.sizeKey ?? "sizeGb"]);
    const sizeGb =
      rawSize == null ? null : role.sizeUnit === "bytes" ? rawSize / 1024 ** 3 : rawSize;

    // Attribution is by declared field only. `parentResourceId` is a
    // *containment* link — a DO snapshot's parent is the project it lives in,
    // a Spanner backup's is the instance — so reading it as "what this
    // protects" would attribute every snapshot to the wrong thing.
    let source: BackupScanResource | null = null;
    let unattributable = false;
    const rawText = role.sourceTemplate
      ? renderSourceTemplate(role.sourceTemplate, fields)
      : ((): string | null => {
          const raw = fields[role.sourceKey ?? "sourceId"];
          return raw == null ? null : String(raw);
        })();
    const tokens = rawText == null ? [] : sourceTokens(rawText);
    if (tokens.length === 0) {
      unattributable = true;
    } else {
      let ambiguous = false;
      for (const token of tokens) {
        const matches = (identityIndex.get(indexKey(resource.accountId, token)) ?? []).filter(
          // A backup never protects itself, and a snapshot-of-a-snapshot is
          // not a thing any of these providers models.
          (m) => m.id !== resource.id,
        );
        if (matches.length === 1 && matches[0]) {
          source = matches[0];
          ambiguous = false;
          break;
        }
        if (matches.length > 1) ambiguous = true;
      }
      // Two claimants is an ambiguous match, which the dependency graph and
      // the DNS surface both treat as no match. Here it must *also* not be
      // treated as an orphan: telling someone a snapshot protects nothing,
      // when in fact it protects one of two things we can't tell apart, is an
      // invitation to delete a live backup.
      if (!source && ambiguous) unattributable = true;
    }

    const resolved: ResolvedBackup = {
      resource,
      typeId: resource.resourceTypeId,
      createdAt,
      sizeGb,
      source,
      unattributable,
    };
    backups.push(resolved);
    if (source) {
      const bucket = backupsBySource.get(source.id);
      if (bucket) bucket.push(resolved);
      else backupsBySource.set(source.id, [resolved]);
    }
  }

  // --- Pass 2: judge every stateful resource. ------------------------------
  const findings: BackupFinding[] = [];
  const rows: BackupCoverageRow[] = [];
  let protectedCount = 0;
  let unprotectedCount = 0;
  let unknownCount = 0;
  let worstRpoHours: number | null = null;

  for (const resource of input.resources) {
    const pluginEntry = typeIndex.get(resource.pluginId);
    const type = pluginEntry?.types.get(resource.resourceTypeId);
    const declaration = type?.backupPolicy;
    if (!pluginEntry || !type || !declaration) continue;
    const account = accountMap.get(resource.accountId);
    if (!account) continue;

    const fields = asFields(resource.fields);
    const tags = extractRecordTags(fields);

    // The strictest demand across every policy that selects this resource:
    // shortest RPO, longest retention. Two policies on one volume must not
    // produce two contradictory findings.
    //
    // The winning policy is tracked *per objective*, not per resource. The two
    // strictest demands routinely come from different policies — "everything,
    // 24h RPO" alongside "production databases, 30 day retention" is the
    // obvious setup — and collapsing them into one `policy` made a retention
    // finding cite the unrelated policy that happened to win the RPO. A
    // finding must name the policy that actually supplies the objective it
    // breaches, because that is the policy the reader has to go and change.
    let rpoPolicy: BackupPolicy | null = null;
    let retentionPolicy: BackupPolicy | null = null;
    let firstMatch: BackupPolicy | null = null;
    let maxRpoHours: number | null = null;
    let minRetentionDays: number | null = null;
    for (const candidate of policies) {
      if (!policySelects(candidate, resource.resourceTypeId, tags)) continue;
      if (!firstMatch) firstMatch = candidate;
      if (
        candidate.maxRpoHours != null &&
        (maxRpoHours == null || candidate.maxRpoHours < maxRpoHours)
      ) {
        maxRpoHours = candidate.maxRpoHours;
        rpoPolicy = candidate;
      }
      if (
        candidate.minRetentionDays != null &&
        (minRetentionDays == null || candidate.minRetentionDays > minRetentionDays)
      ) {
        minRetentionDays = candidate.minRetentionDays;
        retentionPolicy = candidate;
      }
    }
    // "Some policy expects this resource to be recoverable" is what escalates
    // an unprotected finding, so any binding policy will do — but prefer the
    // RPO one, since having no backup at all is most directly a failure to
    // meet a recovery point.
    const governingPolicy = rpoPolicy ?? retentionPolicy ?? firstMatch;

    const protectors = new Set(declaration.protectedBy);
    const own = (backupsBySource.get(resource.id) ?? []).filter(
      (b) => protectors.size === 0 || protectors.has(b.typeId),
    );
    // A backup with no readable timestamp still counts as a backup — it is
    // there — but it can never be the newest, so it cannot satisfy an RPO.
    let latest: ResolvedBackup | null = null;
    for (const backup of own) {
      if (backup.createdAt == null) continue;
      if (!latest || (latest.createdAt ?? 0) < backup.createdAt) latest = backup;
    }
    const rpoHours =
      latest?.createdAt != null ? Math.max(0, (now - latest.createdAt) / MS_PER_HOUR) : null;
    if (rpoHours != null && (worstRpoHours == null || rpoHours > worstRpoHours)) {
      worstRpoHours = rpoHours;
    }

    const retentionDays = declaration.retentionDaysFieldKey
      ? parseNumber(fields[declaration.retentionDaysFieldKey])
      : null;
    // A positive retention window IS the proof automated backups are on — the
    // providers that expose one encode "off" as 0 — so a type declaring only
    // `retentionDaysFieldKey` needs no separate flag.
    const flag = declaration.automatedBackupFieldKey
      ? parseFlag(
          fields[declaration.automatedBackupFieldKey],
          declaration.automatedBackupWhen ?? "truthy",
        )
      : null;
    const automatedBackups =
      retentionDays != null ? retentionDays > 0 : flag === null ? null : flag;

    // Whether this type gives us anything to read about provider-managed
    // backups at all. A type that declares neither key is saying snapshots are
    // the only protection it has, so no snapshot really is a gap; a type that
    // declares one and whose value we could not read is a resource we simply
    // have not assessed, and must not be reported as a confirmed gap.
    const declaresAutomated = Boolean(
      declaration.automatedBackupFieldKey || declaration.retentionDaysFieldKey,
    );

    const state: BackupProtectionState =
      own.length > 0
        ? maxRpoHours != null && (rpoHours == null || rpoHours > maxRpoHours)
          ? "stale"
          : "protected"
        : automatedBackups === true
          ? "automated"
          : declaresAutomated && automatedBackups === null
            ? "unknown"
            : "unprotected";
    if (state === "unprotected") unprotectedCount += 1;
    else if (state === "unknown") unknownCount += 1;
    else protectedCount += 1;

    const identity = {
      resourceId: resource.id,
      pluginId: resource.pluginId,
      pluginName: pluginEntry.pluginName,
      resourceTypeId: resource.resourceTypeId,
      resourceTypeName: type.displayName,
      accountId: resource.accountId,
      accountName: account.displayName,
      displayName: resource.displayName,
      externalId: resource.externalId,
    };
    const latestBackupId = latest?.resource.id ?? null;
    const latestBackupName = latest?.resource.displayName ?? null;
    const latestBackupAt =
      latest?.createdAt != null ? new Date(latest.createdAt).toISOString() : null;

    rows.push({
      ...identity,
      state,
      backupCount: own.length,
      latestBackupId,
      latestBackupName,
      latestBackupAt,
      rpoHours,
      automatedBackups,
      retentionDays,
      rpoPolicyId: rpoPolicy?.id ?? null,
      rpoPolicyName: rpoPolicy?.name ?? null,
      retentionPolicyId: retentionPolicy?.id ?? null,
      retentionPolicyName: retentionPolicy?.name ?? null,
      maxRpoHours,
      minRetentionDays,
    });

    // Findings override `policyId`/`policyName` with whichever policy supplies
    // the objective they breach; this is only the fallback for kinds that
    // breach no specific objective.
    const base = {
      ...identity,
      policyId: governingPolicy?.id ?? null,
      policyName: governingPolicy?.name ?? null,
      rpoHours,
      maxRpoHours,
      retentionDays,
      minRetentionDays,
      latestBackupId,
      latestBackupName,
      latestBackupAt,
      sizeGb: null,
      monthlyCost: null,
      currency: null,
    };

    if (state === "unprotected") {
      findings.push({
        ...base,
        kind: "unprotected",
        // Under an explicit policy this is a broken promise; without one it is
        // a fact the org may well have chosen. Both are worth saying, at
        // different volumes.
        severity: governingPolicy ? "high" : "medium",
        title: `No backup of this ${type.displayName.toLowerCase()}`,
        detail:
          `Nothing in the synced inventory protects ${resource.displayName}, and ` +
          `${
            declaresAutomated
              ? `${pluginEntry.pluginName} reports its automated backups as off`
              : `${pluginEntry.pluginName} exposes no automated backup setting for this type`
          }. ` +
          (governingPolicy
            ? `Policy "${governingPolicy.name}" selects it, so this is an unmet objective.`
            : `Take a snapshot, or add a backup policy so this is checked continuously.`),
      });
    } else if (state === "stale" && maxRpoHours != null) {
      findings.push({
        ...base,
        kind: "rpo-breach",
        // Named against the policy that supplies the RPO, which is not
        // necessarily the one supplying the retention floor below.
        policyId: rpoPolicy?.id ?? null,
        policyName: rpoPolicy?.name ?? null,
        severity: rpoHours != null && rpoHours > maxRpoHours * 2 ? "high" : "medium",
        title: "Newest backup is older than the RPO",
        detail:
          (rpoHours == null
            ? `The ${own.length} backup(s) of ${resource.displayName} carry no readable timestamp, so none of them can prove an RPO of ${formatHours(maxRpoHours)}.`
            : `The newest backup of ${resource.displayName} is ${formatHours(rpoHours)} old, against the ${formatHours(maxRpoHours)} demanded by policy "${rpoPolicy?.name ?? "—"}".`) +
          ` Losing it now would cost you everything written since${latestBackupAt ? ` ${latestBackupAt}` : ""}.`,
      });
    }

    if (minRetentionDays != null && retentionDays != null && retentionDays < minRetentionDays) {
      findings.push({
        ...base,
        kind: "retention-below-policy",
        // Named against the policy that supplies the retention floor, which is
        // not necessarily the one supplying the RPO above.
        policyId: retentionPolicy?.id ?? null,
        policyName: retentionPolicy?.name ?? null,
        severity: retentionDays === 0 ? "high" : "medium",
        title:
          retentionDays === 0
            ? "Automated backups are switched off"
            : "Retention is shorter than policy",
        detail:
          retentionDays === 0
            ? `${resource.displayName} has a retention window of 0 days, which is how ${pluginEntry.pluginName} reports automated backups being disabled. Policy "${retentionPolicy?.name ?? "—"}" asks for ${minRetentionDays} day(s).`
            : `${resource.displayName} keeps ${retentionDays} day(s) of automated backups; policy "${retentionPolicy?.name ?? "—"}" asks for ${minRetentionDays}. A mistake found on day ${minRetentionDays} would be unrecoverable.`,
      });
    }
  }

  // --- Pass 3: backups that protect nothing. -------------------------------
  let orphanedGb: number | null = null;
  let orphanedCost: number | null = null;
  let currency: string | null = null;
  let currencyConflict = false;
  let orphanedCount = 0;
  let unattributableCount = 0;

  for (const backup of backups) {
    if (backup.unattributable) {
      unattributableCount += 1;
      continue;
    }
    if (backup.source) continue;
    orphanedCount += 1;

    const resource = backup.resource;
    const pluginEntry = typeIndex.get(resource.pluginId);
    const type = pluginEntry?.types.get(resource.resourceTypeId);
    const account = accountMap.get(resource.accountId);
    if (!pluginEntry || !type || !account) continue;

    if (backup.sizeGb != null) orphanedGb = (orphanedGb ?? 0) + backup.sizeGb;

    const cost =
      resource.externalId && options.costsByResource
        ? (options.costsByResource.get(`${resource.accountId} ${resource.externalId}`) ?? null)
        : null;
    if (cost && cost.currency !== null) {
      orphanedCost = (orphanedCost ?? 0) + cost.amount;
      if (currency === null) currency = cost.currency;
      else if (currency !== cost.currency) currencyConflict = true;
    }

    findings.push({
      resourceId: resource.id,
      pluginId: resource.pluginId,
      pluginName: pluginEntry.pluginName,
      resourceTypeId: resource.resourceTypeId,
      resourceTypeName: type.displayName,
      accountId: resource.accountId,
      accountName: account.displayName,
      displayName: resource.displayName,
      externalId: resource.externalId,
      kind: "orphaned-snapshot",
      // Pure spend, never a risk: an orphan is the one finding here that is
      // safe to ignore forever, so it must never outrank a missing backup.
      severity: "low",
      title: "Backup of a resource that no longer exists",
      detail:
        `${resource.displayName} protects a resource that is not in this account's synced ` +
        `inventory, so it is storage you are paying for and can never restore onto anything. ` +
        (backup.sizeGb != null ? `It holds ${backup.sizeGb} GiB. ` : "") +
        `If the source was deleted deliberately, so can this be.`,
      policyId: null,
      policyName: null,
      rpoHours: null,
      maxRpoHours: null,
      retentionDays: null,
      minRetentionDays: null,
      latestBackupId: null,
      latestBackupName: null,
      latestBackupAt: backup.createdAt != null ? new Date(backup.createdAt).toISOString() : null,
      sizeGb: backup.sizeGb,
      monthlyCost: cost && cost.currency !== null ? cost.amount : null,
      currency: cost?.currency ?? null,
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.accountName.localeCompare(b.accountName) ||
      a.displayName.localeCompare(b.displayName) ||
      a.kind.localeCompare(b.kind),
  );
  rows.sort(
    (a, b) =>
      a.accountName.localeCompare(b.accountName) || a.displayName.localeCompare(b.displayName),
  );

  const counts: Record<BackupSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const kindCounts: Record<BackupFindingKind, number> = {
    unprotected: 0,
    "rpo-breach": 0,
    "retention-below-policy": 0,
    "orphaned-snapshot": 0,
  };
  for (const finding of findings) {
    counts[finding.severity] += 1;
    kindCounts[finding.kind] += 1;
  }

  return {
    findings,
    counts,
    kindCounts,
    totalCount: findings.length,
    resources: rows,
    summary: {
      statefulCount: rows.length,
      protectedCount,
      unprotectedCount,
      unknownCount,
      backupCount: backups.length,
      orphanedBackupCount: orphanedCount,
      unattributableBackupCount: unattributableCount,
      orphanedGb,
      // Mixed currencies drop the quote rather than adding pounds to dollars —
      // the orphans and schedules annotation rule.
      orphanedMonthlyCost: currencyConflict ? null : orphanedCost,
      currency: currencyConflict ? null : currency,
      worstRpoHours,
    },
    generatedAt: new Date(now).toISOString(),
  };
}

/** "3 hours" / "2 days" / "45 minutes" — the one formatter every surface uses. */
export function formatHours(hours: number): string {
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const rounded = Math.round(hours);
    return `${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** The findings worth a line in the weekly digest — everything but orphans. */
export function riskyBackupFindings(feed: BackupCoverageResponse): BackupFinding[] {
  return feed.findings.filter((f) => f.kind !== "orphaned-snapshot");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const EMPTY_RESPONSE: BackupCoverageResponse = {
  findings: [],
  counts: { critical: 0, high: 0, medium: 0, low: 0 },
  kindCounts: {
    unprotected: 0,
    "rpo-breach": 0,
    "retention-below-policy": 0,
    "orphaned-snapshot": 0,
  },
  totalCount: 0,
  resources: [],
  summary: {
    statefulCount: 0,
    protectedCount: 0,
    unprotectedCount: 0,
    unknownCount: 0,
    backupCount: 0,
    orphanedBackupCount: 0,
    unattributableBackupCount: 0,
    orphanedGb: null,
    orphanedMonthlyCost: null,
    currency: null,
    worstRpoHours: null,
  },
  generatedAt: "1970-01-01T00:00:00.000Z",
};

/**
 * Read `GET /api/org/:orgId/backups` (permission `resources:read`).
 *
 * Cheap and side-effect free: the server computes coverage over rows it
 * already synced and makes no provider API calls.
 */
export async function fetchBackupCoverage(
  api: CloudFetch,
  orgId: string,
): Promise<BackupCoverageResponse> {
  const res = await api.org<BackupCoverageResponse>(orgId, "/backups");
  return res ?? { ...EMPTY_RESPONSE, generatedAt: new Date().toISOString() };
}

/** List the org's backup policies (`resources:read`). */
export async function fetchBackupPolicies(api: CloudFetch, orgId: string): Promise<BackupPolicy[]> {
  const res = await api.org<{ policies: BackupPolicy[] }>(orgId, "/backups/policies");
  return res?.policies ?? [];
}

/** Create a backup policy (`org:settings:write`). */
export async function createBackupPolicy(
  api: CloudFetch,
  orgId: string,
  input: BackupPolicyInput,
): Promise<BackupPolicy> {
  const res = await api.org<BackupPolicy>(orgId, "/backups/policies", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res) throw new Error("Creating the policy returned nothing");
  return res;
}

/** Update a backup policy (`org:settings:write`). */
export async function updateBackupPolicy(
  api: CloudFetch,
  orgId: string,
  policyId: string,
  input: Partial<BackupPolicyInput>,
): Promise<BackupPolicy> {
  const res = await api.org<BackupPolicy>(orgId, `/backups/policies/${policyId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (!res) throw new Error("Updating the policy returned nothing");
  return res;
}

/** Delete a backup policy (`org:settings:write`). */
export async function deleteBackupPolicy(
  api: CloudFetch,
  orgId: string,
  policyId: string,
): Promise<void> {
  await api.org(orgId, `/backups/policies/${policyId}`, { method: "DELETE" });
}
