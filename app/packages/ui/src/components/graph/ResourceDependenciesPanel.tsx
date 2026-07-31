import type {
  DependencyGraphNode,
  DependencyNeighbor,
  ResourceDependencies,
} from "@infrawrench/client-core";

interface ResourceDependenciesPanelProps {
  dependencies: ResourceDependencies;
  /** Open the neighbor's resource page. */
  onOpenResource: (node: DependencyGraphNode) => void;
}

/**
 * The per-resource "Depends on / depended on by" panel — direct neighbors in
 * the org's output-reference dependency graph. Rendered by DetailView inside
 * a "Dependencies" tab on both web and desktop; the host assembles the
 * neighbor lists (see `directDependencies` in `@infrawrench/client-core`).
 */
export function ResourceDependenciesPanel({
  dependencies,
  onOpenResource,
}: ResourceDependenciesPanelProps) {
  return (
    <div className="p-6 grid gap-6 md:grid-cols-2 items-start">
      <NeighborList
        title="Depends on"
        hint="Outputs this resource references"
        neighbors={dependencies.dependsOn}
        emptyText="This resource doesn't reference any other resource's outputs."
        onOpenResource={onOpenResource}
      />
      <NeighborList
        title="Depended on by"
        hint="Resources referencing this resource's outputs"
        neighbors={dependencies.dependedOnBy}
        emptyText="No other resource references this resource's outputs."
        onOpenResource={onOpenResource}
      />
    </div>
  );
}

function NeighborList({
  title,
  hint,
  neighbors,
  emptyText,
  onOpenResource,
}: {
  title: string;
  hint: string;
  neighbors: DependencyNeighbor[];
  emptyText: string;
  onOpenResource: (node: DependencyGraphNode) => void;
}) {
  return (
    <section aria-label={title}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
        {title}
      </h3>
      <p className="text-xs text-on-surface-faint mt-0.5 mb-3">{hint}</p>
      {neighbors.length === 0 ? (
        <p className="text-sm text-on-surface-muted">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {/*
            Edges are deduped by (consumer, field) in buildDependencyGraph, so
            node id + field key is already unique in both neighbor lists.
          */}
          {neighbors.map((neighbor) => (
            <li key={`${neighbor.node.id}:${neighbor.fieldKey}`}>
              <button
                type="button"
                onClick={() => onOpenResource(neighbor.node)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-border hover:border-border-strong bg-surface-raised text-left transition-colors"
              >
                <span
                  className="size-5 flex-shrink-0"
                  dangerouslySetInnerHTML={{ __html: neighbor.node.pluginLogoSvg }}
                  aria-hidden
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-on-surface truncate">
                    {neighbor.node.displayName}
                  </span>
                  <span className="block text-xs text-on-surface-muted truncate">
                    {neighbor.node.resourceTypeLabel} · {neighbor.node.accountName}
                  </span>
                </span>
                <span className="text-xs text-on-surface-faint font-mono flex-shrink-0">
                  {neighbor.fieldKey} ← {neighbor.outputKey}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
