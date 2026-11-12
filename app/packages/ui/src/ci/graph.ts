/**
 * The layout of a CI pipeline's job graph: jobs grouped by the key they were
 * written under (a matrix's entries and a `packages:` job's packages share a
 * box), each group one layer below the deepest group it needs, and each
 * layer ordered to keep the edges between layers from crossing (a few
 * barycentre sweeps, as layered graph drawing usually does). Pure, so the
 * view only draws it and the tests check it without a browser.
 */
import type { CiLiveJobStatus } from "@infrawrench/client-core";

export interface GraphJob {
  pipeline: string;
  id: string;
  name: string;
  status: CiLiveJobStatus;
  durationMs: number | null;
  /** A running job's start, by this client's clock, for its elapsed time. */
  startedAt?: number | null | undefined;
  cached?: boolean | undefined;
  /** The job keys it waits for (`build[app/packages/ui]`, `prep`). */
  needs: readonly string[];
}

export interface GraphGroup {
  /** The key the jobs were written under: `build` for `build[app/packages/ui]`. */
  key: string;
  jobs: GraphJob[];
  /** The other groups this one waits for. */
  needs: string[];
  status: CiLiveJobStatus;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Jobs not shown until the group is expanded. */
  hidden: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** An SVG path from the bottom of `from` to the top of `to`. */
  d: string;
}

export interface GraphLayout {
  groups: GraphGroup[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 248;
/** A group of one job: a single row. */
export const SINGLE_HEIGHT = 36;
export const ROW_HEIGHT = 28;
export const HEADER_HEIGHT = 28;
/** Rows a group shows before "show more". */
export const MAX_ROWS = 8;
const PADDING = 8;
const LAYER_GAP = 72;
const NODE_GAP = 24;
const MARGIN = 24;

/** The key a job id was written under: `build[app/packages/ui]` and `test[1,2]` belong to `build` and `test`. */
export function baseKey(id: string): string {
  const bracket = id.indexOf("[");
  return bracket === -1 ? id : id.slice(0, bracket);
}

/** What a group shows: running wins, then a failure, then waiting, then cancelled, then skipped, then passed. */
export function groupStatus(jobs: readonly GraphJob[]): CiLiveJobStatus {
  if (jobs.some((j) => j.status === "running")) return "running";
  if (jobs.some((j) => j.status === "failed")) return "failed";
  if (jobs.some((j) => j.status === "error")) return "error";
  if (jobs.some((j) => j.status === "pending")) return "pending";
  if (jobs.some((j) => j.status === "cancelled")) return "cancelled";
  if (jobs.length > 0 && jobs.every((j) => j.status === "skipped")) return "skipped";
  return "passed";
}

/** Jobs grouped by key, in the order they first appear. */
export function groupJobs(jobs: readonly GraphJob[]): Pick<GraphGroup, "key" | "jobs" | "needs">[] {
  const groups = new Map<string, { key: string; jobs: GraphJob[]; needs: Set<string> }>();
  for (const job of jobs) {
    const key = baseKey(job.id);
    let group = groups.get(key);
    if (!group) {
      group = { key, jobs: [], needs: new Set() };
      groups.set(key, group);
    }
    group.jobs.push(job);
    for (const need of job.needs) {
      const other = baseKey(need);
      // `^build` makes a package's build need another package's: the group
      // does not need itself.
      if (other !== key) group.needs.add(other);
    }
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    jobs: g.jobs,
    needs: [...g.needs].filter((n) => groups.has(n)),
  }));
}

function sizeOf(jobs: readonly GraphJob[], expanded: boolean): { height: number; hidden: number } {
  if (jobs.length === 1) return { height: SINGLE_HEIGHT, hidden: 0 };
  const hidden = expanded ? 0 : Math.max(0, jobs.length - MAX_ROWS);
  const rows = jobs.length - hidden + (jobs.length > MAX_ROWS ? 1 : 0);
  return { height: HEADER_HEIGHT + rows * ROW_HEIGHT + PADDING, hidden };
}

/**
 * The pipeline drawn top to bottom. `expanded` names the groups showing all
 * of their jobs.
 */
export function layoutGraph(jobs: readonly GraphJob[], expanded: ReadonlySet<string>): GraphLayout {
  const base = groupJobs(jobs);
  const byKey = new Map(base.map((g) => [g.key, g]));

  // A group's layer: one more than the deepest group it needs. A cycle
  // (which the runner refuses) cannot recurse forever: a group already being
  // placed counts as layer 0.
  const layers = new Map<string, number>();
  const placing = new Set<string>();
  const layerOf = (key: string): number => {
    const known = layers.get(key);
    if (known !== undefined) return known;
    if (placing.has(key)) return 0;
    placing.add(key);
    const needs = byKey.get(key)?.needs ?? [];
    const layer = needs.length === 0 ? 0 : 1 + Math.max(...needs.map(layerOf));
    placing.delete(key);
    layers.set(key, layer);
    return layer;
  };
  const rows: string[][] = [];
  for (const g of base) {
    const layer = layerOf(g.key);
    (rows[layer] ??= []).push(g.key);
  }
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];

  // Order each layer by the mean position of its neighbours in the layer
  // above, then below, twice over.
  const childrenOf = new Map<string, string[]>();
  for (const g of base) {
    for (const need of g.needs) {
      const list = childrenOf.get(need) ?? [];
      list.push(g.key);
      childrenOf.set(need, list);
    }
  }
  const position = new Map<string, number>();
  const index = () => rows.forEach((row) => row.forEach((key, i) => position.set(key, i)));
  index();
  const sortBy = (row: string[], neighbours: (key: string) => readonly string[]) => {
    const weight = new Map<string, number>();
    row.forEach((key, i) => {
      const ns = neighbours(key).filter((n) => position.has(n));
      weight.set(
        key,
        ns.length === 0 ? i : ns.reduce((sum, n) => sum + (position.get(n) ?? 0), 0) / ns.length,
      );
    });
    row.sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0));
    row.forEach((key, i) => position.set(key, i));
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < rows.length; l++) sortBy(rows[l]!, (k) => byKey.get(k)?.needs ?? []);
    for (let l = rows.length - 2; l >= 0; l--) sortBy(rows[l]!, (k) => childrenOf.get(k) ?? []);
  }

  // Positions: layers top to bottom, each centred on the widest.
  const sized = new Map(
    base.map((g) => [g.key, sizeOf(g.jobs, expanded.has(g.key) || g.jobs.length <= MAX_ROWS)]),
  );
  const rowWidth = (row: string[]) =>
    row.length * NODE_WIDTH + Math.max(0, row.length - 1) * NODE_GAP;
  const width = Math.max(NODE_WIDTH, ...rows.map(rowWidth));
  const groups: GraphGroup[] = [];
  let y = MARGIN;
  rows.forEach((row, layer) => {
    let x = MARGIN + (width - rowWidth(row)) / 2;
    let tallest = 0;
    for (const key of row) {
      const g = byKey.get(key)!;
      const { height, hidden } = sized.get(key)!;
      groups.push({
        ...g,
        status: groupStatus(g.jobs),
        layer,
        x,
        y,
        width: NODE_WIDTH,
        height,
        hidden,
      });
      x += NODE_WIDTH + NODE_GAP;
      tallest = Math.max(tallest, height);
    }
    if (row.length > 0) y += tallest + LAYER_GAP;
  });

  const placed = new Map(groups.map((g) => [g.key, g]));
  const edges: GraphEdge[] = [];
  for (const g of groups) {
    for (const need of g.needs) {
      const from = placed.get(need);
      if (!from) continue;
      const x1 = from.x + from.width / 2;
      const y1 = from.y + from.height;
      const x2 = g.x + g.width / 2;
      const y2 = g.y;
      const bend = Math.max(24, (y2 - y1) / 2);
      edges.push({
        from: need,
        to: g.key,
        d: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`,
      });
    }
  }
  return {
    groups,
    edges,
    width: width + MARGIN * 2,
    height: Math.max(y - LAYER_GAP + MARGIN, SINGLE_HEIGHT + MARGIN * 2),
  };
}
