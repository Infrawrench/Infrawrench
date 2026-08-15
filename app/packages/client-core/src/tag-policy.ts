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
import type { CostConversion } from "./costs";
import type { CostAdjustmentSummary } from "./billing-rules";

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
  // Whichever of `=` or `:` appears first wins, so values may contain the
  // other separator (e.g. `url=https://example.com` or `note:a=b`).
  const eqIdx = trimmed.indexOf("=");
  const colonIdx = trimmed.indexOf(":");
  const idx = eqIdx >= 0 && colonIdx >= 0 ? Math.min(eqIdx, colonIdx) : Math.max(eqIdx, colonIdx);
  if (idx < 0) {
    out[trimmed] = "";
    return;
  }
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
  /**
   * The centre this one sits under; null is a top-level centre. Nesting is a
   * reporting structure — "what does Engineering cost" is the subtree, not one
   * bucket — and changes nothing about matching: allocation still resolves
   * every cost row to exactly one centre. An org that never sets a parent is a
   * flat list of roots and reports exactly as it did before this field existed.
   */
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Bounds the API enforces on the cost-centre tree.
 *
 * `maxDepth` is the deepest a centre may sit (a root is depth 1). Four levels
 * covers the division → team → product scheme this exists for with one spare
 * for the environment/region split teams add underneath, and an unbounded
 * self-referencing column is how a tree view ends up recursing forever on bad
 * data.
 */
export const COST_CENTRE_LIMITS = {
  maxNameLength: 120,
  maxDepth: 4,
} as const;

/** Depth of each centre, roots at 0. Unknown/cyclic parents are treated as roots. */
export function costCentreDepths(centres: readonly CostCentre[]): Map<string, number> {
  const byId = new Map(centres.map((c) => [c.id, c]));
  const depths = new Map<string, number>();

  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const centre = byId.get(id);
    const parentId = centre?.parentId ?? null;
    // A parent that is missing (deleted, cross-org) or part of a cycle makes
    // this centre a root rather than an unreachable node — spend never hides.
    const depth =
      parentId === null || parentId === id || !byId.has(parentId) || seen.has(parentId)
        ? 0
        : depthOf(parentId, new Set(seen).add(parentId)) + 1;
    depths.set(id, depth);
    return depth;
  };

  for (const centre of centres) depthOf(centre.id, new Set([centre.id]));
  return depths;
}

/** One centre's place in the tree, as the pickers and settings list render it. */
export interface CostCentrePathRow {
  id: string;
  name: string;
  /** "Engineering → Platform" — unambiguous where indentation alone is not. */
  path: string;
  /** 0 for a root. */
  depth: number;
}

/**
 * The org's centres in depth-first order — each immediately followed by its
 * children, siblings name-sorted — with the full path to each.
 *
 * One implementation for the settings tree, the move picker and the rule
 * editor's centre dropdown, so "Platform" under Engineering never reads as the
 * same thing as "Platform" under Data. Centres whose parent is missing or
 * cyclic surface as roots rather than disappearing from the list.
 */
export function costCentrePaths(centres: readonly CostCentre[]): CostCentrePathRow[] {
  const byId = new Map(centres.map((c) => [c.id, c]));
  const sorted = [...centres].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  const children = new Map<string, CostCentre[]>();
  const roots: CostCentre[] = [];
  for (const centre of sorted) {
    const parentId = centre.parentId;
    if (parentId === null || parentId === centre.id || !byId.has(parentId)) {
      roots.push(centre);
      continue;
    }
    children.set(parentId, [...(children.get(parentId) ?? []), centre]);
  }

  const rows: CostCentrePathRow[] = [];
  const seen = new Set<string>();
  const walk = (centre: CostCentre, depth: number, prefix: string): void => {
    if (seen.has(centre.id)) return; // cycle guard
    seen.add(centre.id);
    const path = prefix ? `${prefix} → ${centre.name}` : centre.name;
    rows.push({ id: centre.id, name: centre.name, path, depth });
    for (const child of children.get(centre.id) ?? []) walk(child, depth + 1, path);
  };
  for (const root of roots) walk(root, 0, "");
  for (const centre of sorted) walk(centre, 0, "");
  return rows;
}

/** Levels in the subtree rooted at `centreId`, counting itself — a leaf is 1. */
function costCentreSubtreeHeight(centres: readonly CostCentre[], centreId: string): number {
  const children = new Map<string, string[]>();
  for (const c of centres) {
    if (c.parentId === null || c.parentId === c.id) continue;
    const list = children.get(c.parentId) ?? [];
    list.push(c.id);
    children.set(c.parentId, list);
  }
  const height = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    let deepest = 0;
    for (const child of children.get(id) ?? []) deepest = Math.max(deepest, height(child, seen));
    return 1 + deepest;
  };
  return height(centreId, new Set());
}

/**
 * Why placing `subjectId` (null when creating a new centre) under
 * `newParentId` is not allowed — or null when it is.
 *
 * This is the rule the server enforces with a 400 on POST/PUT
 * /cost-centres, shared here so the move picker greys out exactly the targets
 * the server would reject:
 *
 * - the parent must exist (in the caller's org — the server only ever passes
 *   the org's own centres in);
 * - a centre cannot be moved inside itself or one of its descendants, the only
 *   way `parent_id` could ever form a cycle;
 * - the result must respect {@link COST_CENTRE_LIMITS.maxDepth} for the *whole*
 *   subtree being moved, not just the centre itself.
 */
export function costCentreMoveBlocker(
  centres: readonly CostCentre[],
  subjectId: string | null,
  newParentId: string | null,
): string | null {
  const maxDepth = COST_CENTRE_LIMITS.maxDepth;
  const byId = new Map(centres.map((c) => [c.id, c]));

  if (newParentId !== null) {
    if (!byId.has(newParentId)) return "Unknown parent cost centre.";
    if (subjectId !== null) {
      const seen = new Set<string>();
      for (
        let cursor: string | null = newParentId;
        cursor !== null && !seen.has(cursor);
        cursor = byId.get(cursor)?.parentId ?? null
      ) {
        if (cursor === subjectId) {
          return "A cost centre cannot be moved inside itself or one of its own children.";
        }
        seen.add(cursor);
      }
    }
  }

  const parentDepth =
    newParentId === null ? 0 : (costCentreDepths(centres).get(newParentId) ?? 0) + 1;
  const subtreeHeight = subjectId === null ? 1 : costCentreSubtreeHeight(centres, subjectId);
  if (parentDepth + subtreeHeight > maxDepth) {
    return `Cost centres can be nested at most ${maxDepth} levels deep.`;
  }
  return null;
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

/**
 * The org's rules in evaluation order — the order the showback reader compiles
 * into its single `multiIf`, and the order the settings UI must display so
 * "first match wins" means what the list shows.
 *
 * The existing rule is unchanged: **lower priority number fires first, first
 * match wins**, so a row is allocated exactly once no matter how many rules
 * could have claimed it. Nesting only adds a tie-break underneath it: at the
 * *same* priority the more deeply nested centre goes first, so a parent-level
 * catch-all ("everything on GCP → Engineering") written at the same priority as
 * a child rule ("tag team=search → Search") does not silently swallow the
 * child's spend. The row lands on the child, and the parent still gets it back
 * through its subtree total.
 *
 * A flat org has every centre at depth 0, so the tie-break never fires and the
 * order is exactly what it was: priority, then creation time.
 */
export function orderAllocationRules(
  rules: readonly AllocationRule[],
  centres: readonly CostCentre[],
): AllocationRule[] {
  const depths = costCentreDepths(centres);
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const depthDiff = (depths.get(b.costCentreId) ?? 0) - (depths.get(a.costCentreId) ?? 0);
    if (depthDiff !== 0) return depthDiff;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

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
  /**
   * Currency → spend allocated **directly** to this centre in the range.
   *
   * Deliberately unchanged in meaning by nesting: a row is allocated to exactly
   * one centre, so summing `totals` across the whole list still equals the
   * org's spend for the period. A reader that adds these up cannot be made to
   * double count by someone rearranging the tree.
   */
  totals: Record<string, number>;
  /**
   * Currency → this centre's `totals` plus every descendant's. Equal to
   * `totals` for a leaf, and for every centre in an org that never nests —
   * which is what makes an existing flat report byte-identical apart from the
   * added fields. "Engineering, of which Platform" needs both numbers, so both
   * are reported rather than only the sum.
   */
  subtreeTotals: Record<string, number>;
  /** The centre this one sits under; null for a root and for Unallocated. */
  parentId: string | null;
  /** 0 for a root; indentation depth in the rendered tree. */
  depth: number;
}

/** Spend grouped by cost centre via the org's allocation rules. */
export interface ShowbackReport {
  from: string;
  to: string;
  currencies: string[];
  /**
   * Depth-first: every centre immediately followed by its children, siblings
   * name-sorted, with the "Unallocated" bucket last. A flat org gets the same
   * name-sorted list it always got.
   */
  centres: ShowbackReportCentre[];
  /**
   * Set when the amounts above were converted into the org's display currency.
   * Absent means they are exactly as collected. See `CostConversion` in
   * `./costs` — a chargeback number that silently mixed currencies would be
   * billed to a team that could not reconcile it.
   */
  conversion?: CostConversion;
  /**
   * Set when the request asked for the org's billing rules to be applied.
   * Absent means every figure above is exactly what the providers charged.
   *
   * Carries the collected totals and the rules that moved them, so a chargeback
   * statement can always show the internal figure beside the invoice figure.
   * See `CostAdjustmentSummary` in `./billing-rules`.
   */
  adjustment?: CostAdjustmentSummary;
}

function addTotals(into: Record<string, number>, from: Record<string, number>): void {
  for (const [currency, amount] of Object.entries(from)) {
    into[currency] = (into[currency] ?? 0) + amount;
  }
}

/**
 * Assemble the showback tree from the flat per-centre sums the single
 * ClickHouse pass produced.
 *
 * The query resolves each cost row to exactly one centre id; the rollup here is
 * pure arithmetic on top of that, which is what keeps the report to one scan of
 * `cost_daily` no matter how deep the tree is. Every defined centre appears,
 * even at zero — a centre missing from a chargeback report reads as data loss,
 * not an empty bucket — and unmatched spend keeps its own first-class row.
 *
 * Malformed trees degrade rather than vanish: a centre whose parent is missing,
 * self-referencing, or part of a cycle is emitted as a root, so no amount can
 * be orphaned out of the report by bad data.
 */
export function buildShowbackCentres(
  centres: readonly CostCentre[],
  ownTotalsByCentreId: ReadonlyMap<string, Record<string, number>>,
  unallocatedTotals?: Record<string, number> | undefined,
): ShowbackReportCentre[] {
  const byId = new Map(centres.map((c) => [c.id, c]));
  const byName = [...centres].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  const children = new Map<string, CostCentre[]>();
  const roots: CostCentre[] = [];
  for (const centre of byName) {
    const parentId = centre.parentId;
    if (parentId === null || parentId === centre.id || !byId.has(parentId)) {
      roots.push(centre);
      continue;
    }
    const list = children.get(parentId) ?? [];
    list.push(centre);
    children.set(parentId, list);
  }

  const out: ShowbackReportCentre[] = [];
  const emitted = new Set<string>();

  // Post-order for the subtree sums, pre-order for the emitted rows — one walk
  // does both: push the row, recurse, then fold the children's sums back in.
  const walk = (centre: CostCentre, depth: number): Record<string, number> => {
    emitted.add(centre.id);
    const own = { ...(ownTotalsByCentreId.get(centre.id) ?? {}) };
    const subtree: Record<string, number> = { ...own };
    const entry: ShowbackReportCentre = {
      costCentreId: centre.id,
      name: centre.name,
      totals: own,
      subtreeTotals: subtree,
      parentId: centre.parentId,
      depth,
    };
    out.push(entry);
    for (const child of children.get(centre.id) ?? []) {
      if (emitted.has(child.id)) continue; // cycle guard
      addTotals(subtree, walk(child, depth + 1));
    }
    return subtree;
  };

  for (const root of roots) walk(root, 0);
  // Anything left is inside a cycle — surface it as a root rather than lose it.
  for (const centre of byName) if (!emitted.has(centre.id)) walk(centre, 0);

  if (unallocatedTotals && Object.keys(unallocatedTotals).length > 0) {
    out.push({
      costCentreId: null,
      name: "Unallocated",
      totals: { ...unallocatedTotals },
      subtreeTotals: { ...unallocatedTotals },
      parentId: null,
      depth: 0,
    });
  }
  return out;
}

/**
 * Whether a showback row has at least one other row nested under it, which is
 * what decides whether the tree prints the smaller "own" figure beneath the
 * subtree total.
 *
 * `null` is overloaded in `ShowbackReportCentre`: it marks both "no parent"
 * (`parentId`) and "the synthetic Unallocated row" (`costCentreId`). Naively
 * testing `other.parentId === centre.costCentreId` lets those meanings
 * collide — every root's `parentId` is `null`, so the Unallocated row (whose
 * own `costCentreId` is also `null`) reads every root as its child. Requiring
 * `centre.costCentreId` to be non-null first closes that hole and, as a side
 * effect, makes Unallocated correctly report no children at all: its total
 * and subtree total are always identical (see `buildShowbackCentres`), so it
 * has nothing smaller to show underneath.
 */
export function showbackCentreHasChildren(
  centres: readonly ShowbackReportCentre[],
  centre: ShowbackReportCentre,
): boolean {
  if (centre.costCentreId === null) return false;
  return centres.some((other) => other.parentId === centre.costCentreId);
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
