import { useMemo, useState } from "react";
import {
  buildDependencyGraph,
  collapseIdenticalNodes,
  collectDependents,
  dependencyEdgeLabel,
  layoutDependencyGraph,
  type DependencyGraphData,
  type DependencyGraphEdge,
  type DependencyGraphNode,
} from "@infrawrench/client-core";

interface DependencyGraphViewProps {
  data: DependencyGraphData;
  /** Open the resource's detail page. */
  onOpenResource: (node: DependencyGraphNode) => void;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 54;

/**
 * Line style per provenance — the legend in the header explains these. Declared
 * edges are solid like output references: the plugin stated the relationship,
 * so it is as certain as one the user wired, and only the guessed kinds earn a
 * broken line.
 */
const EDGE_DASH: Record<string, string | undefined> = {
  "output-ref": undefined,
  declared: undefined,
  containment: "2 3",
  "field-match": "5 4",
};

function isExplicit(edge: DependencyGraphEdge): boolean {
  return (edge.kind ?? "output-ref") === "output-ref";
}

/**
 * The org-wide dependency-graph topology, hand-rolled as plain SVG — no graph
 * library. Layout comes from the shared layered algorithm in
 * `@infrawrench/client-core`; arrows point from a consumer to the provider it
 * depends on. Clicking a node highlights its blast radius (the node plus every
 * transitive dependent); clicking it again — or the "Open resource" button —
 * navigates to the resource. Shared by web and desktop.
 *
 * Edges arrive from two sources — hand-wired output references and links read
 * out of synced cloud data — drawn solid and dashed respectively. The toggle
 * hides the inferred ones, which is how you check what is actually wired
 * through the app versus what the provider already had.
 */
export function DependencyGraphView({ data, onOpenResource }: DependencyGraphViewProps) {
  const [showInferred, setShowInferred] = useState(true);
  const [groupIdentical, setGroupIdentical] = useState(true);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const inferredCount = useMemo(() => data.edges.filter((e) => !isExplicit(e)).length, [data]);
  const explicitCount = data.edges.length - inferredCount;

  // Collapse before layout, so a fleet of identical siblings costs one column
  // slot rather than forty. Runs on the *visible* edges: hiding the inferred
  // ones changes what counts as identical wiring.
  const collapsed = useMemo(() => {
    const edges = showInferred ? data.edges : data.edges.filter(isExplicit);
    if (!groupIdentical) {
      return { nodes: data.nodes, edges, groups: new Map(), collapsedCount: 0 };
    }
    return collapseIdenticalNodes({ nodes: data.nodes, edges }, { expandedIds });
  }, [data, showInferred, groupIdentical, expandedIds]);

  const model = useMemo(() => buildDependencyGraph(collapsed.nodes, collapsed.edges), [collapsed]);
  const layout = useMemo(
    () => layoutDependencyGraph(model, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT }),
    [model],
  );

  // A stale selection (resource removed on refresh) must not keep dimming
  // the graph forever.
  const selected = selectedId ? (model.nodesById.get(selectedId) ?? null) : null;
  const blastRadius = useMemo(
    () => (selected ? collectDependents(model, selected.id) : null),
    [model, selected],
  );

  if (model.edges.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center">
        {inferredCount > 0 && !showInferred ? (
          <>
            <p className="text-sm text-on-surface-secondary">No output references yet.</p>
            <p className="text-xs text-on-surface-muted max-w-md">
              Nothing here is wired through an output reference, but {inferredCount} link
              {inferredCount === 1 ? " was" : "s were"} found in your synced cloud data.
            </p>
            <button
              type="button"
              onClick={() => setShowInferred(true)}
              className="mt-1 px-3 py-1 text-xs text-on-surface-secondary border border-border-strong rounded-lg hover:border-accent transition-colors"
            >
              Show links from cloud data
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-on-surface-secondary">No connections yet.</p>
            <p className="text-xs text-on-surface-muted max-w-md">
              The graph is built from your synced cloud data — resources that sit inside another or
              whose fields name another resource — plus output references you wire yourself. Add an
              account and let it sync, or pick "Output reference" on a secret field when creating a
              resource.
            </p>
          </>
        )}
      </div>
    );
  }

  const dependentCount = blastRadius ? blastRadius.size - 1 : 0;
  const selectedGroup = selected ? collapsed.groups.get(selected.id) : undefined;

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Selection header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border text-sm min-h-10">
        {selected ? (
          <>
            <span
              className="size-4 flex-shrink-0"
              dangerouslySetInnerHTML={{ __html: selected.pluginLogoSvg }}
              aria-hidden
            />
            <span className="text-on-surface truncate">{selected.displayName}</span>
            <span className="text-xs text-on-surface-muted truncate">
              {selectedGroup
                ? `${selectedGroup.length} identical resources, wired the same way.`
                : dependentCount === 0
                  ? "Nothing depends on this resource."
                  : `Blast radius: ${dependentCount} dependent resource${dependentCount === 1 ? "" : "s"} highlighted.`}
            </span>
            <span className="flex-1" />
            {selectedGroup && (
              <button
                type="button"
                onClick={() => setExpandedIds((ids) => [...ids, selected.id])}
                className="px-3 py-1 text-xs text-on-surface-secondary border border-border-strong rounded-lg hover:border-accent transition-colors flex-shrink-0"
              >
                Show all {selectedGroup.length}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenResource(selected)}
              className="px-3 py-1 text-xs text-on-surface-secondary border border-border-strong rounded-lg hover:border-accent transition-colors flex-shrink-0"
            >
              Open resource →
            </button>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="px-3 py-1 text-xs text-on-surface-muted border border-border rounded-lg hover:border-border-strong transition-colors flex-shrink-0"
            >
              Clear
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-on-surface-muted truncate">
              Arrows point at what a resource depends on. Click a resource to highlight its blast
              radius; click it again to open it.
            </span>
            <span className="flex-1" />
            <Legend />
            {inferredCount > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-on-surface-muted flex-shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showInferred}
                  onChange={(e) => setShowInferred(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                />
                From cloud data ({inferredCount})
              </label>
            )}
            {(collapsed.collapsedCount > 0 || !groupIdentical) && (
              <label className="flex items-center gap-1.5 text-xs text-on-surface-muted flex-shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={groupIdentical}
                  onChange={(e) => {
                    setGroupIdentical(e.target.checked);
                    setExpandedIds([]);
                  }}
                  className="accent-[var(--color-accent)]"
                />
                Group identical
                {collapsed.collapsedCount > 0 ? ` (${collapsed.collapsedCount} merged)` : ""}
              </label>
            )}
            {expandedIds.length > 0 && (
              <button
                type="button"
                onClick={() => setExpandedIds([])}
                className="px-3 py-1 text-xs text-on-surface-muted border border-border rounded-lg hover:border-border-strong transition-colors flex-shrink-0"
              >
                Regroup
              </button>
            )}
            {explicitCount > 0 && (
              <span className="text-xs text-on-surface-faint flex-shrink-0">
                {explicitCount} output reference{explicitCount === 1 ? "" : "s"}
              </span>
            )}
          </>
        )}
      </div>

      {data.truncated && (
        <div className="shrink-0 px-4 py-1.5 border-b border-border text-xs text-amber-400">
          Too many links to draw them all — showing a partial graph. Open a single resource's
          Dependencies tab for its full neighbourhood.
        </div>
      )}

      {/*
        Canvas. `role="group"`, not `role="img"` — the nodes are focusable
        buttons, and `img` would prune the whole subtree out of the
        accessibility tree. Escape clears the selection while focus is on a
        node; the transparent backdrop rect below does the same for the mouse.
      */}
      <div className="flex-1 overflow-auto min-h-0">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="Resource dependency graph"
          onKeyDown={(e) => {
            if (e.key === "Escape") setSelectedId(null);
          }}
          className="block"
        >
          <defs>
            <marker
              id="dep-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-on-surface-faint)" />
            </marker>
            <marker
              id="dep-arrow-active"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-accent)" />
            </marker>
          </defs>

          {/*
            Mouse-only backdrop: clicking empty canvas clears the selection.
            A sibling of the nodes rather than a wrapper around them, so the
            node buttons keep their own semantics and focus behavior. Keyboard
            users clear via Escape or the "Clear" button in the header.
          */}
          <rect
            width={layout.width}
            height={layout.height}
            fill="transparent"
            pointerEvents="all"
            aria-hidden="true"
            onClick={() => setSelectedId(null)}
          />

          {/* Edges under nodes */}
          {model.edges.map((edge) => {
            const consumer = layout.positions.get(edge.consumerResourceId);
            const provider = layout.positions.get(edge.providerResourceId);
            if (!consumer || !provider) return null;
            // Consumer's left edge → provider's right edge (providers sit left).
            const x1 = consumer.x;
            const y1 = consumer.y + NODE_HEIGHT / 2;
            const x2 = provider.x + NODE_WIDTH;
            const y2 = provider.y + NODE_HEIGHT / 2;
            const bend = Math.max(30, Math.abs(x1 - x2) / 2);
            // Edge is on a dependent path when both endpoints sit inside the
            // blast radius (the walk that built the set followed these edges).
            const active =
              !!blastRadius &&
              blastRadius.has(edge.consumerResourceId) &&
              blastRadius.has(edge.providerResourceId);
            const dash = EDGE_DASH[edge.kind ?? "output-ref"];
            return (
              <path
                key={`${edge.consumerResourceId}:${edge.consumerFieldKey}:${edge.providerResourceId}`}
                d={`M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={active ? "var(--color-accent)" : "var(--color-border-strong)"}
                strokeWidth={active ? 2 : 1.5}
                strokeDasharray={dash}
                opacity={blastRadius && !active ? 0.35 : 1}
                markerEnd={active ? "url(#dep-arrow-active)" : "url(#dep-arrow)"}
              >
                <title>{dependencyEdgeLabel(edge)}</title>
              </path>
            );
          })}

          {/* Nodes */}
          {model.nodes.map((node) => {
            const pos = layout.positions.get(node.id);
            if (!pos) return null;
            const isSelected = selected?.id === node.id;
            const inBlast = !blastRadius || blastRadius.has(node.id);
            const groupSize = collapsed.groups.get(node.id)?.length ?? 1;
            return (
              <g
                key={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                role="button"
                tabIndex={0}
                aria-label={
                  groupSize > 1
                    ? `${node.displayName} (${node.resourceTypeLabel}), ${groupSize} identical resources`
                    : `${node.displayName} (${node.resourceTypeLabel})`
                }
                style={{ cursor: "pointer" }}
                opacity={inBlast ? 1 : 0.35}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isSelected) onOpenResource(node);
                  else setSelectedId(node.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (isSelected) onOpenResource(node);
                    else setSelectedId(node.id);
                  }
                }}
              >
                <title>
                  {groupSize > 1
                    ? `${groupSize} × ${node.displayName} — ${node.resourceTypeLabel} · ${node.accountName}`
                    : `${node.displayName} — ${node.resourceTypeLabel} · ${node.accountName}`}
                </title>
                {/* Offset backing tiles: a stack reads as "several" before
                    the count is read. */}
                {groupSize > 1 && (
                  <>
                    <rect
                      x={6}
                      y={6}
                      width={NODE_WIDTH}
                      height={NODE_HEIGHT}
                      rx={8}
                      fill="var(--color-surface-raised)"
                      stroke="var(--color-border-strong)"
                      strokeWidth={1}
                      opacity={0.4}
                    />
                    <rect
                      x={3}
                      y={3}
                      width={NODE_WIDTH}
                      height={NODE_HEIGHT}
                      rx={8}
                      fill="var(--color-surface-raised)"
                      stroke="var(--color-border-strong)"
                      strokeWidth={1}
                      opacity={0.7}
                    />
                  </>
                )}
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={8}
                  fill="var(--color-surface-raised)"
                  stroke={
                    isSelected
                      ? "var(--color-accent)"
                      : blastRadius?.has(node.id)
                        ? "var(--color-accent-subtle)"
                        : "var(--color-border-strong)"
                  }
                  strokeWidth={isSelected ? 2 : 1}
                />
                <foreignObject x={10} y={(NODE_HEIGHT - 18) / 2} width={18} height={18}>
                  <div
                    style={{ width: 18, height: 18 }}
                    dangerouslySetInnerHTML={{ __html: node.pluginLogoSvg }}
                    aria-hidden
                  />
                </foreignObject>
                <text
                  x={36}
                  y={NODE_HEIGHT / 2 - 4}
                  fontSize={12}
                  fill="var(--color-on-surface)"
                  style={{ userSelect: "none" }}
                >
                  {truncate(node.displayName, 22)}
                </text>
                <text
                  x={36}
                  y={NODE_HEIGHT / 2 + 12}
                  fontSize={10}
                  fill="var(--color-on-surface-muted)"
                  style={{ userSelect: "none" }}
                >
                  {truncate(`${node.resourceTypeLabel} · ${node.accountName}`, 27)}
                </text>
                {groupSize > 1 && (
                  <>
                    <rect
                      x={NODE_WIDTH - 34}
                      y={NODE_HEIGHT / 2 - 10}
                      width={28}
                      height={20}
                      rx={10}
                      fill="var(--color-surface-overlay)"
                      stroke="var(--color-border-strong)"
                      strokeWidth={1}
                    />
                    <text
                      x={NODE_WIDTH - 20}
                      y={NODE_HEIGHT / 2 + 4}
                      fontSize={11}
                      textAnchor="middle"
                      fill="var(--color-on-surface-secondary)"
                      style={{ userSelect: "none" }}
                    >
                      {`×${groupSize}`}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** Line-style key: what a solid, dotted or dashed arrow means. */
function Legend() {
  return (
    <span className="hidden lg:flex items-center gap-3 text-xs text-on-surface-faint flex-shrink-0">
      {(
        [
          ["output-ref", "Reference or provider link"],
          ["containment", "Belongs to"],
          ["field-match", "Named in a field"],
        ] as const
      ).map(([kind, label]) => (
        <span key={kind} className="flex items-center gap-1.5">
          <svg width={18} height={6} aria-hidden className="flex-shrink-0">
            <line
              x1={0}
              y1={3}
              x2={18}
              y2={3}
              stroke="var(--color-border-strong)"
              strokeWidth={1.5}
              strokeDasharray={EDGE_DASH[kind]}
            />
          </svg>
          {label}
        </span>
      ))}
    </span>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
