// Pure presentation helpers shared by the newer read commands. Kept out of the
// command modules — those reach the network through `./context`, which drags in
// Electron and every plugin — so the tree walk and the number formatting can be
// unit-tested on their own. Imports nothing but `./output`.
import { c } from "./output";

/* ------------------------------------------------------------------ *
 * ASCII trees (`infrawrench graph`)
 * ------------------------------------------------------------------ */

export interface TreeChild {
  id: string;
  /** Caption printed after the node's label — how the link reads. */
  caption: string;
}

export interface RenderTreeOptions {
  /** Depth cap; a branch that deep is a fan-out nobody reads in a terminal. */
  maxDepth?: number;
  /**
   * Ids already considered visited when the walk starts — normally just the
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
 * "+173%" over baseline. Null when there is no baseline to be up from — a key
 * with no trailing spend reads as "new" rather than as an infinite jump — and
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
 * the first — running the wrong cost report is a quiet, plausible-looking
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
 * Change timeline
 * ------------------------------------------------------------------ */

/** `2026-07-30 14:05` in UTC — sortable, and stable across machines. */
export function formatChangeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Metric alerts
 * ------------------------------------------------------------------ */

/**
 * `"CPU % > 90 for 15m"` — one line for a rule's condition. A local twin of
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
 * identical everywhere: `null` prints as "—", never as "0" or "0.00". A CLI
 * that printed a zero for an unmeasured period would be believed exactly as
 * readily as a chart that drew one.
 *
 * Unit costs are routinely sub-cent (cost per API request), so this keeps
 * significant digits rather than rounding a real number to `0.00` — which is
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
 * A billing rule as one line — "+15% on tag team=platform", "1000 USD/month →
 * cost centre <id>", "move to account <id> on service AmazonEKS".
 *
 * Duplicated here rather than imported from `describeBillingRule` in
 * client-core for the reason every wire type in this CLI is imported type-only:
 * the CLI is CJS and client-core is ESM, so a *runtime* import would be a
 * `await import(...)` in a formatter that has to stay synchronous and pure.
 * Pure and here means `cli-format.test.ts` can reach it, which is the only way
 * any of this rendering gets tested at all — command modules drag in Electron
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
 * The one-line status an invoice row shows — the status word plus, for a frozen
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
 * `null` totals are deliberate on the wire — a draft's figures are recomputed
 * on read and the list endpoint does not recompute — so this must never fall
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
