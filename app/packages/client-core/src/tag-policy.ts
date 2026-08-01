/**
 * Org tag policy, tag compliance, and cost-centre allocation — the pure
 * contract shared by web, desktop, mobile, the CLI, and the server (the
 * ClickHouse readers and the create-time enforcement both import from here,
 * exactly the way the cost query vocabulary in `costs.ts` is shared).
 *
 * A tag policy is a list of required tag keys, each optionally restricted to a
 * set of allowed values. Resources are generic records — the host never knows
 * provider shapes — so "does this resource carry a tag" is answered by a
 * documented convention: a field named `tags` or `labels` (case-insensitive)
 * in one of the shapes providers actually use (a string map, a JSON-encoded
 * map, a `k=v` list). Plugins that surface tags under those keys get policy
 * support for free; nothing provider-specific lives in the host.
 */

export interface RequiredTag {
  /** The tag key every resource must carry, e.g. "owner" or "env". */
  key: string;
  /** When set, the tag's value must be one of these (compared exactly). */
  allowedValues?: string[] | undefined;
}

export interface TagPolicy {
  requiredTags: RequiredTag[];
  /**
   * When true, resource creation through the app is rejected (HTTP 422,
   * code `tag_policy_unmet`) if the submitted fields carry a tag map that is
   * missing a required tag. Types whose create form has no tag field are
   * exempt — a policy cannot demand what a provider cannot store.
   */
  enforceOnCreate: boolean;
}

export const DEFAULT_TAG_POLICY: TagPolicy = { requiredTags: [], enforceOnCreate: false };

export const TAG_POLICY_LIMITS = {
  maxRequiredTags: 32,
  maxKeyLength: 128,
  maxValueLength: 256,
  maxAllowedValues: 64,
} as const;

/** Error code carried by the 422 returned when enforcement blocks a create. */
export const TAG_POLICY_UNMET_CODE = "tag_policy_unmet";

/**
 * Header a caller with `tag-policy:override` sends to create anyway. Mirrors
 * the change-freeze override header; both blocks and overrides are audit-logged.
 */
export const TAG_POLICY_OVERRIDE_HEADER = "x-tag-policy-override";

/** Field keys the generic tag-extraction convention recognises. */
const TAG_FIELD_KEYS = new Set(["tags", "labels"]);

function isTagFieldKey(key: string): boolean {
  return TAG_FIELD_KEYS.has(key.toLowerCase());
}

/** Whether a create-form field list declares a tag-capable field. */
export function fieldsDeclareTagField(fields: Array<{ key: string }>): boolean {
  return fields.some((f) => isTagFieldKey(f.key));
}

function toTagValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Parse one `k=v` / `k:v` entry; a bare token becomes a value-less tag. */
function parseEntry(entry: string, out: Record<string, string>): void {
  const trimmed = entry.trim();
  if (!trimmed) return;
  const sep = trimmed.indexOf("=") >= 0 ? "=" : trimmed.indexOf(":") >= 0 ? ":" : null;
  if (!sep) {
    out[trimmed] = "";
    return;
  }
  const idx = trimmed.indexOf(sep);
  const key = trimmed.slice(0, idx).trim();
  if (key) out[key] = trimmed.slice(idx + 1).trim();
}

function tagsFromUnknown(value: unknown): Record<string, string> | null {
  if (value == null) return null;

  if (Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const item of value) {
      if (typeof item === "string") {
        parseEntry(item, out);
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const key = toTagValue(obj["key"] ?? obj["Key"] ?? obj["name"]);
        if (key) out[key] = toTagValue(obj["value"] ?? obj["Value"]) ?? "";
      }
    }
    return out;
  }

  if (typeof value === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const str = toTagValue(v);
      if (str !== null) out[k] = str;
    }
    return out;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return tagsFromUnknown(JSON.parse(trimmed));
      } catch {
        return {};
      }
    }
    const out: Record<string, string> = {};
    for (const entry of trimmed.split(",")) parseEntry(entry, out);
    return out;
  }

  return null;
}

/**
 * Extract the tag map from a generic stored record (a resource's fields, or a
 * create form's submitted values). Returns `null` when the record carries no
 * tag-shaped field at all — "cannot be tagged" — as opposed to `{}` for a tag
 * field that is present but empty ("taggable, untagged").
 */
export function extractRecordTags(
  record: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  if (!record) return null;
  let found: Record<string, string> | null = null;
  for (const [key, value] of Object.entries(record)) {
    if (!isTagFieldKey(key)) continue;
    const tags = tagsFromUnknown(value);
    found = { ...(found ?? {}), ...(tags ?? {}) };
  }
  return found;
}

export type TagViolationReason = "missing" | "value_not_allowed";

export interface TagPolicyViolation {
  key: string;
  reason: TagViolationReason;
  /** The offending value, for `value_not_allowed`. */
  value?: string;
  allowedValues?: string[] | undefined;
}

/**
 * Which required tags a tag map fails to satisfy. Keys are matched
 * case-insensitively (providers disagree on casing); allowed values exactly.
 */
export function tagPolicyViolations(
  tags: Record<string, string>,
  requiredTags: RequiredTag[],
): TagPolicyViolation[] {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(tags)) lower.set(k.toLowerCase(), v);

  const violations: TagPolicyViolation[] = [];
  for (const required of requiredTags) {
    const value = lower.get(required.key.toLowerCase());
    if (value === undefined || value === "") {
      violations.push({ key: required.key, reason: "missing" });
    } else if (
      required.allowedValues &&
      required.allowedValues.length > 0 &&
      !required.allowedValues.includes(value)
    ) {
      violations.push({
        key: required.key,
        reason: "value_not_allowed",
        value,
        allowedValues: required.allowedValues,
      });
    }
  }
  return violations;
}

/** One-line human summary of a violation list, for error messages and CLIs. */
export function describeTagViolations(violations: TagPolicyViolation[]): string {
  return violations
    .map((v) =>
      v.reason === "missing"
        ? `missing required tag "${v.key}"`
        : `tag "${v.key}" has value "${v.value ?? ""}" (allowed: ${(v.allowedValues ?? []).join(", ")})`,
    )
    .join("; ");
}

/* ------------------------------------------------------------------ *
 * Compliance
 * ------------------------------------------------------------------ */

export interface AccountTagCompliance {
  accountId: string;
  pluginId: string;
  displayName: string;
  /** Every live resource the account holds. */
  totalResources: number;
  /** Resources whose stored record exposes a tag map (the scoreable set). */
  evaluated: number;
  /** Evaluated resources satisfying every required tag. */
  compliant: number;
  /** 0–100 over the evaluated set; null when nothing is evaluable. */
  score: number | null;
}

export interface TagComplianceReport {
  policy: TagPolicy;
  accounts: AccountTagCompliance[];
}

export function complianceScore(compliant: number, evaluated: number): number | null {
  if (evaluated <= 0) return null;
  return Math.round((compliant / evaluated) * 100);
}

/* ------------------------------------------------------------------ *
 * Cost centres + allocation rules (showback)
 * ------------------------------------------------------------------ */

export interface CostCentre {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a rule matches against a cost row. Every set field must match (AND);
 * a rule with no fields matches everything (a catch-all). `tagKey` alone means
 * "the row carries this tag at all"; with `tagValue` the value must equal.
 */
export interface AllocationRuleMatch {
  tagKey?: string | undefined;
  tagValue?: string | undefined;
  accountId?: string | undefined;
  pluginId?: string | undefined;
  service?: string | undefined;
}

export interface AllocationRule {
  id: string;
  costCentreId: string;
  /** Lower fires first; the first matching rule wins. */
  priority: number;
  match: AllocationRuleMatch;
  createdAt: string;
  updatedAt: string;
}

export interface AllocationRuleInput {
  costCentreId: string;
  priority: number;
  match: AllocationRuleMatch;
}

export const ALLOCATION_RULE_LIMITS = { maxRules: 200 } as const;

/** Group key used for spend no allocation rule claimed. */
export const UNALLOCATED_KEY = "__unallocated__";

/* ------------------------------------------------------------------ *
 * Report wire shapes
 * ------------------------------------------------------------------ */

/** Untagged / unallocated spend over the org's required tag keys. */
export interface UntaggedSpendReport {
  from: string;
  to: string;
  requiredKeys: string[];
  currencies: string[];
  /** Currency → total spend in the range. */
  totals: Record<string, number>;
  /** Currency → spend on rows missing at least one required tag key. */
  untaggedTotals: Record<string, number>;
  /** Per required key: currency → spend on rows missing that key. */
  byKey: Array<{ key: string; untagged: Record<string, number> }>;
  /** Largest untagged (account, service) buckets, descending. */
  topUntagged: Array<{
    accountId: string;
    accountLabel: string;
    service: string;
    currency: string;
    amount: number;
  }>;
}

export interface ShowbackReportCentre {
  /** Null for the synthetic "Unallocated" bucket. */
  costCentreId: string | null;
  name: string;
  /** Currency → spend allocated to this centre in the range. */
  totals: Record<string, number>;
}

/** Spend grouped by cost centre via the org's allocation rules. */
export interface ShowbackReport {
  from: string;
  to: string;
  currencies: string[];
  centres: ShowbackReportCentre[];
}

/** Share of spend that carries every required key; null when nothing spent. */
export function taggedSpendPercent(
  report: Pick<UntaggedSpendReport, "totals" | "untaggedTotals">,
  currency: string,
): number | null {
  const total = report.totals[currency] ?? 0;
  if (total <= 0) return null;
  const untagged = report.untaggedTotals[currency] ?? 0;
  return Math.max(0, Math.min(100, Math.round(((total - untagged) / total) * 100)));
}
