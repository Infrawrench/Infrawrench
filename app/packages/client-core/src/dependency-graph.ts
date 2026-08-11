/**
 * Cross-provider resource dependency graph, built from output references.
 *
 * Nodes are resources; a directed edge consumer → provider means "consumer
 * depends on provider" (the consumer holds an output reference to one of the
 * provider's outputs). The raw edge rows come from the host — the
 * `associations` topology table plus `secret_field_states` output-ref rows on
 * the server, the same tables in desktop's local SQLite — and this module is
 * the shared pure half: dedupe/index the graph, walk it (blast radius,
 * neighbors), and lay it out for the hand-rolled SVG view.
 *
 * Everything here is host-agnostic and side-effect free so web, desktop and
 * future hosts render the same topology. Re-exported from `@infrawrench/ui`
 * per the shared-contract convention.
 *
 * `fetchDependencyGraph` at the bottom is the one function that talks to a
 * server: Bearer hosts (mobile) read the endpoint through it, while web goes
 * through `apiGet` and desktop through its cloud IPC. It is a plain call, not
 * module state — importing this file still does nothing.
 */

import type { CloudFetch } from "./fetch";

export interface DependencyGraphNode {
  /** Resource id (`pluginId:accountId:externalId` on the cloud). */
  id: string;
  displayName: string;
  pluginId: string;
  pluginDisplayName: string;
  /** Inline SVG markup for the plugin logo; may be empty. */
  pluginLogoSvg: string;
  resourceTypeId: string;
  resourceTypeLabel: string;
  accountId: string;
  accountName: string;
}

/**
 * Where an edge came from. `output-ref` is a reference someone wired by hand;
 * the rest are read back out of synced cloud data by `inferDependencyEdges` —
 * `declared` from a plugin's own `dependsOn` rule, `containment` from the sync
 * path's parent/child link, `field-match` from a field value that happens to
 * name another resource. Absent means `output-ref` (the only kind that existed
 * first).
 */
export type DependencyEdgeKind = "output-ref" | "declared" | "containment" | "field-match";

export interface DependencyGraphEdge {
  /** The resource holding the reference — it depends on the provider. */
  consumerResourceId: string;
  /** The field on the consumer the reference fills. */
  consumerFieldKey: string;
  /** The resource being depended on. */
  providerResourceId: string;
  /** The output on the provider the reference reads. */
  providerOutputKey: string;
  /** Provenance; defaults to `output-ref` when absent. */
  kind?: DependencyEdgeKind;
  /**
   * How the relationship reads, when the plugin named it ("runs in", "routes
   * to"). Hosts show this instead of the field/output caption.
   */
  label?: string;
}

/** Wire shape of the dependency-graph endpoint / local assembly. */
export interface DependencyGraphData {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  /**
   * Set when inference hit its edge cap and the graph is a partial view. Hosts
   * say so rather than presenting a truncated topology as the whole picture.
   */
  truncated?: boolean;
}

/**
 * How an edge reads in the UI. Containment has no field/output pair worth
 * showing — the interesting fact is that one resource lives inside the other.
 */
/**
 * Read `GET /api/org/{orgId}/dependency-graph`.
 *
 * With `resourceId` the server answers with that resource's **direct**
 * neighbourhood only — cheap enough to run on every resource-detail mount, but
 * one hop deep, so a model built from it can produce the Dependencies lists and
 * nothing transitive. Anything that needs a blast radius has to ask for the
 * org-wide graph and walk it locally, which is exactly what the CLI's `graph
 * --resource` does.
 */
export async function fetchDependencyGraph(
  api: CloudFetch,
  orgId: string,
  options?: { resourceId?: string | undefined },
): Promise<DependencyGraphData> {
  const focus = options?.resourceId;
  const path = focus
    ? `/dependency-graph?resourceId=${encodeURIComponent(focus)}`
    : "/dependency-graph";
  const data = await api.org<DependencyGraphData>(orgId, path);
  return data ?? { nodes: [], edges: [] };
}

export function dependencyEdgeLabel(edge: {
  consumerFieldKey: string;
  providerOutputKey: string;
  kind?: DependencyEdgeKind;
  label?: string;
}): string {
  if (edge.label) return edge.label;
  if (edge.kind === "containment") return "belongs to";
  return `${edge.consumerFieldKey} ← ${edge.providerOutputKey}`;
}

export interface DependencyGraphModel {
  /**
   * Nodes with at least one valid edge, in input order. Isolated nodes are
   * dropped — this is the set to render.
   */
  nodes: DependencyGraphNode[];
  /** Deduped edges whose two endpoints both exist in `nodesById`. */
  edges: DependencyGraphEdge[];
  /**
   * Every input node by id, isolated ones included — an index for lookup, not
   * for iteration. Iterate `nodes`.
   */
  nodesById: Map<string, DependencyGraphNode>;
  /** node id → edges where the node is the consumer (what it depends on). */
  dependsOn: Map<string, DependencyGraphEdge[]>;
  /** node id → edges where the node is the provider (what depends on it). */
  dependedOnBy: Map<string, DependencyGraphEdge[]>;
}

/**
 * Index the raw node/edge lists into an adjacency model. Edges are deduped by
 * (consumer, field, provider) — the associations table and the secret-state
 * output-ref rows describe the same reference, so both sources arriving for one
 * field must collapse to one edge. The provider is part of the key because a
 * single field can legitimately name several resources: plugins flatten lists
 * into one comma-joined value (`securityGroups: "sg-a,sg-b"`), and inference
 * turns each part into its own edge. Edges pointing at unknown nodes are
 * dropped.
 */
export function buildDependencyGraph(
  nodes: DependencyGraphNode[],
  edges: DependencyGraphEdge[],
): DependencyGraphModel {
  const nodesById = new Map<string, DependencyGraphNode>();
  for (const node of nodes) {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }

  const seen = new Set<string>();
  const validEdges: DependencyGraphEdge[] = [];
  const dependsOn = new Map<string, DependencyGraphEdge[]>();
  const dependedOnBy = new Map<string, DependencyGraphEdge[]>();

  for (const edge of edges) {
    if (!nodesById.has(edge.consumerResourceId) || !nodesById.has(edge.providerResourceId)) {
      continue;
    }
    // Self-references carry no topology information and would put the node in
    // its own blast radius.
    if (edge.consumerResourceId === edge.providerResourceId) continue;
    const key = `${edge.consumerResourceId}|${edge.consumerFieldKey}|${edge.providerResourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validEdges.push(edge);

    const out = dependsOn.get(edge.consumerResourceId);
    if (out) out.push(edge);
    else dependsOn.set(edge.consumerResourceId, [edge]);

    const inc = dependedOnBy.get(edge.providerResourceId);
    if (inc) inc.push(edge);
    else dependedOnBy.set(edge.providerResourceId, [edge]);
  }

  // Only nodes with at least one valid edge. The graph is about wiring, not
  // inventory: an isolated node has no depth to compute, so it would land in
  // layer 0 and render as a floating tile with nothing attached. Both current
  // hosts already pre-filter, but this is a public export and the next caller
  // may well hand over a full resource list.
  const connected = [...nodesById.values()].filter(
    (n) => dependsOn.has(n.id) || dependedOnBy.has(n.id),
  );

  return {
    nodes: connected,
    edges: validEdges,
    nodesById,
    dependsOn,
    dependedOnBy,
  };
}

export interface DependencyNeighbor {
  node: DependencyGraphNode;
  /** The consumer-side field the reference fills. */
  fieldKey: string;
  /** The provider-side output the reference reads. */
  outputKey: string;
  /** Provenance of the link; defaults to `output-ref` when absent. */
  kind?: DependencyEdgeKind;
  /** Plugin-supplied wording for the relationship, when it named one. */
  label?: string;
}

export interface ResourceDependencies {
  /** Direct providers this resource references. */
  dependsOn: DependencyNeighbor[];
  /** Direct consumers referencing this resource. */
  dependedOnBy: DependencyNeighbor[];
}

/** Direct neighbors of one resource — the "Depends on / depended on by" panel. */
export function directDependencies(
  model: DependencyGraphModel,
  resourceId: string,
): ResourceDependencies {
  const dependsOn: DependencyNeighbor[] = [];
  for (const edge of model.dependsOn.get(resourceId) ?? []) {
    const node = model.nodesById.get(edge.providerResourceId);
    if (node) {
      dependsOn.push({
        node,
        fieldKey: edge.consumerFieldKey,
        outputKey: edge.providerOutputKey,
        ...(edge.kind ? { kind: edge.kind } : {}),
        ...(edge.label ? { label: edge.label } : {}),
      });
    }
  }
  const dependedOnBy: DependencyNeighbor[] = [];
  for (const edge of model.dependedOnBy.get(resourceId) ?? []) {
    const node = model.nodesById.get(edge.consumerResourceId);
    if (node) {
      dependedOnBy.push({
        node,
        fieldKey: edge.consumerFieldKey,
        outputKey: edge.providerOutputKey,
        ...(edge.kind ? { kind: edge.kind } : {}),
        ...(edge.label ? { label: edge.label } : {}),
      });
    }
  }
  return { dependsOn, dependedOnBy };
}

/**
 * Transitive consumers of a resource — its blast radius. If the given
 * resource breaks, everything in the returned set is at risk. The set
 * includes the starting resource itself (a node is always in its own blast
 * radius), so it can be used directly as a highlight set.
 */
export function collectDependents(model: DependencyGraphModel, resourceId: string): Set<string> {
  return new Set(collectDependentsWithDepth(model, resourceId).keys());
}

/**
 * Transitive providers of a resource — everything it directly or indirectly
 * depends on. Includes the starting resource itself.
 */
export function collectDependencies(model: DependencyGraphModel, resourceId: string): Set<string> {
  return new Set(walkWithDepth(model.dependsOn, resourceId, (e) => e.providerResourceId).keys());
}

/**
 * The blast radius, with each dependant's **shortest** hop count from the
 * start — 0 for the start itself, 1 for a direct dependant, 2+ for a
 * transitive one.
 *
 * This is the one traversal in the module: {@link collectDependents} and
 * {@link collectDependencies} both drop the depths and keep the key set, so
 * "who is reachable" and "how far away are they" can never disagree. The
 * impact report needs the distance to say *direct* versus *transitive*, which
 * is the difference between "this will break now" and "this may break", and
 * inventing a second walker for it is how the two answers drift apart.
 */
export function collectDependentsWithDepth(
  model: DependencyGraphModel,
  resourceId: string,
): Map<string, number> {
  return walkWithDepth(model.dependedOnBy, resourceId, (edge) => edge.consumerResourceId);
}

/**
 * Breadth-first reachability with depths. Breadth-first rather than the
 * cheaper stack walk because a depth is only meaningful when it is the
 * shortest one: a resource reachable in one hop and again in four is a direct
 * dependant, and a depth-first walk that happened to find the long path first
 * would label it transitive.
 *
 * `visited` is stamped on enqueue, so a cycle terminates and a self-edge (the
 * model drops those anyway) cannot re-enter the start at a non-zero depth.
 */
function walkWithDepth(
  adjacency: Map<string, DependencyGraphEdge[]>,
  start: string,
  next: (edge: DependencyGraphEdge) => string,
): Map<string, number> {
  const depths = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;
    const depth = depths.get(current) as number;
    for (const edge of adjacency.get(current) ?? []) {
      const target = next(edge);
      if (!depths.has(target)) {
        depths.set(target, depth + 1);
        queue.push(target);
      }
    }
  }
  return depths;
}

export interface DependencyGraphLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  /** Horizontal gap between layers. */
  layerGap?: number;
  /** Vertical gap between nodes in a layer. */
  nodeGap?: number;
  /** Padding around the whole drawing. */
  padding?: number;
}

export interface DependencyGraphLayout {
  /** node id → top-left position of its box. */
  positions: Map<string, { x: number; y: number }>;
  /** Node ids per layer, top-to-bottom, layers left-to-right. */
  layers: string[][];
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
}

/**
 * Layered ("longest-path") layout. Pure providers land in the leftmost
 * layer and consumers to the right of everything they depend on, so
 * dependency arrows always point left. Within a layer, a couple of
 * barycenter sweeps against the previous layer keep edge crossings down.
 * Cycles (possible in principle — nothing in the store forbids A→B→A) are
 * broken by ignoring back edges during the depth pass.
 */
export function layoutDependencyGraph(
  model: DependencyGraphModel,
  options?: DependencyGraphLayoutOptions,
): DependencyGraphLayout {
  const nodeWidth = options?.nodeWidth ?? 180;
  const nodeHeight = options?.nodeHeight ?? 52;
  const layerGap = options?.layerGap ?? 90;
  const nodeGap = options?.nodeGap ?? 18;
  const padding = options?.padding ?? 24;

  // Depth = longest chain of providers under the node. Memoized DFS with an
  // in-progress guard so a reference cycle doesn't recurse forever.
  const depths = new Map<string, number>();
  const inProgress = new Set<string>();
  const depthOf = (id: string): number => {
    const memo = depths.get(id);
    if (memo !== undefined) return memo;
    if (inProgress.has(id)) return 0; // back edge — break the cycle
    inProgress.add(id);
    let depth = 0;
    for (const edge of model.dependsOn.get(id) ?? []) {
      depth = Math.max(depth, depthOf(edge.providerResourceId) + 1);
    }
    inProgress.delete(id);
    depths.set(id, depth);
    return depth;
  };

  // Normalize so the shallowest node sits in layer 0. When every node is on a
  // cycle, the back-edge guard hands out 0 only to the node the walk broke on
  // — which then gets a real depth once its own recursion unwinds — so no node
  // ends up at 0 and layer 0 renders as a blank column. Subtracting the
  // minimum is a no-op for any graph that has a genuine root.
  let minDepth = Infinity;
  let maxDepth = 0;
  for (const node of model.nodes) {
    const d = depthOf(node.id);
    if (d < minDepth) minDepth = d;
    if (d > maxDepth) maxDepth = d;
  }
  if (minDepth > 0 && minDepth !== Infinity) {
    for (const [id, d] of depths) depths.set(id, d - minDepth);
    maxDepth -= minDepth;
  }

  const layers: string[][] = [];
  for (let i = 0; i <= maxDepth; i++) layers.push([]);
  const sortedNodes = [...model.nodes].sort(
    (a, b) => a.pluginId.localeCompare(b.pluginId) || a.displayName.localeCompare(b.displayName),
  );
  for (const node of sortedNodes) {
    const layer = layers[depths.get(node.id) ?? 0];
    if (layer) layer.push(node.id);
  }

  // Barycenter sweeps: order each layer by the mean index of its neighbors
  // in the adjacent layer. One left-to-right pass, one right-to-left.
  const indexIn = (layer: string[]): Map<string, number> => {
    const index = new Map<string, number>();
    layer.forEach((id, i) => index.set(id, i));
    return index;
  };
  const sweep = (from: "left" | "right") => {
    const order = from === "left" ? layers.keys() : [...layers.keys()].reverse();
    let previous: Map<string, number> | null = null;
    for (const li of order) {
      const layer = layers[li];
      if (!layer) continue;
      if (previous) {
        const prev = previous;
        const score = (id: string): number => {
          const edges =
            from === "left" ? (model.dependsOn.get(id) ?? []) : (model.dependedOnBy.get(id) ?? []);
          const neighborIndices: number[] = [];
          for (const edge of edges) {
            const neighborId = from === "left" ? edge.providerResourceId : edge.consumerResourceId;
            const idx = prev.get(neighborId);
            if (idx !== undefined) neighborIndices.push(idx);
          }
          if (neighborIndices.length === 0) return Number.MAX_SAFE_INTEGER;
          return neighborIndices.reduce((a, b) => a + b, 0) / neighborIndices.length;
        };
        const scores = new Map<string, number>();
        for (const id of layer) scores.set(id, score(id));
        layer.sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0));
      }
      previous = indexIn(layer);
    }
  };
  sweep("left");
  sweep("right");

  // Positions: layer 0 (pure providers) on the left, each layer centered
  // vertically against the tallest one.
  let maxLayerCount = 0;
  for (const layer of layers) maxLayerCount = Math.max(maxLayerCount, layer.length);
  const contentHeight = Math.max(
    maxLayerCount * nodeHeight + Math.max(0, maxLayerCount - 1) * nodeGap,
    nodeHeight,
  );

  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, li) => {
    const layerHeight = layer.length * nodeHeight + Math.max(0, layer.length - 1) * nodeGap;
    const yStart = padding + (contentHeight - layerHeight) / 2;
    layer.forEach((id, i) => {
      positions.set(id, {
        x: padding + li * (nodeWidth + layerGap),
        y: yStart + i * (nodeHeight + nodeGap),
      });
    });
  });

  return {
    positions,
    layers,
    width:
      padding * 2 +
      Math.max(1, layers.length) * nodeWidth +
      Math.max(0, layers.length - 1) * layerGap,
    height: padding * 2 + contentHeight,
    nodeWidth,
    nodeHeight,
  };
}
