import { useMemo, useState } from "react";
import {
  buildDependencyGraph,
  collectDependents,
  layoutDependencyGraph,
  type DependencyGraphData,
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
 * The org-wide dependency-graph topology, hand-rolled as plain SVG — no graph
 * library. Layout comes from the shared layered algorithm in
 * `@infrawrench/client-core`; arrows point from a consumer to the provider it
 * depends on. Clicking a node highlights its blast radius (the node plus every
 * transitive dependent); clicking it again — or the "Open resource" button —
 * navigates to the resource. Shared by web and desktop.
 */
export function DependencyGraphView({ data, onOpenResource }: DependencyGraphViewProps) {
  const model = useMemo(() => buildDependencyGraph(data.nodes, data.edges), [data]);
  const layout = useMemo(
    () => layoutDependencyGraph(model, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT }),
    [model],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
        <p className="text-sm text-on-surface-secondary">No output references yet.</p>
        <p className="text-xs text-on-surface-muted max-w-md">
          The dependency graph is built from output references — resources whose fields point at
          another resource's outputs. Create one by picking "Output reference" on a secret field
          when creating or editing a resource.
        </p>
      </div>
    );
  }

  const dependentCount = blastRadius ? blastRadius.size - 1 : 0;

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
              {dependentCount === 0
                ? "Nothing depends on this resource."
                : `Blast radius: ${dependentCount} dependent resource${dependentCount === 1 ? "" : "s"} highlighted.`}
            </span>
            <span className="flex-1" />
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
          <span className="text-xs text-on-surface-muted">
            Arrows point at what a resource depends on. Click a resource to highlight its blast
            radius; click it again to open it.
          </span>
        )}
      </div>

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
            return (
              <path
                key={`${edge.consumerResourceId}:${edge.consumerFieldKey}`}
                d={`M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={active ? "var(--color-accent)" : "var(--color-border-strong)"}
                strokeWidth={active ? 2 : 1.5}
                opacity={blastRadius && !active ? 0.35 : 1}
                markerEnd={active ? "url(#dep-arrow-active)" : "url(#dep-arrow)"}
              >
                <title>{`${edge.consumerFieldKey} ← ${edge.providerOutputKey}`}</title>
              </path>
            );
          })}

          {/* Nodes */}
          {model.nodes.map((node) => {
            const pos = layout.positions.get(node.id);
            if (!pos) return null;
            const isSelected = selected?.id === node.id;
            const inBlast = !blastRadius || blastRadius.has(node.id);
            return (
              <g
                key={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${node.displayName} (${node.resourceTypeLabel})`}
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
                <title>{`${node.displayName} — ${node.resourceTypeLabel} · ${node.accountName}`}</title>
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
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
