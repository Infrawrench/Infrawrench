/**
 * The capacity contract: a resource's own usage measured against a ceiling
 * that will stop it. A disk filling, a database reaching its plan's size cap,
 * connections approaching `max_connections`, a monthly allowance of compute
 * hours or sends that runs out before the cycle resets.
 *
 * Quotas (`quotas.ts`) are the sibling for *account* limits a provider
 * enforces through a quota API. These are limits on a single resource, and
 * the numbers are already in what the type's lister stores: a field holding
 * bytes used next to a field holding the volume size, a plan name next to a
 * usage counter. So, like `expiryFields`, `orphanRule` and `postureChecks`, a
 * declaration here costs no provider call: the host reads the synced `fields`
 * (and non-sensitive resolved outputs), records them as a series on every
 * sync, and fits the trend itself.
 *
 * Per-field metadata lives on the field. A field or output whose value is a
 * usage carries `usage: { limit: ... }` (see {@link CapacityUsageDeclaration});
 * there is no parallel list naming fields by key. Metric series are the one
 * exception, because a series has no definition object to hang a flag on: a
 * type names them in `capacityMetrics` by their exact `MetricSeries.label`,
 * the way `rightsizing.cpuMetric` already does.
 *
 * **Where the limit comes from is part of the declaration and reaches the
 * reader.** A limit read from another field is the provider's own number (a
 * resized volume, an approved increase). A plan allowance or a constant is a
 * published number the plugin carries, and the surface says so, because a
 * customer on a negotiated contract may have a different one.
 */

/** Where a usage's ceiling comes from. */
export type CapacityLimitSource =
  /**
   * Another field (or non-sensitive output) on the same resource holds the
   * limit, as the provider reports it: a disk's size beside its used bytes,
   * `max_connections` beside the connection count. Preferred whenever the
   * provider states the limit, because it follows resizes and increases.
   *
   * `scale` converts the limit field into the usage's unit when they differ
   * (a size in GiB beside a usage in bytes: `scale: 1024 ** 3`).
   */
  | { field: string; scale?: number }
  /**
   * The plan the resource is on, read from `field`, looked up in
   * `allowances` (the provider's published allowance per plan, in the usage's
   * unit). Plan values are matched case-insensitively; a plan missing from
   * the table yields no row rather than a guessed limit, and so does a plan
   * with no cap (leave it out of the table).
   */
  | { plan: { field: string; allowances: Readonly<Record<string, number>> } }
  /**
   * A fixed ceiling the provider documents for every instance of the type
   * (100 for a percentage series, a hard per-database size cap).
   */
  | { constant: number };

/**
 * A monthly allowance: usage that accumulates through a billing cycle and
 * resets at its start. The host projects *end-of-cycle* usage for these
 * rather than a crossing date far in the future, because the counter will be
 * back at zero long before a linear fit crosses anything.
 */
export interface CapacityCycle {
  period: "monthly";
  /**
   * Field holding the current cycle's start instant (ISO 8601 or a unix
   * epoch in seconds or milliseconds). Preferred whenever the provider
   * reports it, because billing cycles are anchored on the subscription date,
   * not on the first of the month.
   */
  startField?: string;
  /**
   * Field holding the current cycle's end instant, when the provider reports
   * one. Without it the cycle ends one calendar month after its start; with
   * it alone, the cycle is the month before it.
   */
  endField?: string;
  /**
   * Day of the month (1 to 28, UTC) the cycle starts on when no `startField`
   * is declared or the field is empty. Defaults to 1.
   */
  anchorDay?: number;
}

/**
 * Declares that a field's (or output's) value is a usage with a limit.
 *
 * The value must be a number, or a numeric string, in `unit`. Anything else
 * (absent, empty, `"unlimited"`) yields no row, never a zero.
 */
export interface CapacityUsageDeclaration {
  /** Where the ceiling comes from; see {@link CapacityLimitSource}. */
  limit: CapacityLimitSource;
  /**
   * What both numbers count. `"bytes"` renders as binary sizes; anything else
   * (`"connections"`, `"hours"`, `"emails"`, `"%"`) is printed verbatim.
   */
  unit?: string;
  /** Present when this is a monthly allowance; see {@link CapacityCycle}. */
  cycle?: CapacityCycle;
  /**
   * Row label on the runway list. Defaults to the field's own `label`. Set it
   * when the field label alone would not say what runs out ("Storage" for a
   * field labelled "Size").
   */
  label?: string;
}

/**
 * A usage read from a metric series the type's `fetchMetricSeries` emits,
 * which only exists for resources whose metrics the host stores (resources
 * pinned to a dashboard). No `cycle`: a sampled gauge does not reset monthly.
 */
export interface CapacityMetricDeclaration extends Omit<CapacityUsageDeclaration, "cycle"> {
  /** Exact `MetricSeries.label` of the usage series. */
  seriesLabel: string;
}

/** One declared usage on a type, normalised across fields, outputs and metrics. */
export interface CapacityDeclarationEntry {
  /**
   * Stable identity within the resource: the field or output key, or
   * `metric:<series label>`. Survives a relabel of the field, so a series
   * keeps its history.
   */
  key: string;
  /** Where the usage value is read. */
  source: "field" | "output" | "metric";
  /** The field key, output key or series label holding the usage. */
  valueKey: string;
  /** Row label: the declaration's own, else the field's or series' label. */
  label: string;
  declaration: CapacityUsageDeclaration;
}

/**
 * The parts of a resource type the capacity helpers read. Optional so a
 * partial type (a test double, an older edge registry entry) reads as
 * declaring nothing rather than throwing.
 */
interface CapacityTypeShape {
  fields?: ReadonlyArray<{ key: string; label: string; usage?: CapacityUsageDeclaration }>;
  outputs?: ReadonlyArray<{
    key: string;
    label: string;
    sensitive: boolean;
    usage?: CapacityUsageDeclaration;
  }>;
  capacityMetrics?: ReadonlyArray<CapacityMetricDeclaration>;
}

/**
 * Every usage a type declares, fields first, then outputs, then metrics.
 * Sensitive outputs are skipped: their values are encrypted at rest and never
 * leave the plugin as plain numbers.
 */
export function capacityDeclarations(type: CapacityTypeShape): CapacityDeclarationEntry[] {
  const out: CapacityDeclarationEntry[] = [];
  for (const field of type.fields ?? []) {
    if (!field.usage) continue;
    out.push({
      key: field.key,
      source: "field",
      valueKey: field.key,
      label: field.usage.label ?? field.label,
      declaration: field.usage,
    });
  }
  for (const output of type.outputs ?? []) {
    if (!output.usage || output.sensitive) continue;
    out.push({
      key: output.key,
      source: "output",
      valueKey: output.key,
      label: output.usage.label ?? output.label,
      declaration: output.usage,
    });
  }
  for (const metric of type.capacityMetrics ?? []) {
    out.push({
      key: `metric:${metric.seriesLabel}`,
      source: "metric",
      valueKey: metric.seriesLabel,
      label: metric.label ?? metric.seriesLabel,
      declaration: metric,
    });
  }
  return out;
}

/** True when the type declares at least one usage with a limit. */
export function typeHasCapacity(type: CapacityTypeShape): boolean {
  return (
    (type.fields ?? []).some((f) => f.usage !== undefined) ||
    (type.outputs ?? []).some((o) => o.usage !== undefined && !o.sensitive) ||
    (type.capacityMetrics?.length ?? 0) > 0
  );
}

/**
 * A stored value as a finite number, or null. Accepts numbers and numeric
 * strings (listers that stringify every field), nothing else: `""`,
 * `"unlimited"` and `null` are "no reading", never zero.
 */
export function readCapacityNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A resolved ceiling, with where it came from for the reader. */
export interface ResolvedCapacityLimit {
  limit: number;
  /** `provider` for a field limit, `plan` for a plan allowance, `constant` otherwise. */
  source: "provider" | "plan" | "constant";
  /** The plan value the allowance was looked up by, for `source: "plan"`. */
  plan: string | null;
}

/**
 * Resolve a declaration's ceiling against a resource's stored values
 * (`fields` merged with its non-sensitive outputs). Null when the limit
 * cannot be stated: an empty field, a plan the table does not list, a
 * non-positive number. Never a guess.
 */
export function resolveCapacityLimit(
  source: CapacityLimitSource,
  values: Readonly<Record<string, unknown>>,
): ResolvedCapacityLimit | null {
  if ("constant" in source) {
    return Number.isFinite(source.constant) && source.constant > 0
      ? { limit: source.constant, source: "constant", plan: null }
      : null;
  }
  if ("field" in source) {
    const raw = readCapacityNumber(values[source.field]);
    if (raw === null) return null;
    const limit = raw * (source.scale ?? 1);
    return Number.isFinite(limit) && limit > 0 ? { limit, source: "provider", plan: null } : null;
  }
  const planValue = values[source.plan.field];
  if (typeof planValue !== "string" || planValue.trim() === "") return null;
  const wanted = planValue.trim().toLowerCase();
  for (const [plan, allowance] of Object.entries(source.plan.allowances)) {
    if (plan.toLowerCase() !== wanted) continue;
    return Number.isFinite(allowance) && allowance > 0
      ? { limit: allowance, source: "plan", plan: planValue.trim() }
      : null;
  }
  return null;
}
