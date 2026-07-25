/**
 * Ordering for the dashboard grid, shared by web and desktop.
 *
 * The grid mixes three kinds of card, each stored in its own table with its
 * own `gridX`: resource pins, workflow pins, and widgets (cost graphs and
 * budgets). Drag-to-reorder works across all of them, so the position that
 * matters is a single sequence spanning the three tables — a reorder writes
 * `gridX = index` over the merged list, and every insert lands at
 * `max(gridX) + 1` across all three.
 *
 * Dashboards created before that unification have three independent 0..n
 * sequences, so sorting them by `gridX` alone would interleave cards that the
 * user never moved. {@link orderDashboardCards} detects that case — duplicate
 * `gridX` values across kinds — and falls back to the historical grouping
 * (resources, then workflows, then widgets) until the first drag renumbers
 * the dashboard into one sequence. No backfill needed; it converges on use.
 */

export type DashboardCardKind = "resource" | "workflow" | "widget";

/** Identifies one card in the grid, independent of which table it lives in. */
export interface DashboardCardRef {
  kind: DashboardCardKind;
  /** Resource id, workflow id, or widget id — unique within its kind. */
  id: string;
}

export interface OrderableDashboardCard extends DashboardCardRef {
  gridX: number;
}

/** Historical render order, and the tiebreak for cards sharing a `gridX`. */
const KIND_RANK: Record<DashboardCardKind, number> = { resource: 0, workflow: 1, widget: 2 };

/** Stable dnd-kit item id for a card. */
export function dashboardCardId(kind: DashboardCardKind, id: string): string {
  return `${kind}:${id}`;
}

/** Inverse of {@link dashboardCardId}; null when the id isn't a card id. */
export function parseDashboardCardId(cardId: string): DashboardCardRef | null {
  const separator = cardId.indexOf(":");
  if (separator === -1) return null;
  const kind = cardId.slice(0, separator);
  const id = cardId.slice(separator + 1);
  if (!id || !(kind in KIND_RANK)) return null;
  return { kind: kind as DashboardCardKind, id };
}

/**
 * Sort merged cards into the order the grid renders them.
 *
 * Once a dashboard has been reordered its `gridX` values are globally unique
 * and are used as-is. Legacy dashboards keep their per-kind grouping.
 */
export function orderDashboardCards<T extends OrderableDashboardCard>(cards: T[]): T[] {
  const unified = new Set(cards.map((c) => c.gridX)).size === cards.length;
  return [...cards].sort((a, b) => {
    if (unified) return a.gridX - b.gridX || compareRefs(a, b);
    return KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.gridX - b.gridX || compareRefs(a, b);
  });
}

/** Last-resort tiebreak so a render never depends on input order. */
function compareRefs(a: DashboardCardRef, b: DashboardCardRef): number {
  return KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Position of each card in an ordered list, keyed by `dashboardCardId`. Hosts
 * fold this back into their per-kind state as the new `gridX` so the grid
 * re-renders from the same values the server is about to store.
 */
export function cardOrderIndex(cards: DashboardCardRef[]): Map<string, number> {
  return new Map(cards.map((c, i) => [dashboardCardId(c.kind, c.id), i]));
}

/** Move `activeCardId` to `overCardId`'s slot, returning the new order. */
export function moveDashboardCard<T extends DashboardCardRef>(
  cards: T[],
  activeCardId: string,
  overCardId: string,
): T[] {
  const from = cards.findIndex((c) => dashboardCardId(c.kind, c.id) === activeCardId);
  const to = cards.findIndex((c) => dashboardCardId(c.kind, c.id) === overCardId);
  if (from === -1 || to === -1 || from === to) return cards;
  const next = [...cards];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
