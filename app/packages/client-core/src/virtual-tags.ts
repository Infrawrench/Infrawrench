/**
 * Virtual tags: tags the organization computes from its own rules rather than
 * tags a provider reported.
 *
 * Provider tags are what people managed to apply, in whatever spelling each
 * team chose: `env`, `Environment` and `ENV` on three accounts, a `team` tag on
 * half the estate, a shared database with no owner at all. A virtual tag is the
 * answer the organization actually wants to report on (one `env`, one `team`)
 * defined once, as an ordered rule list, and usable as a cost dimension
 * everywhere a provider tag is: graphs and reports, saved filters, budgets,
 * change alerts, allocation rules (and so showback), and exports.
 *
 * ## The model, stated once
 *
 * - **Ordered rules, first match wins.** Each rule is a cost-query-language
 *   filter (`provider = 'aws' AND service = 'AmazonRDS'`) plus what a matching
 *   row's value is. A row takes the value of the first rule that matches it;
 *   a row no rule matches takes the tag's `defaultValue`, or is "not set".
 * - **Four kinds of value.**
 *   `value` is a fixed string. `tag` reads the value from one of several
 *   provider tag keys, in order (key collapsing: `env`, `Environment`, `ENV`
 *   become one key), each with its own optional prefix and filter, and an
 *   optional case fold. `split` divides a matching row across several values
 *   by fixed percentages. `metric_split` divides it in proportion to business
 *   metrics, day by day.
 * - **Time bounds.** Any rule can carry `startsOn`/`endsOn` (inclusive UTC
 *   days), so a reorganisation can be recorded as "until March this was team A,
 *   from April it is team B" without rewriting history.
 * - **Computed at query time, never stored into `cost_daily`.** Exactly the
 *   stance billing rules take: collected spend stays what the provider
 *   reported, and editing a rule re-answers every past question immediately.
 *   Splits multiply the money by a weight; the weights of one row always sum to
 *   one, so a split never changes a total.
 * - **Processing status.** After an edit, a background pass evaluates the tag
 *   over the whole stored history (the backfill) and records what it found:
 *   how much spend each rule claims, how much is left unmatched, the values it
 *   produced, and any day a metric split had to fall back. That is what the
 *   status badge in Settings reports.
 *
 * Types live here rather than in `@infrawrench/ui` because mobile and the CLI
 * do not depend on that package, and the SQL compiler in `server-core` must
 * read exactly the shape the API validated.
 */
import { CostQueryParseError, parseCostQuery } from "./cost-query-language";
import type { CostFilter } from "./costs";

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export const VIRTUAL_TAG_RULE_KINDS = ["value", "tag", "split", "metric_split"] as const;
export type VirtualTagRuleKind = (typeof VIRTUAL_TAG_RULE_KINDS)[number];

export const VIRTUAL_TAG_RULE_KIND_LABELS: Record<VirtualTagRuleKind, string> = {
  value: "Fixed value",
  tag: "Copy from tag keys",
  split: "Split by percentage",
  metric_split: "Split by business metric",
};

export const VIRTUAL_TAG_RULE_KIND_DESCRIPTIONS: Record<VirtualTagRuleKind, string> = {
  value: "Every matching row gets the same value.",
  tag:
    "Read the value from provider tag keys, first present key wins. Use it to merge spellings " +
    "like env, Environment and ENV into one key, optionally prefixing or case-folding the value.",
  split:
    "Divide each matching row across several values by fixed percentages that add up to 100. " +
    "Totals never change; the money is shared, not copied.",
  metric_split:
    "Divide each matching row across several values in proportion to business metrics, day by " +
    "day: for example a shared database split by each team's request count.",
};

/** How a `tag` rule's copied value is case-folded. */
export const VIRTUAL_TAG_VALUE_TRANSFORMS = ["none", "lower", "upper"] as const;
export type VirtualTagValueTransform = (typeof VIRTUAL_TAG_VALUE_TRANSFORMS)[number];

export const VIRTUAL_TAG_VALUE_TRANSFORM_LABELS: Record<VirtualTagValueTransform, string> = {
  none: "Keep as written",
  lower: "lowercase",
  upper: "UPPERCASE",
};

/** Where a virtual tag's background evaluation stands. */
export const VIRTUAL_TAG_PROCESSING_STATES = ["pending", "processing", "ready", "failed"] as const;
export type VirtualTagProcessingState = (typeof VIRTUAL_TAG_PROCESSING_STATES)[number];

export const VIRTUAL_TAG_PROCESSING_STATE_LABELS: Record<VirtualTagProcessingState, string> = {
  pending: "Queued",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

/**
 * Key shape: what a tag key usually looks like across providers (letters,
 * digits, `_ - . : /`), starting with a letter or digit. Deliberately excludes
 * quotes and brackets so a key always renders inside `virtual_tag['…']`
 * without escaping, and so it reads as a key in a CSV header.
 */
export const VIRTUAL_TAG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

export const VIRTUAL_TAG_LIMITS = {
  maxKeyLength: 64,
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  maxValueLength: 256,
  maxPrefixLength: 64,
  maxTagsPerOrg: 100,
  maxRules: 100,
  maxSources: 10,
  maxAllocations: 20,
  /** Percent sums are compared to 100 within this tolerance (two decimals). */
  percentTolerance: 0.01,
} as const;

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** One provider tag key a `tag` rule reads from. */
export interface VirtualTagSource {
  tagKey: string;
  /** Prepended to the copied value, e.g. `aws-`. Null for none. */
  valuePrefix: string | null;
  /**
   * A cost-query-language filter that must also hold for this key to be used:
   * "read `Environment` only on the Azure accounts". Null or empty for always.
   */
  query: string | null;
}

/** One share of a split. Exactly one of `percent` / `metricId` is set, per kind. */
export interface VirtualTagAllocation {
  value: string;
  /** `split`: this value's share, 0 < percent ≤ 100; the shares sum to 100. */
  percent: number | null;
  /** `metric_split`: the business metric whose daily value weights this share. */
  metricId: string | null;
}

/**
 * One rule. Flat rather than a discriminated union for the reason billing
 * rules are: it is stored as jsonb, edited by one form, and mirrored by a
 * Terraform nested block, all of which want every field present.
 */
export interface VirtualTagRule {
  /** A cost-query-language filter. Empty matches every row. */
  query: string;
  description: string | null;
  /** Inclusive UTC day the rule starts applying. Null for "always has". */
  startsOn: string | null;
  /** Inclusive UTC day the rule stops applying. Null for "never stops". */
  endsOn: string | null;
  kind: VirtualTagRuleKind;
  /** `value`: the value. */
  value: string | null;
  /** `tag`: the keys to read, first present wins. */
  sources: VirtualTagSource[];
  /** `tag`: case fold applied to the copied value (before the prefix). */
  valueTransform: VirtualTagValueTransform;
  /** `split` / `metric_split`: the shares. */
  allocations: VirtualTagAllocation[];
}

/** What the processing pass found, over the whole stored history. */
export interface VirtualTagStats {
  /** Inclusive UTC day range evaluated; null when there was no spend. */
  from: string | null;
  to: string | null;
  /** One entry per currency: currencies are never merged. */
  currencies: VirtualTagCurrencyStats[];
  /**
   * Days a metric split could not weight from that day's metric values and
   * carried the last good weights forward (or split evenly when there were
   * none). Zero when the tag has no metric split.
   */
  metricFallbackDays: number;
  /** Distinct values the tag produced (not counting "not set"). */
  distinctValues: number;
}

export interface VirtualTagCurrencyStats {
  currency: string;
  total: number;
  /** Spend no rule matched (it took the default value, or is "not set"). */
  unmatched: number;
  /** Spend each rule claimed, aligned with `rules` at processing time. */
  byRule: number[];
  /** Largest values by spend, descending, at most ten. */
  topValues: Array<{ value: string; amount: number }>;
}

export interface VirtualTagStatus {
  state: VirtualTagProcessingState;
  /** When the last evaluation finished, successfully or not. */
  processedAt: string | null;
  /** Why the last evaluation failed; null otherwise. */
  error: string | null;
  /** Null until a first evaluation succeeds. */
  stats: VirtualTagStats | null;
}

/** A virtual tag, as the API returns it. */
export interface VirtualTag {
  id: string;
  /**
   * What filters, groupings and exports address the tag by:
   * `virtual_tag['team']`. Immutable once created, because saved filters,
   * budgets and reports store it; renaming the display name is free.
   */
  key: string;
  name: string;
  description: string | null;
  /** Value for rows no rule matches. Null leaves them "not set". */
  defaultValue: string | null;
  rules: VirtualTagRule[];
  status: VirtualTagStatus;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create/update payload (POST/PUT /virtual-tags). Updates are full replaces. */
export interface VirtualTagInput {
  key: string;
  name: string;
  description?: string | null | undefined;
  defaultValue?: string | null | undefined;
  rules: VirtualTagRule[];
}

export const DEFAULT_VIRTUAL_TAG_RULE: VirtualTagRule = {
  query: "",
  description: null,
  startsOn: null,
  endsOn: null,
  kind: "value",
  value: "",
  sources: [],
  valueTransform: "none",
  allocations: [],
};

export const DEFAULT_VIRTUAL_TAG_INPUT: VirtualTagInput = {
  key: "",
  name: "",
  description: null,
  defaultValue: null,
  rules: [],
};

/* ------------------------------------------------------------------ *
 * Normalisation and validation: shared by the editor and the API so
 * both refuse in the same words.
 * ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Trim strings, null out blanks, and drop the fields a rule's kind does not
 * use, so a rule switched from "split" to "fixed value" in the editor does not
 * carry its old allocations into storage.
 */
export function normalizeVirtualTagRule(rule: VirtualTagRule): VirtualTagRule {
  const kind = rule.kind;
  return {
    query: rule.query.trim(),
    description: blankToNull(rule.description),
    startsOn: blankToNull(rule.startsOn),
    endsOn: blankToNull(rule.endsOn),
    kind,
    value: kind === "value" ? (rule.value ?? "").trim() : null,
    sources:
      kind === "tag"
        ? rule.sources.map((s) => ({
            tagKey: s.tagKey.trim(),
            valuePrefix: s.valuePrefix && s.valuePrefix.length > 0 ? s.valuePrefix : null,
            query: blankToNull(s.query),
          }))
        : [],
    valueTransform: kind === "tag" ? rule.valueTransform : "none",
    allocations:
      kind === "split" || kind === "metric_split"
        ? rule.allocations.map((a) => ({
            value: a.value.trim(),
            percent: kind === "split" ? a.percent : null,
            metricId: kind === "metric_split" ? blankToNull(a.metricId) : null,
          }))
        : [],
  };
}

export function normalizeVirtualTagInput(input: VirtualTagInput): VirtualTagInput {
  return {
    key: input.key.trim(),
    name: input.name.trim(),
    description: blankToNull(input.description),
    defaultValue: blankToNull(input.defaultValue),
    rules: input.rules.map(normalizeVirtualTagRule),
  };
}

/**
 * Compile a rule or source filter, refusing what a virtual tag cannot mean.
 *
 * A filter on another virtual tag is refused rather than resolved: tags
 * referencing tags is a dependency graph with cycles to detect and an order to
 * evaluate in, for a use case one tag with more rules already covers.
 */
export function compileVirtualTagQuery(query: string | null): CostFilter[] {
  const text = query?.trim() ?? "";
  if (!text) return [];
  const filters = parseCostQuery(text);
  if (filters.some((f) => f.dimension === "virtual_tag")) {
    throw new Error(
      "A virtual tag rule cannot filter on another virtual tag. Filter on the provider tags, " +
        "accounts or services the other tag is built from instead.",
    );
  }
  return filters;
}

function queryError(query: string | null, where: string): string | null {
  try {
    compileVirtualTagQuery(query);
    return null;
  } catch (e) {
    if (e instanceof CostQueryParseError) {
      return `${where}: the filter does not parse at character ${e.offset + 1}: ${e.message}`;
    }
    return `${where}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function valueError(value: string, where: string): string | null {
  if (!value) return `${where}: the value cannot be empty.`;
  if (value.length > VIRTUAL_TAG_LIMITS.maxValueLength) {
    return `${where}: values are at most ${VIRTUAL_TAG_LIMITS.maxValueLength} characters.`;
  }
  return null;
}

/** The first thing wrong with one rule, or null. `index` is zero-based. */
export function virtualTagRuleError(rule: VirtualTagRule, index: number): string | null {
  const where = `Rule ${index + 1}`;
  const q = queryError(rule.query, where);
  if (q) return q;
  if (rule.description && rule.description.length > VIRTUAL_TAG_LIMITS.maxDescriptionLength) {
    return `${where}: the description is at most ${VIRTUAL_TAG_LIMITS.maxDescriptionLength} characters.`;
  }
  for (const [label, day] of [
    ["start date", rule.startsOn],
    ["end date", rule.endsOn],
  ] as const) {
    if (day !== null && (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))) {
      return `${where}: the ${label} must be a YYYY-MM-DD day.`;
    }
  }
  if (rule.startsOn && rule.endsOn && rule.startsOn > rule.endsOn) {
    return `${where}: the start date is after the end date, so the rule would never apply.`;
  }

  switch (rule.kind) {
    case "value":
      return valueError(rule.value ?? "", where);
    case "tag": {
      if (rule.sources.length === 0) return `${where}: choose at least one tag key to copy from.`;
      if (rule.sources.length > VIRTUAL_TAG_LIMITS.maxSources) {
        return `${where}: at most ${VIRTUAL_TAG_LIMITS.maxSources} tag keys per rule.`;
      }
      const seen = new Set<string>();
      for (const [i, source] of rule.sources.entries()) {
        const at = `${where}, key ${i + 1}`;
        if (!source.tagKey) return `${at}: the tag key cannot be empty.`;
        if (seen.has(source.tagKey)) {
          return `${at}: "${source.tagKey}" is listed twice; the second can never be used.`;
        }
        seen.add(source.tagKey);
        if (source.valuePrefix && source.valuePrefix.length > VIRTUAL_TAG_LIMITS.maxPrefixLength) {
          return `${at}: prefixes are at most ${VIRTUAL_TAG_LIMITS.maxPrefixLength} characters.`;
        }
        const sq = queryError(source.query, at);
        if (sq) return sq;
      }
      return null;
    }
    case "split":
    case "metric_split": {
      if (rule.allocations.length < 2) {
        return `${where}: a split needs at least two values; use a fixed value for one.`;
      }
      if (rule.allocations.length > VIRTUAL_TAG_LIMITS.maxAllocations) {
        return `${where}: at most ${VIRTUAL_TAG_LIMITS.maxAllocations} values per split.`;
      }
      const seen = new Set<string>();
      let sum = 0;
      for (const [i, allocation] of rule.allocations.entries()) {
        const at = `${where}, share ${i + 1}`;
        const v = valueError(allocation.value, at);
        if (v) return v;
        if (seen.has(allocation.value)) {
          return `${at}: "${allocation.value}" appears twice; give it one combined share.`;
        }
        seen.add(allocation.value);
        if (rule.kind === "split") {
          const p = allocation.percent;
          if (p === null || !Number.isFinite(p) || p <= 0 || p > 100) {
            return `${at}: the percentage must be more than 0 and at most 100.`;
          }
          sum += p;
        } else if (!allocation.metricId) {
          return `${at}: choose the business metric that weights this share.`;
        }
      }
      if (rule.kind === "split" && Math.abs(sum - 100) > VIRTUAL_TAG_LIMITS.percentTolerance) {
        return `${where}: the percentages add up to ${Number(sum.toFixed(2))}, not 100.`;
      }
      return null;
    }
  }
}

/** The first thing wrong with a whole input, or null. Run after normalising. */
export function virtualTagInputError(input: VirtualTagInput): string | null {
  if (!input.key) return "The key cannot be empty.";
  if (input.key.length > VIRTUAL_TAG_LIMITS.maxKeyLength) {
    return `The key is at most ${VIRTUAL_TAG_LIMITS.maxKeyLength} characters.`;
  }
  if (!VIRTUAL_TAG_KEY_PATTERN.test(input.key)) {
    return "The key may contain letters, digits and _ - . : / and must start with a letter or digit.";
  }
  if (!input.name) return "The name cannot be empty.";
  if (input.name.length > VIRTUAL_TAG_LIMITS.maxNameLength) {
    return `The name is at most ${VIRTUAL_TAG_LIMITS.maxNameLength} characters.`;
  }
  if (input.description && input.description.length > VIRTUAL_TAG_LIMITS.maxDescriptionLength) {
    return `The description is at most ${VIRTUAL_TAG_LIMITS.maxDescriptionLength} characters.`;
  }
  if (input.defaultValue && input.defaultValue.length > VIRTUAL_TAG_LIMITS.maxValueLength) {
    return `The default value is at most ${VIRTUAL_TAG_LIMITS.maxValueLength} characters.`;
  }
  if (input.rules.length > VIRTUAL_TAG_LIMITS.maxRules) {
    return `A virtual tag can have at most ${VIRTUAL_TAG_LIMITS.maxRules} rules.`;
  }
  if (input.rules.length === 0 && !input.defaultValue) {
    return "Add at least one rule (or a default value), or the tag would never be set.";
  }
  for (const [i, rule] of input.rules.entries()) {
    const error = virtualTagRuleError(rule, i);
    if (error) return error;
  }
  return null;
}

/** Whether any rule divides rows, which decides how the tag compiles to SQL. */
export function virtualTagSplits(rules: readonly VirtualTagRule[]): boolean {
  return rules.some((r) => r.kind === "split" || r.kind === "metric_split");
}

/** Business metric ids a tag's rules reference, de-duplicated, in rule order. */
export function virtualTagMetricIds(rules: readonly VirtualTagRule[]): string[] {
  const ids: string[] = [];
  for (const rule of rules) {
    if (rule.kind !== "metric_split") continue;
    for (const a of rule.allocations) {
      if (a.metricId && !ids.includes(a.metricId)) ids.push(a.metricId);
    }
  }
  return ids;
}

/** Every value a tag can produce from its fixed and split rules (not copied ones). */
export function virtualTagStaticValues(tag: Pick<VirtualTag, "rules" | "defaultValue">): string[] {
  const values = new Set<string>();
  for (const rule of tag.rules) {
    if (rule.kind === "value" && rule.value) values.add(rule.value);
    for (const a of rule.allocations) if (a.value) values.add(a.value);
  }
  if (tag.defaultValue) values.add(tag.defaultValue);
  return [...values].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ *
 * References: which virtual tags a query touches.
 * ------------------------------------------------------------------ */

/**
 * Virtual tag keys a set of filters and an optional grouping reference. The
 * readers load the org's definitions only when this is non-empty, so a query
 * that never mentions a virtual tag costs nothing extra.
 */
export function referencedVirtualTagKeys(
  filters: readonly CostFilter[],
  groupBy?: string | undefined,
  groupByTagKey?: string | undefined,
): string[] {
  const keys = new Set<string>();
  for (const f of filters) {
    if (f.dimension === "virtual_tag" && f.tagKey) keys.add(f.tagKey);
  }
  if (groupBy === "virtual_tag" && groupByTagKey) keys.add(groupByTagKey);
  return [...keys];
}

/* ------------------------------------------------------------------ *
 * Metric split weights: pure, so the processing pass and the query path
 * weight a day identically.
 * ------------------------------------------------------------------ */

/** Per-day weights for one metric split, aligned with its allocations. */
export interface MetricSplitWeights {
  /** Inclusive UTC days, ascending, covering the requested range. */
  days: string[];
  /** `weights[d][i]`: allocation `i`'s share of day `days[d]`; each row sums to 1. */
  weights: number[][];
  /** Days weighted by carry-forward or an even split rather than that day's values. */
  fallbackDays: number;
}

function addUtcDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Weights for each day in `[from, to]`, in proportion to each allocation's
 * metric value that day.
 *
 * A day is weighted from its own values only when **every** share reported a
 * value and the values sum to more than zero: a share with no report that day
 * is "we do not know", and treating it as zero would hand that team's whole
 * share to the others. Such a day carries the most recent good day's weights
 * forward (`history` may reach back before `from` for exactly this reason),
 * and a day with no good day before it splits evenly. Either way the row's
 * weights sum to one, so a split can never change a total.
 *
 * `values[i]` maps day → value for allocation `i`'s metric.
 */
export function computeMetricSplitWeights(
  values: ReadonlyArray<ReadonlyMap<string, number>>,
  from: string,
  to: string,
): MetricSplitWeights {
  const n = values.length;
  const even = n > 0 ? Array.from({ length: n }, () => 1 / n) : [];
  const days: string[] = [];
  const weights: number[][] = [];
  let fallbackDays = 0;
  if (n === 0 || from > to) return { days, weights, fallbackDays };

  // The last good weights on or before `from`, from whatever history the
  // caller supplied: the carry-forward seed.
  const goodWeights = (day: string): number[] | null => {
    const row = values.map((m) => m.get(day));
    if (row.some((v) => v === undefined || !Number.isFinite(v) || v < 0)) return null;
    const sum = (row as number[]).reduce((s, v) => s + v, 0);
    if (!(sum > 0)) return null;
    return (row as number[]).map((v) => v / sum);
  };

  let carry: number[] | null = null;
  const historyDays = new Set<string>();
  for (const m of values) for (const day of m.keys()) if (day < from) historyDays.add(day);
  for (const day of [...historyDays].sort()) {
    const w = goodWeights(day);
    if (w) carry = w;
  }

  for (let day = from; day <= to; day = addUtcDays(day, 1)) {
    const w = goodWeights(day);
    days.push(day);
    if (w) {
      carry = w;
      weights.push(w);
    } else {
      fallbackDays += 1;
      weights.push(carry ?? even);
    }
  }
  return { days, weights, fallbackDays };
}

/* ------------------------------------------------------------------ *
 * Describing a rule in one line, for lists, the CLI and MCP output.
 * ------------------------------------------------------------------ */

function bounds(rule: VirtualTagRule): string {
  if (rule.startsOn && rule.endsOn) return ` from ${rule.startsOn} to ${rule.endsOn}`;
  if (rule.startsOn) return ` from ${rule.startsOn}`;
  if (rule.endsOn) return ` until ${rule.endsOn}`;
  return "";
}

/**
 * "provider = 'aws' → 'platform'" style summary. `metricName` resolves a
 * metric id to its display name where the caller has the list.
 */
export function describeVirtualTagRule(
  rule: VirtualTagRule,
  metricName: (id: string) => string = (id) => id,
): string {
  const scope = rule.query ? rule.query : "everything";
  let output: string;
  switch (rule.kind) {
    case "value":
      output = `'${rule.value ?? ""}'`;
      break;
    case "tag": {
      const keys = rule.sources
        .map((s) => `${s.tagKey}${s.valuePrefix ? ` (prefix '${s.valuePrefix}')` : ""}`)
        .join(", ");
      const fold = rule.valueTransform === "none" ? "" : `, ${rule.valueTransform}case`;
      output = `copy of ${keys}${fold}`;
      break;
    }
    case "split":
      output = rule.allocations.map((a) => `'${a.value}' ${a.percent ?? 0}%`).join(" / ");
      break;
    case "metric_split":
      output = rule.allocations
        .map((a) => `'${a.value}' by ${a.metricId ? metricName(a.metricId) : "?"}`)
        .join(" / ");
      break;
  }
  return `${scope} → ${output}${bounds(rule)}`;
}
