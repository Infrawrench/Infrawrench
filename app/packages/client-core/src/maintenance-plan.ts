/**
 * Sequenced maintenance — what order to touch things in, and what each step
 * takes with it.
 *
 * "Restart these twelve services" is a sentence that hides the only hard
 * question in it: *in what order?* Get it wrong and the app comes back before
 * the database it needs, or the load balancer is drained after the thing behind
 * it was already stopped. The dependency graph knows the answer and nothing has
 * ever asked it.
 *
 * This module is the whole feature's reasoning, and it is pure. It **plans**
 * and does not execute: there is no route here that stops anything. That is a
 * deliberate boundary, not an unfinished one — an unattended sequence of
 * destructive actions against somebody's production is not a thing this product
 * should do on a heuristic, and the ordering is the part people actually get
 * wrong.
 */
import {
  buildDependencyGraph,
  collectDependentsWithDepth,
  type DependencyGraphEdge,
  type DependencyGraphNode,
} from "./dependency-graph";

/**
 * What is being done, which is what decides the direction.
 *
 * - `stop` and `restart` go **dependants first**: drain the thing in front
 *   before the thing behind it disappears.
 * - `start` goes **dependencies first**: nothing should come up looking for
 *   something that is not there yet.
 *
 * A restart is not a stop followed by a start with one order — it is a
 * sequence of independent restarts, and the safe order for each is the stop
 * order, because that is the direction in which a resource being briefly absent
 * hurts.
 */
export type MaintenanceIntent = "stop" | "restart" | "start";

export interface MaintenanceStep {
  /** 1-based, so it reads as "step 3 of 7" without arithmetic at the call site. */
  position: number;
  /**
   * Resources in this step. More than one means they are independent of each
   * other *within the selection* and may be done together — which is the whole
   * value of computing waves rather than a flat list.
   */
  resourceIds: string[];
  /** Names, in the same order, so a renderer needs no second lookup. */
  labels: string[];
  /**
   * Resources **outside the selection** that depend on something in this step,
   * for a `stop`/`restart`. The collateral nobody remembers until it happens.
   */
  affectsOutside: MaintenanceImpact[];
}

export interface MaintenanceImpact {
  resourceId: string;
  label: string;
  /** Which selected resource it hangs off. */
  viaResourceId: string;
}

export interface MaintenancePlan {
  intent: MaintenanceIntent;
  steps: MaintenanceStep[];
  /**
   * Selected resources that are part of a dependency **cycle** and therefore
   * have no safe order. Reported, never silently linearised: a cycle means the
   * graph disagrees with itself, and picking an arbitrary order would present a
   * guess as a plan.
   */
  cyclic: MaintenanceImpact[];
  /**
   * Selected ids that are not in the graph at all — usually a resource that has
   * since been deleted. Named rather than dropped, so a plan for twelve things
   * never quietly becomes a plan for ten.
   */
  unknown: string[];
  /**
   * True when the graph itself was truncated. The plan is then a best effort
   * over a partial topology, and every surface says so rather than presenting
   * it as complete.
   */
  partialGraph: boolean;
}

export const MAINTENANCE_LIMITS = {
  /** Resources one plan may cover. Past this it is a migration, not maintenance. */
  maxSelection: 200,
  /** Outside-impact rows listed per step before the UI truncates. */
  maxImpactPerStep: 25,
} as const;

/**
 * Order a selection into waves.
 *
 * Kahn's algorithm over the sub-graph **induced by the selection**, which is
 * the important detail: an edge through a resource nobody selected does not
 * order two that were. Restarting a web server and its database is one ordering
 * question whether or not a load balancer sits between them and is being left
 * alone.
 *
 * Resources with no remaining constraint come out in the same wave, so a plan
 * for twelve services that genuinely have three layers is three steps rather
 * than twelve — which is the difference between a maintenance window somebody
 * can actually run and a list they will abandon halfway through.
 */
function orderWaves(
  selection: readonly string[],
  edgesWithin: readonly { from: string; to: string }[],
): { waves: string[][]; cyclic: string[] } {
  const remaining = new Set(selection);
  // `from` must happen before `to`.
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of selection) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }
  for (const edge of edgesWithin) {
    if (!remaining.has(edge.from) || !remaining.has(edge.to) || edge.from === edge.to) continue;
    incoming.get(edge.to)?.add(edge.from);
    outgoing.get(edge.from)?.add(edge.to);
  }

  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (incoming.get(id)?.size ?? 0) === 0);
    if (ready.length === 0) {
      // Everything left is in, or behind, a cycle. Stop rather than breaking
      // one arbitrarily: a guessed order presented as a plan is worse than
      // saying the graph cannot answer.
      return { waves, cyclic: [...remaining] };
    }
    // Stable within a wave, so two runs of the same plan read identically.
    ready.sort();
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      for (const next of outgoing.get(id) ?? []) incoming.get(next)?.delete(id);
    }
  }
  return { waves, cyclic: [] };
}

export interface PlanInput {
  intent: MaintenanceIntent;
  /** Resource ids the operator selected. */
  resourceIds: readonly string[];
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  /** Whether the graph the edges came from was truncated. */
  truncated?: boolean | undefined;
}

/**
 * Build the plan.
 *
 * The direction is the only thing the intent changes, and it changes it once,
 * here — every other part of this module is direction-agnostic, which is what
 * keeps "did we get start and stop the right way round" a single line to check
 * rather than a property of the whole algorithm.
 */
export function buildMaintenancePlan(input: PlanInput): MaintenancePlan {
  const model = buildDependencyGraph(input.nodes, input.edges);
  const selection = [...new Set(input.resourceIds)].slice(0, MAINTENANCE_LIMITS.maxSelection);

  const unknown = selection.filter((id) => !model.nodesById.has(id));
  const known = selection.filter((id) => model.nodesById.has(id));
  const inSelection = new Set(known);

  const label = (id: string) => model.nodesById.get(id)?.displayName ?? id;

  // `dependsOn` edges point consumer → provider. For a start, the provider has
  // to happen first; for a stop or restart, the consumer does. One expression,
  // one place to be wrong.
  const startFirst = input.intent === "start";
  const ordering: { from: string; to: string }[] = [];
  for (const edge of model.edges) {
    if (!inSelection.has(edge.consumerResourceId) || !inSelection.has(edge.providerResourceId)) {
      continue;
    }
    ordering.push(
      startFirst
        ? { from: edge.providerResourceId, to: edge.consumerResourceId }
        : { from: edge.consumerResourceId, to: edge.providerResourceId },
    );
  }

  const { waves, cyclic } = orderWaves(known, ordering);

  const steps: MaintenanceStep[] = waves.map((wave, index) => ({
    position: index + 1,
    resourceIds: wave,
    labels: wave.map(label),
    // Outside impact is only meaningful when something is going away. For a
    // start, nothing outside is affected by the thing coming back — and
    // listing dependants there would read as a warning about a recovery.
    affectsOutside: startFirst ? [] : outsideImpact(wave),
  }));

  function outsideImpact(wave: readonly string[]): MaintenanceImpact[] {
    const seen = new Set<string>();
    const impacts: MaintenanceImpact[] = [];
    for (const id of wave) {
      for (const [dependantId] of collectDependentsWithDepth(model, id)) {
        // Already in the plan, or already reported: the operator knows about
        // the first and does not need the second twice.
        if (inSelection.has(dependantId) || seen.has(dependantId)) continue;
        seen.add(dependantId);
        impacts.push({ resourceId: dependantId, label: label(dependantId), viaResourceId: id });
        if (impacts.length >= MAINTENANCE_LIMITS.maxImpactPerStep) return impacts;
      }
    }
    return impacts;
  }

  return {
    intent: input.intent,
    steps,
    cyclic: cyclic.map((id) => ({ resourceId: id, label: label(id), viaResourceId: id })),
    unknown,
    partialGraph: input.truncated === true,
  };
}

/** How many resources the plan actually orders. */
export function plannedResourceCount(plan: MaintenancePlan): number {
  return plan.steps.reduce((sum, step) => sum + step.resourceIds.length, 0);
}

/** One sentence describing the direction, for the top of the plan. */
export function describeMaintenanceOrder(intent: MaintenanceIntent): string {
  return intent === "start"
    ? "Dependencies first — nothing comes up looking for something that is not there yet."
    : "Dependants first — drain what sits in front before what sits behind it goes away.";
}
