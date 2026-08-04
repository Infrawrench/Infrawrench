/**
 * Posture checks — plugin-declared security rules evaluated over
 * already-synced resource fields, producing severity-ranked findings: public
 * buckets, 0.0.0.0/0 ingress, unencrypted disks, publicly-reachable database
 * endpoints, access keys past their rotation budget, missing deletion
 * protection.
 *
 * The classification is declarative: plugins mark rules on their resource
 * types with `postureChecks` (`PostureCheckRule` in
 * `@infrawrench/plugin-base`), and this module is the shared pure half that
 * turns stored rows + those declarations into the findings every surface
 * renders — the web/desktop/mobile screens, the `infrawrench posture` CLI,
 * the `list_posture_findings` MCP tool and the poller's posture alerts. Rows
 * in, findings out: no plugin client, no credentials, no provider API calls,
 * ever — exactly the `orphanRule` and expiry-radar contract.
 *
 * The plugin-base import is type-only on purpose (the expiry radar's stance):
 * this module must stay free of a *runtime* dependency on plugin-base so the
 * mobile bundle doesn't pull in zod for the sake of a few interfaces. The
 * condition semantics are therefore implemented here too, and must match
 * `evaluatePostureRule` in plugin-base exactly — both sides are covered by
 * tests against the documented contract.
 */
import type { PostureCategory, PostureCheckRule, PostureSeverity } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

export type {
  PostureCategory,
  PostureCheckRule,
  PostureCondition,
  PostureSeverity,
} from "@infrawrench/plugin-base";

/** Severities in escalation order, worst first. */
export const POSTURE_SEVERITIES: readonly PostureSeverity[] = ["critical", "high", "medium", "low"];

/** Human labels for the severity buckets, shared by every surface. */
export const POSTURE_SEVERITY_LABELS: Record<PostureSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Human labels for the category buckets, shared by every surface. */
export const POSTURE_CATEGORY_LABELS: Record<PostureCategory, string> = {
  "public-exposure": "Public exposure",
  encryption: "Encryption",
  "credential-age": "Credential age",
  "data-protection": "Data protection",
  other: "Other",
};

/** One matched rule on one resource. A resource can carry several. */
export interface PostureFinding {
  /** Infrawrench resource id. */
  resourceId: string;
  pluginId: string;
  /** Plugin display name, e.g. "AWS". */
  pluginName: string;
  resourceTypeId: string;
  /** Display name of the resource type, e.g. "S3 Bucket". */
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  displayName: string;
  /** Provider-native id, when known. */
  externalId: string | null;
  /** The matched rule's stable id, unique within the plugin. */
  ruleId: string;
  /** Short rule title, e.g. "Bucket allows public access". */
  title: string;
  severity: PostureSeverity;
  category: PostureCategory;
  /** Plugin-authored explanation of why this is a finding. */
  reason: string;
}

/** Wire shape of `GET /api/org/:orgId/posture` and the local CLI assembly. */
export interface PostureListResponse {
  /** All findings, worst severity first. */
  findings: PostureFinding[];
  totalCount: number;
  /** Finding count per severity; every bucket present, zeros included. */
  counts: Record<PostureSeverity, number>;
  generatedAt: string;
}

/** The part of a resource type definition the scan reads. */
export interface PostureScanResourceType {
  id: string;
  displayName: string;
  postureChecks?: readonly PostureCheckRule[] | undefined;
}

/** The part of a loaded plugin the scan reads. */
export interface PostureScanPlugin {
  id: string;
  displayName: string;
  resourceTypes: readonly PostureScanResourceType[];
}

/** The part of an account row the scan reads. */
export interface PostureScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/**
 * The part of a stored resource row the scan reads. Hosts map their own store
 * onto this — Postgres jsonb, SQLite TEXT bags — so the computation never
 * learns which database it is looking at.
 */
export interface PostureScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  /** The instance's stored `fields` bag; a missing/!object bag flags nothing. */
  fields: unknown;
}

export interface PostureScanInput {
  plugins: readonly PostureScanPlugin[];
  accounts: readonly PostureScanAccount[];
  resources: readonly PostureScanResource[];
}

export interface PostureScanOptions {
  /** Scan instant for `olderThanDays` conditions; defaults to `Date.now()`. */
  now?: number;
}

const MS_PER_DAY = 86_400_000;

const SEVERITY_RANK: Record<PostureSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TRUE_WORDS = new Set(["true", "1", "yes", "enabled"]);
const FALSE_WORDS = new Set(["false", "0", "no", "disabled"]);

/**
 * Parse a stored field value as a point in time, epoch milliseconds — the
 * same tolerance as the expiry radar's `parseExpiryInstant`. Returns null for
 * anything unparseable: a value that fails to parse must fail the condition,
 * never alarm. Small numbers (< 1e8, i.e. before ~1973 as seconds) are
 * rejected rather than guessed at, so a port or a count never reads as a
 * date.
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
 * Whether a rule matches a stored field bag. The documented
 * `PostureCondition` semantics, implemented identically to plugin-base's
 * `evaluatePostureRule` (see the module doc for why it is not imported).
 */
function ruleMatches(
  rule: PostureCheckRule,
  fields: Record<string, unknown> | undefined,
  now: number,
): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((cond) => {
    const raw = fields?.[cond.fieldKey];
    if (cond.when === "empty") return raw == null || raw === "";
    if (raw == null) return false;
    if (cond.when === "olderThanDays") {
      const instant = parseInstant(raw);
      if (instant === null) return false;
      return now - instant > cond.days * MS_PER_DAY;
    }
    if (cond.when === "truthy") {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      return typeof raw === "string" && TRUE_WORDS.has(raw.trim().toLowerCase());
    }
    if (cond.when === "falsy") {
      if (typeof raw === "boolean") return !raw;
      if (typeof raw === "number") return raw === 0;
      return typeof raw === "string" && FALSE_WORDS.has(raw.trim().toLowerCase());
    }
    const actual = String(raw).toLowerCase();
    const expected = (cond.value ?? "").toLowerCase();
    if (cond.when === "equals") return actual === expected;
    return actual !== expected;
  });
}

/**
 * Compute the posture findings for a workspace: every declared rule matched
 * against every stored resource, worst severity first.
 *
 * Pure and deterministic — two hosts reading the same rows render the same
 * findings. The sort is severity rank, then account name, then display name,
 * then rule id, so the order is stable across refreshes. Resources whose
 * account is missing from `accounts` are skipped (soft-deleted account, not a
 * finding worth alarming on), as is any bag that isn't a plain object.
 */
export function computePostureFindings(
  input: PostureScanInput,
  options: PostureScanOptions = {},
): PostureListResponse {
  const now = options.now ?? Date.now();

  // pluginId → { pluginName, types: typeId → { typeName, rules } }
  const ruleIndex = new Map<
    string,
    {
      pluginName: string;
      types: Map<string, { typeName: string; rules: readonly PostureCheckRule[] }>;
    }
  >();
  for (const plugin of input.plugins) {
    const types = new Map<string, { typeName: string; rules: readonly PostureCheckRule[] }>();
    for (const type of plugin.resourceTypes) {
      if (type.postureChecks && type.postureChecks.length > 0)
        types.set(type.id, { typeName: type.displayName, rules: type.postureChecks });
    }
    if (types.size > 0) ruleIndex.set(plugin.id, { pluginName: plugin.displayName, types });
  }

  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const findings: PostureFinding[] = [];

  if (ruleIndex.size > 0) {
    for (const r of input.resources) {
      const pluginEntry = ruleIndex.get(r.pluginId);
      const typeEntry = pluginEntry?.types.get(r.resourceTypeId);
      if (!pluginEntry || !typeEntry) continue;
      const account = accountMap.get(r.accountId);
      if (!account) continue;
      const fields =
        r.fields && typeof r.fields === "object" && !Array.isArray(r.fields)
          ? (r.fields as Record<string, unknown>)
          : undefined;

      for (const rule of typeEntry.rules) {
        if (!ruleMatches(rule, fields, now)) continue;
        findings.push({
          resourceId: r.id,
          pluginId: r.pluginId,
          pluginName: pluginEntry.pluginName,
          resourceTypeId: r.resourceTypeId,
          resourceTypeName: typeEntry.typeName,
          accountId: r.accountId,
          accountName: account.displayName,
          displayName: r.displayName,
          externalId: r.externalId,
          ruleId: rule.id,
          title: rule.title,
          severity: rule.severity,
          category: rule.category,
          reason: rule.reason,
        });
      }
    }
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.accountName.localeCompare(b.accountName) ||
      a.displayName.localeCompare(b.displayName) ||
      a.ruleId.localeCompare(b.ruleId),
  );

  const counts: Record<PostureSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  return {
    findings,
    totalCount: findings.length,
    counts,
    generatedAt: new Date(now).toISOString(),
  };
}

/** The findings the poller alerts on — critical and high only. */
export function alertablePostureFindings(feed: PostureListResponse): PostureFinding[] {
  return feed.findings.filter((f) => f.severity === "critical" || f.severity === "high");
}

/**
 * Org-level posture alert settings — the wire shape of
 * `GET|PUT /api/org/:orgId/posture/settings` (permission `org:settings:write`).
 * Shaped like the expiry alert settings, minus a lead time: findings have no
 * clock, so the only tunable is the on/off switch.
 */
export interface PostureSettings {
  /** Whether the poller sends posture alerts for this org at all. */
  enabled: boolean;
  /** When the org was last notified; null before the first alert. */
  lastNotifiedAt: string | null;
}

export interface PostureSettingsPatch {
  enabled?: boolean;
}

/** Read the org's posture alert settings. */
export async function getPostureSettings(api: CloudFetch, orgId: string): Promise<PostureSettings> {
  const res = await api.org<PostureSettings>(orgId, "/posture/settings");
  return res ?? { enabled: true, lastNotifiedAt: null };
}

/** Update the org's posture alert settings. */
export async function updatePostureSettings(
  api: CloudFetch,
  orgId: string,
  patch: PostureSettingsPatch,
): Promise<PostureSettings> {
  const res = await api.org<PostureSettings>(orgId, "/posture/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return res ?? { enabled: true, lastNotifiedAt: null };
}

/**
 * Read `GET /api/org/:orgId/posture` (permission `resources:read`).
 *
 * Cheap and side-effect free: the server computes the findings over rows it
 * already synced and makes no provider API calls.
 */
export async function fetchPosture(api: CloudFetch, orgId: string): Promise<PostureListResponse> {
  const res = await api.org<PostureListResponse>(orgId, "/posture");
  return (
    res ?? {
      findings: [],
      totalCount: 0,
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      generatedAt: new Date().toISOString(),
    }
  );
}
