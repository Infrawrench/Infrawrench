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
