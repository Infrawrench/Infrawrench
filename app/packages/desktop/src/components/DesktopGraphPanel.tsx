import { useEffect, useState } from "react";
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
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<DependencyGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
          if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load graph");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [activeCloudOrgId]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-on-surface-muted text-sm animate-pulse">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-border">
        <h1 className="text-xl font-semibold text-on-surface">Dependency graph</h1>
        <p className="text-sm text-on-surface-muted mt-0.5">
          How your resources are wired together through output references.
        </p>
      </div>
      <DependencyGraphView data={data} onOpenResource={openResource} />
    </div>
  );
}
