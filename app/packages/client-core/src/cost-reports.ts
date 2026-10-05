/**
 * Cost reports: a named, addressable saved cost graph.
 *
 * A `cost_graph` dashboard widget stores its whole {@link CostGraphConfig}
 * inline: it belongs to one card on one dashboard, and there is no object to
 * link to, schedule, annotate or file away. A cost *report* is that object. It
 * owns the config, lives at its own URL, and dashboards reference it by id,
 * so one report can appear on many dashboards and editing it updates all of
 * them at once.
 *
 * The ad-hoc `cost_graph` widget stays exactly as it was: a one-off card should
 * not force anyone to name and file a report first.
 *
 * These types live in `@infrawrench/client-core` rather than `@infrawrench/ui`
 * because mobile doesn't depend on that package. `ui/src/cost/config.ts` holds
 * the zod schemas the API validates against and proves, at compile time, that
 * they still parse to exactly these shapes.
 */

import type { CostBinningId, CostGraphConfig, CostMeasure, CostQueryResponse } from "./costs";

/** Bounds the API enforces on report names and descriptions. */
export const COST_REPORT_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
} as const;

/**
 * Bounds the API enforces on report folders.
 *
 * `maxDepth` is the deepest a folder itself may sit (a root folder is depth 1).
 * Three levels holds every "team / area / month" filing scheme anyone has asked
 * for while keeping the sidebar tree renderable without scroll-in-scroll, and
 * an unbounded self-referencing column is how a list view ends up recursing
 * forever on bad data.
 */
export const COST_REPORT_FOLDER_LIMITS = {
  maxNameLength: 120,
  maxDepth: 3,
} as const;

/**
 * Create/update payload for a report (POST/PUT /cost-reports).
 *
 * `folderId` files the report in a cost-report folder; null (or absent) is the
 * top level of the Reports list. Moving a report between folders is this same
 * PUT with a different `folderId`: a move is just an edit of where it's filed.
 */
export interface CostReportInput {
  name: string;
  /** Free text shown under the title in the list; absent is no description. */
  description?: string | undefined;
  /** The saved graph: the same blob a `cost_graph` widget stores inline. */
  config: CostGraphConfig;
  /** Folder to file the report under; null is the top level. */
  folderId?: string | null | undefined;
}

/** Create/update payload for a folder (POST/PUT /cost-report-folders). */
export interface CostReportFolderInput {
  name: string;
  /** Parent folder for nesting; null (or absent) is a top-level folder. */
  parentFolderId?: string | null | undefined;
}

/**
 * A cost-report folder as returned by the API.
 *
 * Folders only organize the Reports list; a report's identity, URL, dashboard
 * cards and run-by-id behaviour are all unchanged by where it is filed, which
 * is why deleting a folder never deletes a report: contents fall back to the
 * top level instead.
 */
export interface CostReportFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One dashboard card pointing at a report, as listed on {@link CostReport}. */
export interface CostReportPlacement {
  widgetId: string;
  dashboardId: string;
  dashboardName: string;
}

/**
 * A report as returned by the API.
 *
 * `placements` is the same idea as `BudgetWithStatus.placements`: a report
 * exists whether or not any dashboard shows it, so the list view is its home
 * and this is where it happens to say where else it appears.
 */
export interface CostReport {
  id: string;
  name: string;
  description: string | null;
  config: CostGraphConfig;
  /** Folder the report is filed under; null is the top level. */
  folderId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  placements: CostReportPlacement[];
}

/**
 * A cost_report widget is a dashboard view onto a cost_reports row: the report
 * outlives the card, exactly as a budget outlives its own.
 */
export interface CostReportWidgetConfig {
  version: 1;
  reportId: string;
}

/**
 * The answer to `POST /cost-reports/:id/run`: the report's own config resolved
 * to concrete dates, and the series it produced.
 *
 * Running by id exists so a caller (chat, the CLI, a scheduled delivery) never
 * has to reassemble the report's config to execute it; the resolved window
 * rides along because a relative preset means a different fortnight tomorrow.
 */
export interface CostReportRunResult {
  reportId: string;
  name: string;
  /** Inclusive YYYY-MM-DD window the relative preset resolved to. */
  from: string;
  to: string;
  result: CostQueryResponse;
}

/**
 * One-off display overrides for `POST /cost-reports/:id/run`: look at a saved
 * report as usage, or by quarter, without editing what everybody else sees.
 * Never saved.
 */
export interface CostReportRunOverrides {
  measure?: CostMeasure | undefined;
  usageUnit?: string | undefined;
  binning?: CostBinningId | undefined;
  cumulative?: boolean | undefined;
}

/**
 * The config a run with {@link CostReportRunOverrides} executes.
 *
 * Switching to `usage` or `count` drops the saved forecast, scenario, billing
 * rules and unit-cost metric, because those only mean anything for money and
 * the query refuses them otherwise: an override is a different view of the
 * same scope, not a request to fail. The saved config itself is untouched.
 */
export function applyCostReportRunOverrides(
  config: CostGraphConfig,
  overrides: CostReportRunOverrides,
): CostGraphConfig {
  const next: CostGraphConfig = { ...config };
  if (overrides.binning) next.binning = overrides.binning;
  if (overrides.cumulative !== undefined) next.cumulative = overrides.cumulative;
  if (overrides.measure) {
    next.measure = overrides.measure;
    if (overrides.measure !== "usage") delete next.usageUnit;
    if (overrides.measure !== "cost") {
      next.showForecast = false;
      delete next.scenarioModelId;
      delete next.adjusted;
      delete next.unitCostMetricId;
      delete next.unitCostMode;
    }
  }
  if (overrides.usageUnit) next.usageUnit = overrides.usageUnit;
  // `binning: "cumulative"` plus an explicit toggle-off means daily bins.
  if (overrides.cumulative === false && next.binning === "cumulative") next.binning = "daily";
  return next;
}

/** Trim and bound a report name; returns null when it isn't usable. */
export function normalizeCostReportName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > COST_REPORT_LIMITS.maxNameLength) return null;
  return name;
}

/**
 * `"Copy of Spend by service"`, `"Copy of Spend by service (2)"`, …: the name
 * a duplicate should take given the names already in use.
 *
 * Shared so the list view, the CLI and the chat tool all name a copy the same
 * way, and so a duplicate never silently collides with a name already there.
 * Falls back to truncating rather than exceeding the stored column.
 */
export function duplicateCostReportName(original: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const base = `Copy of ${original}`.slice(0, COST_REPORT_LIMITS.maxNameLength);
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate =
      base.length + suffix.length > COST_REPORT_LIMITS.maxNameLength
        ? base.slice(0, COST_REPORT_LIMITS.maxNameLength - suffix.length) + suffix
        : base + suffix;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * Folder tree helpers: shared by the Reports list (indentation), mobile
 * (section headers) and the folder move validation the server enforces.
 * ------------------------------------------------------------------ */

/** One folder in display order, with everything a tree renderer needs. */
export interface CostReportFolderTreeRow {
  folder: CostReportFolder;
  /** 0 for a top-level folder: indent by this. */
  depth: number;
  /** `"Finance / Monthly"`: the ancestry joined for breadcrumbs and the CLI. */
  path: string;
}

/**
 * The org's folders as a depth-first display list: siblings alphabetical,
 * children directly under their parent.
 *
 * Defensive on purpose: a folder whose parent is missing renders at the top
 * level, and a parent cycle (impossible via the API, which rejects it, but not
 * via a corrupted payload) is broken rather than recursed into; a sidebar must
 * never hang on bad data.
 */
export function flattenCostReportFolderTree(
  folders: readonly CostReportFolder[],
): CostReportFolderTreeRow[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const children = new Map<string | null, CostReportFolder[]>();
  for (const f of folders) {
    // A dangling or self-referencing parent is treated as "no parent".
    const parent =
      f.parentFolderId !== f.id && f.parentFolderId !== null && byId.has(f.parentFolderId)
        ? f.parentFolderId
        : null;
    const list = children.get(parent) ?? [];
    list.push(f);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  const rows: CostReportFolderTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number, prefix: string) => {
    for (const f of children.get(parentId) ?? []) {
      if (visited.has(f.id)) continue; // cycle guard
      visited.add(f.id);
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      rows.push({ folder: f, depth, path });
      walk(f.id, depth + 1, path);
    }
  };
  walk(null, 0, "");

  // Folders trapped in a parent cycle (A → B → A) are reachable from no root,
  // so the walk above never sees them. Surface each as its own top-level row:
  // hiding a folder, and with it the reports filed inside, is the one failure
  // mode this function must not have.
  for (const f of folders) {
    if (visited.has(f.id)) continue;
    visited.add(f.id);
    rows.push({ folder: f, depth: 0, path: f.name });
    walk(f.id, 1, f.name);
  }
  return rows;
}

/** `"Finance / Monthly"` for each folder id: a convenience over the flatten. */
export function costReportFolderPaths(folders: readonly CostReportFolder[]): Map<string, string> {
  return new Map(flattenCostReportFolderTree(folders).map((r) => [r.folder.id, r.path]));
}

/** Depth of `folderId` counting itself: a top-level folder is 1. */
function folderDepth(byId: Map<string, CostReportFolder>, folderId: string): number {
  let depth = 0;
  const seen = new Set<string>();
  for (
    let cursor: string | null = folderId;
    cursor !== null && byId.has(cursor) && !seen.has(cursor);
    cursor = byId.get(cursor)!.parentFolderId
  ) {
    seen.add(cursor);
    depth += 1;
  }
  return depth;
}

/** Levels in the subtree rooted at `folderId`, counting itself: a leaf is 1. */
function folderSubtreeHeight(folders: readonly CostReportFolder[], folderId: string): number {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parentFolderId === null || f.parentFolderId === f.id) continue;
    const list = children.get(f.parentFolderId) ?? [];
    list.push(f.id);
    children.set(f.parentFolderId, list);
  }
  const height = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    let deepest = 0;
    for (const child of children.get(id) ?? []) deepest = Math.max(deepest, height(child, seen));
    return 1 + deepest;
  };
  return height(folderId, new Set());
}

/**
 * Why placing `subjectId` (null when creating a new folder) under
 * `newParentId` is not allowed, or null when it is.
 *
 * This is the rule the server enforces with a 400 on POST/PUT
 * /cost-report-folders, shared here so the move menu can grey out exactly the
 * targets the server would reject:
 *
 * - the parent must exist (in the caller's org: the server only ever passes
 *   the org's own folders in);
 * - a folder cannot be moved inside itself or one of its descendants, which is
 *   the only way `parent_folder_id` could ever form a cycle;
 * - the result must respect {@link COST_REPORT_FOLDER_LIMITS.maxDepth} for the
 *   *whole* subtree being moved, not just the folder itself.
 */
export function costReportFolderMoveBlocker(
  folders: readonly CostReportFolder[],
  subjectId: string | null,
  newParentId: string | null,
): string | null {
  const maxDepth = COST_REPORT_FOLDER_LIMITS.maxDepth;
  const byId = new Map(folders.map((f) => [f.id, f]));

  if (newParentId !== null) {
    if (!byId.has(newParentId)) return "Unknown parent folder.";
    if (subjectId !== null) {
      const seen = new Set<string>();
      for (
        let cursor: string | null = newParentId;
        cursor !== null && !seen.has(cursor);
        cursor = byId.get(cursor)?.parentFolderId ?? null
      ) {
        if (cursor === subjectId) {
          return "A folder cannot be moved inside itself or one of its subfolders.";
        }
        seen.add(cursor);
      }
    }
  }

  const parentDepth = newParentId === null ? 0 : folderDepth(byId, newParentId);
  const subtreeHeight = subjectId === null ? 1 : folderSubtreeHeight(folders, subjectId);
  if (parentDepth + subtreeHeight > maxDepth) {
    return `Folders can be nested at most ${maxDepth} levels deep.`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Bulk move and bulk delete: POST /cost-reports/bulk.
 *
 * One request, validated item by item before anything is written, then
 * applied all-or-nothing in one transaction. A half-applied bulk move is the
 * failure this exists to prevent: forty reports filed and three left behind,
 * with nothing on screen saying which three.
 * ------------------------------------------------------------------ */

/** Bounds the API enforces on a bulk request. */
export const COST_REPORT_BULK_LIMITS = {
  /**
   * Items per request, reports and folders together. Comfortably more than a
   * Reports list a person can select by hand, and small enough that the one
   * transaction it runs in stays short.
   */
  maxItems: 500,
} as const;

/**
 * The bulk request body.
 *
 * `move` files every report into `targetFolderId` and makes every folder a
 * direct child of it (null is the top level). `delete` soft-deletes the
 * reports and deletes the folders, whose remaining contents fall back to the
 * top level exactly as a single folder delete does.
 */
export type CostReportBulkRequest =
  | {
      action: "move";
      reportIds: string[];
      folderIds: string[];
      targetFolderId: string | null;
    }
  | { action: "delete"; reportIds: string[]; folderIds: string[] };

/** One item the server refused, and why. Nothing was written when any exist. */
export interface CostReportBulkProblem {
  kind: "report" | "folder" | "target";
  id: string;
  /** The item's name when the caller can see it; null when it is unknown. */
  name: string | null;
  message: string;
}

/** What a successful bulk request did. */
export interface CostReportBulkResult {
  action: "move" | "delete";
  reports: number;
  folders: number;
}

/**
 * The 400 body of a refused bulk request: `problems` names every item that
 * blocked it, so a client can say which ones rather than "something failed".
 */
export interface CostReportBulkErrorBody {
  error: string;
  problems: CostReportBulkProblem[];
}

/**
 * Why moving `folderIds` under `targetFolderId` is not allowed, item by item.
 * Empty when the whole move may proceed.
 *
 * All the moves are applied to a copy of the tree first and every moved folder
 * is then checked against that *final* tree with
 * {@link costReportFolderMoveBlocker}, the single-folder rule. Checking each one
 * against the tree as it stands would be wrong both ways: moving a parent and
 * its child together is fine (the child just becomes the parent's sibling),
 * and two folders that each fit alone can, together, nest past the limit.
 *
 * Reports never block a move on tree grounds: any folder can hold a report.
 * The only report-side rule, that the target exists, is the target check.
 */
export function costReportBulkMoveBlockers(
  folders: readonly CostReportFolder[],
  folderIds: readonly string[],
  targetFolderId: string | null,
): Array<{ folderId: string | null; message: string }> {
  if (targetFolderId !== null && !folders.some((f) => f.id === targetFolderId)) {
    return [{ folderId: null, message: "Unknown destination folder." }];
  }
  const moving = new Set(folderIds);
  const simulated = folders.map((f) =>
    moving.has(f.id) ? { ...f, parentFolderId: targetFolderId } : f,
  );
  const out: Array<{ folderId: string | null; message: string }> = [];
  for (const id of moving) {
    if (id === targetFolderId) {
      out.push({ folderId: id, message: "A folder cannot be moved inside itself." });
      continue;
    }
    const blocked = costReportFolderMoveBlocker(simulated, id, targetFolderId);
    if (blocked) out.push({ folderId: id, message: blocked });
  }
  return out;
}

/**
 * Why `targetFolderId` cannot take the whole selection, or null when it can:
 * the first blocker, named, for a disabled row in a folder picker or a drop
 * target that refuses. Ids not in `folders` are ignored (the server rechecks).
 */
export function costReportBulkMoveTargetBlocker(
  folders: readonly CostReportFolder[],
  folderIds: readonly string[],
  targetFolderId: string | null,
): string | null {
  const known = new Set(folders.map((f) => f.id));
  const blockers = costReportBulkMoveBlockers(
    folders,
    folderIds.filter((id) => known.has(id)),
    targetFolderId,
  );
  const first = blockers[0];
  if (!first) return null;
  const name = first.folderId ? folders.find((f) => f.id === first.folderId)?.name : undefined;
  return name ? `"${name}": ${first.message}` : first.message;
}

/** One selectable row of the Reports list. */
export interface CostReportListItem {
  kind: "report" | "folder";
  id: string;
}

/**
 * Every item in display order: top-level reports, then each folder followed by
 * its own reports, depth first. The order a shift-click range runs in, so a
 * range selects exactly what lies between the two clicks on screen.
 */
export function costReportListOrder(
  folders: readonly CostReportFolder[],
  reports: readonly Pick<CostReport, "id" | "folderId">[],
): CostReportListItem[] {
  const known = new Set(folders.map((f) => f.id));
  const byFolder = new Map<string | null, string[]>();
  for (const r of reports) {
    const key = r.folderId !== null && known.has(r.folderId) ? r.folderId : null;
    const list = byFolder.get(key) ?? [];
    list.push(r.id);
    byFolder.set(key, list);
  }
  const out: CostReportListItem[] = [];
  for (const id of byFolder.get(null) ?? []) out.push({ kind: "report", id });
  for (const { folder } of flattenCostReportFolderTree(folders)) {
    out.push({ kind: "folder", id: folder.id });
    for (const id of byFolder.get(folder.id) ?? []) out.push({ kind: "report", id });
  }
  return out;
}

/**
 * The items between `anchor` and `target` inclusive, in list order: what a
 * shift-click selects. Just `target` when the anchor is gone from the list.
 */
export function costReportListRange(
  order: readonly CostReportListItem[],
  anchor: CostReportListItem,
  target: CostReportListItem,
): CostReportListItem[] {
  const same = (a: CostReportListItem, b: CostReportListItem) => a.kind === b.kind && a.id === b.id;
  const from = order.findIndex((i) => same(i, anchor));
  const to = order.findIndex((i) => same(i, target));
  if (to === -1) return [];
  if (from === -1) return [order[to]!];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return order.slice(lo, hi + 1);
}
