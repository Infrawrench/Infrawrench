// Pure presentation helpers shared by the newer read commands. Kept out of the
// command modules (those reach the network through `./context`, which drags in
// Electron and every plugin) so the tree walk and the number formatting can be
// unit-tested on their own. Imports nothing but `./output`.
import { c } from "./output";

/* ------------------------------------------------------------------ *
 * ASCII trees (`infrawrench graph`)
 * ------------------------------------------------------------------ */

export interface TreeChild {
  id: string;
  /** Caption printed after the node's label: how the link reads. */
  caption: string;
}

export interface RenderTreeOptions {
  /** Depth cap; a branch that deep is a fan-out nobody reads in a terminal. */
  maxDepth?: number;
  /**
   * Ids already considered visited when the walk starts: normally just the
   * root, so a link straight back to it is marked rather than followed.
   */
  seen?: Set<string>;
}

/**
 * Render an indented tree as lines. `childrenOf` decides which way the walk
 * runs, so one renderer draws both "what this depends on" and "what depends on
 * this"; `labelOf` returns null for an id with no node, which drops the branch.
 *
 * A node already on the current path is printed once more with `↺` and not
 * descended into: reference cycles are possible in principle (nothing forbids
 * A→B→A) and a plain recursion would never come back. A branch stopped by the
 * depth cap is marked `…` instead.
 */
export function renderTree(
  rootId: string,
  childrenOf: (id: string) => TreeChild[],
  labelOf: (id: string) => string | null,
  options: RenderTreeOptions = {},
): string[] {
  const maxDepth = options.maxDepth ?? 12;
  const seen = options.seen ?? new Set<string>([rootId]);
  const lines: string[] = [];

  const walk = (id: string, prefix: string, depth: number): void => {
    const children = childrenOf(id);
    children.forEach((child, index) => {
      const label = labelOf(child.id);
      if (label === null) return;
      const last = index === children.length - 1;
      const revisit = seen.has(child.id);
      const capped = depth + 1 >= maxDepth;
      const marker = revisit ? ` ${c.dim("↺")}` : capped ? ` ${c.dim("…")}` : "";
      lines.push(
        `${prefix}${c.dim(last ? "└─ " : "├─ ")}${label}  ${c.dim(child.caption)}${marker}`,
      );
      if (revisit || capped) return;
      seen.add(child.id);
      walk(child.id, `${prefix}${last ? "   " : c.dim("│  ")}`, depth + 1);
    });
  };

  walk(rootId, "", 0);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Cost anomalies
 * ------------------------------------------------------------------ */

/**
 * "+173%" over baseline. Null when there is no baseline to be up from (a key
 * with no trailing spend reads as "new" rather than as an infinite jump) and
 * null for a new-spend-source row whatever its baseline rounds to, since a
 * near-zero window rounds to a cent and would print a meaningless six-figure
 * percentage. Same rule as the web/desktop Anomalies section.
 */
export function anomalyDeltaPercent(
  actualCents: number,
  baselineCents: number,
  kind: "spike" | "new_source" = "spike",
): string | null {
  if (kind === "new_source") return null;
  if (baselineCents <= 0) return null;
  const pct = ((actualCents - baselineCents) / baselineCents) * 100;
  return `+${Math.round(pct)}%`;
}

/* ------------------------------------------------------------------ *
 * Cost reports
 * ------------------------------------------------------------------ */

/**
 * Resolve `infrawrench reports <query>` to one row: an exact id, then an exact
 * (case-insensitive) name, then a unique substring of a name.
 *
 * Reports are addressed by name in conversation ("run the monthly spend one"),
 * so accepting a name is the point; the ordering exists so a report literally
 * named like another's prefix still wins its own exact match. An ambiguous
 * substring returns `null` with the candidates rather than silently picking
 * the first: running the wrong cost report is a quiet, plausible-looking
 * wrong answer.
 */
export function matchCostReport<T extends { id: string; name: string }>(
  reports: readonly T[],
  query: string,
): { match: T } | { match: null; candidates: T[] } {
  const q = query.trim().toLowerCase();
  const byId = reports.find((r) => r.id === query.trim());
  if (byId) return { match: byId };
  const exactName = reports.filter((r) => r.name.trim().toLowerCase() === q);
  if (exactName.length === 1) return { match: exactName[0]! };
  if (exactName.length > 1) return { match: null, candidates: exactName };
  const partial = reports.filter((r) => r.name.toLowerCase().includes(q));
  if (partial.length === 1) return { match: partial[0]! };
  return { match: null, candidates: partial };
}

/* ------------------------------------------------------------------ *
 * PDF export (`reports --format pdf`, `dashboards --format pdf`)
 * ------------------------------------------------------------------ */

/**
 * The download name for an exported PDF: `Monthly spend` becomes
 * `monthly-spend.pdf`. A local re-derivation of client-core's `pdfFileName`
 * (the CLI keeps its client-core imports type-only), so the file the CLI
 * writes is named the same as the one the browser downloads.
 */
export function pdfFileName(name: string, fallback = "infrawrench-export"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `${slug || fallback}.pdf`;
}

/** `1.4 MB`: a byte count, the way a file manager says it. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = value;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/* ------------------------------------------------------------------ *
 * Change timeline
 * ------------------------------------------------------------------ */

/** `2026-07-30 14:05` in UTC: sortable, and stable across machines. */
export function formatChangeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Metric alerts
 * ------------------------------------------------------------------ */

/**
 * `"CPU % > 90 for 15m"`: one line for a rule's condition. A local twin of
 * client-core's `describeMetricAlertCondition`: the CLI can only take
 * type-only imports from client-core (CJS→ESM), so the formatting lives here
 * where it is unit-testable without Electron.
 */
export function formatMetricAlertCondition(rule: {
  metricKey: string;
  comparator: string;
  threshold: number;
  forMinutes: number;
}): string {
  return `${rule.metricKey} ${rule.comparator} ${rule.threshold} for ${rule.forMinutes}m`;
}

/** `"aws · ec2-instance · env=prod"`, or `"all resources"` when unscoped. */
export function formatMetricAlertSelector(rule: {
  pluginId: string | null;
  resourceTypeId: string | null;
  tagKey: string | null;
  tagValue: string | null;
}): string {
  const parts: string[] = [];
  if (rule.pluginId) parts.push(rule.pluginId);
  if (rule.resourceTypeId) parts.push(rule.resourceTypeId);
  if (rule.tagKey) parts.push(rule.tagValue ? `${rule.tagKey}=${rule.tagValue}` : rule.tagKey);
  return parts.length > 0 ? parts.join(" · ") : "all resources";
}

/**
 * A unit-cost ratio for a terminal, or an em dash for a gap.
 *
 * Pure and here rather than in the command so `cli-format.test.ts` can reach
 * it, and because the gap rule is the one piece of this feature that must be
 * identical everywhere: `null` prints as "; ", never as "0" or "0.00". A CLI
 * that printed a zero for an unmeasured period would be believed exactly as
 * readily as a chart that drew one.
 *
 * Unit costs are routinely sub-cent (cost per API request), so this keeps
 * significant digits rather than rounding a real number to `0.00`, which is
 * the same lie by a different route.
 */
export function formatUnitCostRatio(value: number | null, mode: "unit_cost" | "margin"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (mode === "margin") return `${(value * 100).toFixed(1)}%`;
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(2);
  if (magnitude >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
}

/** The column header a ratio belongs under: "USD/customer", or "margin". */
export function unitCostRatioLabel(
  mode: "unit_cost" | "margin",
  currency: string,
  unit: string,
): string {
  return mode === "margin" ? "margin" : `${currency}/${unit || "unit"}`;
}

/**
 * A billing rule as one line: "+15% on tag team=platform", "1000 USD/month →
 * cost centre <id>", "move to account <id> on service AmazonEKS".
 *
 * Duplicated here rather than imported from `describeBillingRule` in
 * client-core for the reason every wire type in this CLI is imported type-only:
 * the CLI is CJS and client-core is ESM, so a *runtime* import would be a
 * `await import(...)` in a formatter that has to stay synchronous and pure.
 * Pure and here means `cli-format.test.ts` can reach it, which is the only way
 * any of this rendering gets tested at all: command modules drag in Electron
 * through `../context` and cannot be unit tested.
 *
 * The structural type is deliberately minimal: it is exactly what this function
 * reads, so a `BillingRule` from client-core satisfies it and a change to a
 * field this uses is still a build error at the call site.
 */
export function formatBillingRule(rule: {
  match: {
    tagKey?: string | undefined;
    tagValue?: string | undefined;
    accountId?: string | undefined;
    pluginId?: string | undefined;
    service?: string | undefined;
    chargeType?: string | undefined;
  };
  adjustment: {
    kind: string;
    percent?: number | null | undefined;
    amount?: number | null | undefined;
    currency?: string | null | undefined;
    period?: string | null | undefined;
    targetKind?: string | null | undefined;
    targetId?: string | null | undefined;
    tiers?: Array<{ upTo: number | null; percent: number }> | null | undefined;
    tierMode?: string | null | undefined;
    tierScope?: string | null | undefined;
    expression?: string | null | undefined;
  };
}): string {
  const m = rule.match;
  const parts: string[] = [];
  if (m.tagKey) {
    parts.push(m.tagValue !== undefined ? `tag ${m.tagKey}=${m.tagValue}` : `has tag ${m.tagKey}`);
  }
  if (m.accountId) parts.push(`account ${m.accountId}`);
  if (m.pluginId) parts.push(`provider ${m.pluginId}`);
  if (m.service) parts.push(`service ${m.service}`);
  if (m.chargeType) parts.push(`charge type ${m.chargeType}`);
  const scope = parts.length > 0 ? parts.join(" and ") : "all spend";

  const a = rule.adjustment;
  let what: string;
  if (a.kind === "percentage") {
    const percent = a.percent ?? 0;
    what = `${percent > 0 ? "+" : ""}${percent}%`;
  } else if (a.kind === "fixed") {
    const per = a.period === "daily" ? "day" : "month";
    what = `${a.amount ?? 0} ${a.currency ?? ""}/${per}`.trim();
  } else if (a.kind === "tiered") {
    const signed = (p: number) => `${p > 0 ? "+" : ""}${p}%`;
    const tiers = (a.tiers ?? [])
      .map((t) =>
        t.upTo === null ? `above ${signed(t.percent)}` : `<${t.upTo} ${signed(t.percent)}`,
      )
      .join(", ");
    what =
      `${a.tierMode === "volume" ? "whole-volume" : "marginal"} tiers on ` +
      `${a.tierScope === "per_service" ? "per-service" : "monthly"} ${a.currency ?? ""} spend: ${tiers}`;
  } else if (a.kind === "expression") {
    what = `\`${a.expression ?? ""}\``;
  } else {
    what = `move to ${a.targetKind === "account" ? "account" : "cost centre"} ${a.targetId ?? "?"}`;
  }
  // A fixed rule can also name where it is booked; a percentage rule never can.
  const target =
    a.kind === "fixed" && a.targetId
      ? ` → ${a.targetKind === "account" ? "account" : "cost centre"} ${a.targetId}`
      : "";
  return `${what}${target} on ${scope}`;
}

/**
 * The one-line status an invoice row shows: the status word plus, for a frozen
 * invoice, when it was frozen.
 *
 * Pure so it can be tested without the cloud. The distinction it draws is the
 * one the whole feature rests on: a draft's figures are recomputed on every
 * read and will keep moving, while an approved or sent invoice is a document
 * whose numbers cannot change. Printing them identically would let someone
 * quote a draft to a customer.
 */
export function formatInvoiceStatus(invoice: {
  status: string;
  issuedAt?: string | null | undefined;
  sentAt?: string | null | undefined;
  voidedAt?: string | null | undefined;
}): string {
  switch (invoice.status) {
    case "draft":
      return "draft (recomputes)";
    case "approved":
      return invoice.issuedAt ? `approved ${invoice.issuedAt.slice(0, 10)}` : "approved";
    case "sent":
      return invoice.sentAt ? `sent ${invoice.sentAt.slice(0, 10)}` : "sent";
    case "void":
      return invoice.voidedAt ? `void ${invoice.voidedAt.slice(0, 10)}` : "void";
    default:
      return invoice.status;
  }
}

/**
 * An invoice's billed total as one string, or "not computed" for a draft in a
 * list response.
 *
 * `null` totals are deliberate on the wire (a draft's figures are recomputed
 * on read and the list endpoint does not recompute) so this must never fall
 * back to `0.00`, which is a number a reader would act on.
 */
export function formatInvoiceTotal(
  totals: { billed: Record<string, number> } | null | undefined,
  currency: string,
): string {
  if (!totals) return "not computed";
  const entries = Object.entries(totals.billed).filter(([, amount]) => amount !== 0);
  if (entries.length === 0) return `0.00 ${currency}`;
  return entries
    .sort(([a], [b]) => (a === currency ? -1 : b === currency ? 1 : a.localeCompare(b)))
    .map(([code, amount]) => `${amount.toFixed(2)} ${code}`)
    .join(" + ");
}

/* ------------------------------------------------------------------ *
 * Budgets (`infrawrench budgets`)
 * ------------------------------------------------------------------ */

/**
 * The subset of `BudgetWithStatus` the budget tree reads. Restated rather than
 * imported because this module stays free of client-core (see the header),
 * and every field past the first few is optional so a CLI a release ahead of
 * its server still prints an older row as a monthly spend budget.
 */
export interface CliBudgetRow {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  month: string;
  actualCents: number;
  forecastCents: number | null;
  scenarioForecastCents?: number | null | undefined;
  currentMonthEvents: unknown[];
  measure?: "cost" | "usage" | undefined;
  usageUnit?: string | null | undefined;
  parentBudgetId?: string | null | undefined;
  periodStart?: string | null | undefined;
  periodEnd?: string | null | undefined;
  periodLimit?: number | null | undefined;
  actualUsage?: number | null | undefined;
  forecastUsage?: number | null | undefined;
  rolledUp?: boolean | undefined;
  hierarchyWarnings?: Array<{ kind: string; childTotal: number; parentLimit: number }> | undefined;
}

/** A budget figure in its own unit: money from cents, or a usage quantity. */
export function formatBudgetValue(row: CliBudgetRow, value: number): string {
  if (row.measure === "usage") {
    const text = new Intl.NumberFormat("en-US", {
      notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
    }).format(value);
    return row.usageUnit ? `${text} ${row.usageUnit}` : text;
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: row.currency,
      maximumFractionDigits: Math.abs(value) < 1000 ? 2 : 0,
    }).format(value / 100);
  } catch {
    return `${(value / 100).toFixed(2)} ${row.currency}`;
  }
}

/** The figures a budget row prints, in the API's units (cents or quantity). */
export function budgetFigures(row: CliBudgetRow): {
  limit: number | null;
  actual: number;
  forecast: number | null;
  percent: number | null;
} {
  const usage = row.measure === "usage";
  const limit =
    row.periodLimit !== undefined ? row.periodLimit : row.amountCents > 0 ? row.amountCents : null;
  const actual = usage ? (row.actualUsage ?? 0) : row.actualCents;
  const forecast = usage
    ? (row.forecastUsage ?? null)
    : (row.scenarioForecastCents ?? row.forecastCents);
  return {
    limit,
    actual,
    forecast,
    percent: limit !== null && limit > 0 ? (actual / limit) * 100 : null,
  };
}

/** `██████░░░░` for a percentage, capped at the bar's width. */
export function budgetBar(percent: number | null, width = 16): string {
  if (percent === null) return c.dim("·".repeat(width));
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  const paint = percent >= 100 ? c.red : percent >= 80 ? c.yellow : c.green;
  return paint("█".repeat(filled)) + c.dim("░".repeat(width - filled));
}

/** "2026-07" for a calendar-month budget, "2026-10-05 → 2026-10-18" otherwise. */
export function formatBudgetPeriod(row: CliBudgetRow): string {
  if (row.periodStart === null) return "no active period";
  if (!row.periodStart || !row.periodEnd) return row.month;
  const monthStart = row.periodStart.endsWith("-01") && row.periodStart.slice(0, 7) === row.month;
  const monthEnd = new Date(`${row.periodEnd}T00:00:00Z`);
  monthEnd.setUTCDate(monthEnd.getUTCDate() + 1);
  if (monthStart && monthEnd.getUTCDate() === 1 && row.periodEnd.slice(0, 7) === row.month) {
    return row.month;
  }
  return `${row.periodStart} → ${row.periodEnd}`;
}

/**
 * Depth-first order with each row's depth: parents before their children,
 * siblings in input order. A row whose parent is missing prints at the top
 * level rather than vanishing, and a cycle is broken at the first repeat.
 */
export function orderBudgetTree<T extends CliBudgetRow>(
  rows: T[],
): Array<{ row: T; depth: number }> {
  const ids = new Set(rows.map((r) => r.id));
  const out: Array<{ row: T; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (row: T, depth: number) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ row, depth });
    for (const child of rows) if (child.parentBudgetId === row.id) visit(child, depth + 1);
  };
  for (const row of rows) {
    if (!row.parentBudgetId || !ids.has(row.parentBudgetId)) visit(row, 0);
  }
  for (const row of rows) visit(row, 0);
  return out;
}

/** One sentence per hierarchy warning, in the parent's unit. */
export function formatBudgetWarning(
  row: CliBudgetRow,
  warning: { kind: string; childTotal: number; parentLimit: number },
): string {
  const total = formatBudgetValue(row, warning.childTotal);
  const limit = formatBudgetValue(row, warning.parentLimit);
  if (warning.kind === "allocation") return `children allocate ${total}, more than ${limit}`;
  if (warning.kind === "actual") return `children have reached ${total}, past ${limit}`;
  return `children are forecast to reach ${total}, past ${limit}`;
}

/* ------------------------------------------------------------------ *
 * Keyed group-bys (`costs --group-by tag:env`, `virtual_tag:team`)
 * ------------------------------------------------------------------ */

/**
 * Dimensions that need a key as well as a name. A restatement of client-core's
 * `KEYED_COST_DIMENSIONS` for the usual reason (type-only imports); the caller
 * assigns the parsed result to the wire type, so a dimension removed upstream
 * still fails the build there.
 */
export const KEYED_GROUP_DIMENSIONS = ["tag", "virtual_tag"] as const;

/**
 * Parse a `--group-by` value into the dimension and, for a keyed dimension,
 * its key. Accepts `virtual_tag:team`, `virtual_tag=team` and the query
 * language's own spelling, `virtual_tag['team']`, so a key copied from a
 * `--where` clause works unchanged.
 *
 * Returns an error string rather than throwing a `CliError`, so it stays free
 * of `../context` and can be unit tested.
 */
export function parseGroupByFlag(
  raw: string,
  plain: readonly string[],
): { groupBy: string; tagKey?: string } | { error: string } {
  const value = raw.trim();
  const bracket = /^([a-z_]+)\[\s*(['"])(.*)\2\s*\]$/.exec(value);
  const separated = /^([a-z_]+)[:=](.*)$/.exec(value);
  const match = bracket
    ? { dimension: bracket[1]!, key: bracket[3]!.trim() }
    : separated
      ? { dimension: separated[1]!, key: separated[2]!.trim() }
      : null;
  const keyed: readonly string[] = KEYED_GROUP_DIMENSIONS;
  const allowed = ["none", ...plain, ...KEYED_GROUP_DIMENSIONS.map((d) => `${d}:<key>`)].join(", ");

  if (match) {
    if (!keyed.includes(match.dimension)) {
      return { error: `--group-by ${match.dimension} takes no key. Use one of ${allowed}.` };
    }
    if (!match.key) return { error: `--group-by ${match.dimension} needs a key after the colon.` };
    return { groupBy: match.dimension, tagKey: match.key };
  }
  if (keyed.includes(value)) {
    const hint =
      value === "virtual_tag"
        ? "`infrawrench virtual-tags` lists the keys"
        : "`infrawrench tags` lists the policy keys";
    return { error: `--group-by ${value} needs a key, like ${value}:team (${hint}).` };
  }
  if (value === "none" || plain.includes(value)) return { groupBy: value };
  return { error: `--group-by must be one of ${allowed}; got "${raw}".` };
}

/** "each service", "each virtual_tag[team]", "one total": a grouping in a list. */
export function formatGroupBy(
  groupBy: string | null | undefined,
  tagKey?: string | null | undefined,
): string {
  if (!groupBy || groupBy === "none") return "one total";
  const keyed: readonly string[] = KEYED_GROUP_DIMENSIONS;
  return `each ${groupBy}${keyed.includes(groupBy) && tagKey ? `[${tagKey}]` : ""}`;
}

/* ------------------------------------------------------------------ *
 * Virtual tags (`infrawrench virtual-tags`)
 * ------------------------------------------------------------------ */

/**
 * A virtual tag rule as one line: "provider = 'aws' → 'platform' from
 * 2026-04-01". A copy of client-core's `describeVirtualTagRule`, which the CLI
 * cannot import at runtime for the reason `formatBillingRule` gives; kept to
 * the same output so the CLI, the MCP tools and Settings describe a rule in
 * the same words.
 */
export function formatVirtualTagRule(
  rule: {
    query: string;
    startsOn: string | null;
    endsOn: string | null;
    kind: string;
    value: string | null;
    sources: ReadonlyArray<{ tagKey: string; valuePrefix: string | null }>;
    valueTransform: string;
    allocations: ReadonlyArray<{ value: string; percent: number | null; metricId: string | null }>;
  },
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
    default:
      output = rule.kind;
  }
  let bounds = "";
  if (rule.startsOn && rule.endsOn) bounds = ` from ${rule.startsOn} to ${rule.endsOn}`;
  else if (rule.startsOn) bounds = ` from ${rule.startsOn}`;
  else if (rule.endsOn) bounds = ` until ${rule.endsOn}`;
  return `${scope} → ${output}${bounds}`;
}

/**
 * A part of a total as a percentage: "12.4%". Null when there was no spend to
 * divide, because a zero total has no share to report (neither 0% nor 100%).
 */
export function shareOfTotal(part: number, total: number): string | null {
  if (!(total > 0) || !Number.isFinite(part)) return null;
  return `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * Resolve `infrawrench virtual-tags show <query>` to one tag: an exact id,
 * then an exact key (keys are what filters address and are unique per org,
 * so they are the natural handle), then the name rules of `matchCostReport`.
 */
export function matchVirtualTag<T extends { id: string; key: string; name: string }>(
  tags: readonly T[],
  query: string,
): { match: T } | { match: null; candidates: T[] } {
  const q = query.trim();
  const byId = tags.find((t) => t.id === q);
  if (byId) return { match: byId };
  const byKey =
    tags.find((t) => t.key === q) ?? tags.find((t) => t.key.toLowerCase() === q.toLowerCase());
  if (byKey) return { match: byKey };
  return matchCostReport(tags, q);
}
