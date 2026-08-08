/**
 * Posture checks — declarative "this resource is probably exposed" rules.
 *
 * The security sibling of `orphanRule` (potential savings) and `expiryFields`
 * (the expiry radar): plugins declare, per resource type, conditions over
 * fields their listers already sync — a bucket whose public-access block is
 * off, a security group open to 0.0.0.0/0, an unencrypted disk, an access key
 * older than its rotation budget — and hosts evaluate the rules over stored
 * resources. No plugin client, no credentials, no extra provider API calls,
 * ever. Only declare rules over fields the type's lister actually populates;
 * a condition on a field that never lands in `fields` simply never matches.
 *
 * The host-side aggregation (`computePostureFindings`) lives in
 * `@infrawrench/client-core`, like the expiry feed, because the mobile app and
 * the CLI compute it too. {@link evaluatePostureRule} here is the single-rule
 * evaluator plugins and their tests share; both implementations follow the
 * exact semantics documented on {@link PostureCondition}.
 */

/** How bad a finding is. Drives sort order, badges and what alerts fire on. */
export type PostureSeverity = "critical" | "high" | "medium" | "low";

/** Grouping bucket for what kind of exposure a rule describes. */
export type PostureCategory =
  "public-exposure" | "encryption" | "credential-age" | "data-protection" | "other";

/**
 * One predicate inside a {@link PostureCheckRule}. All conditions must hold.
 *
 * Field-value predicates (`empty` / `equals` / `notEquals` / `truthy` /
 * `falsy`) follow `OrphanCondition` semantics exactly:
 *
 * - `empty` — field is absent or `""`. `0` is NOT empty.
 * - `equals` / `notEquals` — case-insensitive string comparison against
 *   `value` (numbers/booleans are stringified). An absent field never matches
 *   either — a resource synced before the field existed must not alarm.
 * - `truthy` — the field holds a true-like value: boolean `true`, a non-zero
 *   number, or (case-insensitively) `"true"`, `"1"`, `"yes"`, `"enabled"`.
 *   Absent never matches.
 * - `falsy` — the field holds a false-like value: boolean `false`, the number
 *   `0`, or (case-insensitively) `"false"`, `"0"`, `"no"`, `"disabled"`.
 *   Absent and `""` never match — use `empty` when absence itself is the
 *   finding.
 *
 * The age predicate:
 *
 * - `olderThanDays` — the field holds an instant (ISO 8601 with or without a
 *   time, RFC 2822, or a unix epoch in seconds or milliseconds, as a number
 *   or numeric string — the formats provider listers actually store) that is
 *   more than `days` days before the scan instant. An absent or unparseable
 *   value fails the condition, never alarms.
 */
export type PostureCondition =
  | {
      fieldKey: string;
      when: "empty" | "equals" | "notEquals" | "truthy" | "falsy";
      /** Comparison operand for `equals` / `notEquals`. */
      value?: string;
    }
  | {
      fieldKey: string;
      when: "olderThanDays";
      /** Age threshold in whole days. */
      days: number;
    };

/**
 * Declares when an instance of this type likely has a security posture
 * problem, and why. Kept declarative (rather than a client method) so hosts
 * can evaluate it against stored resources without provider credentials.
 */
export interface PostureCheckRule {
  /**
   * Stable rule id, unique within the plugin — e.g. `"s3-public-access"`.
   * Surfaces key findings on it, so renaming one orphans user context.
   */
  id: string;
  /** Short human title, e.g. "Bucket allows public access". */
  title: string;
  severity: PostureSeverity;
  category: PostureCategory;
  /** All must hold for the resource to be flagged. At least one required. */
  conditions: PostureCondition[];
  /**
   * Human-readable explanation shown next to the flagged resource, e.g.
   * "The bucket's public access block is disabled, so ACLs and policies can
   * make objects world-readable". Written by the plugin — the one place that
   * knows what the fields mean.
   */
  reason: string;
}

const MS_PER_DAY = 86_400_000;

const TRUE_WORDS = new Set(["true", "1", "yes", "enabled"]);
const FALSE_WORDS = new Set(["false", "0", "no", "disabled"]);

/**
 * Parse a stored field value as a point in time, epoch milliseconds — the
 * same tolerance as the expiry radar's `parseExpiryInstant`. Returns null for
 * anything unparseable; small numbers (< 1e8, i.e. before ~1973 as seconds)
 * are rejected rather than guessed at, so a port or a count never reads as a
 * date.
 */
export function parsePostureInstant(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1e8) return null;
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parsePostureInstant(Number(trimmed));
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  // Go-style timestamps ("2038-01-18 00:00:00 +0000 UTC") carry a zone name
  // after the numeric offset that Date.parse rejects.
  const goStyle = trimmed.replace(/ [A-Z]{3,4}$/, "");
  if (goStyle !== trimmed) {
    const reparsed = Date.parse(goStyle);
    if (!Number.isNaN(reparsed)) return reparsed;
  }
  return null;
}

/** Evaluate one {@link PostureCondition} against a stored field bag. */
export function evaluatePostureCondition(
  cond: PostureCondition,
  fields: Record<string, string | number | boolean> | undefined,
  now: number,
): boolean {
  const raw = fields?.[cond.fieldKey];
  if (cond.when === "empty") return raw == null || raw === "";
  if (raw == null) return false;
  if (cond.when === "olderThanDays") {
    const instant = parsePostureInstant(raw);
    if (instant === null) return false;
    return now - instant > cond.days * MS_PER_DAY;
  }
  if (cond.when === "truthy") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    return TRUE_WORDS.has(raw.trim().toLowerCase());
  }
  if (cond.when === "falsy") {
    if (typeof raw === "boolean") return !raw;
    if (typeof raw === "number") return raw === 0;
    return FALSE_WORDS.has(raw.trim().toLowerCase());
  }
  const actual = String(raw).toLowerCase();
  const expected = (cond.value ?? "").toLowerCase();
  if (cond.when === "equals") return actual === expected;
  return actual !== expected;
}

/**
 * Evaluate one {@link PostureCheckRule} against a resource instance's stored
 * fields. Returns the reason string when the resource is flagged, or `null`
 * when it isn't — the exact contract of `evaluateOrphanRule`.
 */
export function evaluatePostureRule(
  rule: PostureCheckRule | undefined,
  fields: Record<string, string | number | boolean> | undefined,
  now: number = Date.now(),
): string | null {
  if (!rule || rule.conditions.length === 0) return null;
  const matches = rule.conditions.every((cond) => evaluatePostureCondition(cond, fields, now));
  return matches ? rule.reason : null;
}
