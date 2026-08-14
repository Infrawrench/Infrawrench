import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  RESOURCES_CHANGED_EVENT,
  DependencyGraphView,
  useUIStore,
  type DependencyGraphData,
  type DependencyGraphNode,
} from "@infrawrench/ui";
import { fetchCloudDependencyGraph } from "@/lib/cloud-resources";
import { loadLocalDependencyGraph } from "@/lib/local-dependency-graph";

interface DesktopGraphPanelProps {
  openResource: (node: DependencyGraphNode) => void;
}

/**
 * Desktop host for the shared dependency-graph view. Cloud mode fetches the
 * org graph from the web API; local mode assembles the same shape from the
 * local SQLite reference tables.
 */
export function DesktopGraphPanel({ openResource }: DesktopGraphPanelProps) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<DependencyGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Clear on mode/org change: without this the previous org's topology (or
    // the local graph after signing in) stays on screen until the new fetch
    // resolves, which reads as the current context's graph.
    setData(null);
    setError(null);
    function load() {
      const promise = activeCloudOrgId
        ? fetchCloudDependencyGraph(activeCloudOrgId)
        : loadLocalDependencyGraph();
      promise
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          // A failed *refresh* must not blank a graph that is already drawn —
          // surface it as a banner over the existing render instead.
          if (!cancelled) setError(e instanceof Error ? e.message : gt("Failed to load graph"));
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [activeCloudOrgId, reloadKey, gt]);

  if (error && !data) {
    return (
      <div className="p-6">
        <p className="text-danger text-sm">{error}</p>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="mt-3 rounded-md border border-border px-2.5 py-1 text-xs text-on-surface-secondary hover:bg-surface-overlay transition-colors"
        >
          {gt("Retry")}
        </button>
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-on-surface-muted text-sm animate-pulse">{gt("Loading…")}</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-border">
        <h1 className="text-xl font-semibold text-on-surface">{gt("Dependency graph")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-0.5">
            How your resources are wired together — read from your synced cloud data and from output
            references you wire yourself.
          </p>
        </T>
        {error && (
          <p className="mt-2 text-xs text-danger">
            {gt("Couldn’t refresh — showing the last loaded graph. {error}", { error })}
          </p>
        )}
      </div>
      <DependencyGraphView data={data} onOpenResource={openResource} />
    </div>
  );
}
