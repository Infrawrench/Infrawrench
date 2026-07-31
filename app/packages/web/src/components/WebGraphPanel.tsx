import { useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  DependencyGraphView,
  type DependencyGraphData,
  type DependencyGraphNode,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

interface WebGraphPanelProps {
  orgId: string;
  openResource: (node: DependencyGraphNode) => void;
}

/**
 * Web host for the shared dependency-graph view: fetches the org graph from
 * the API and refreshes when resources change.
 */
export function WebGraphPanel({ orgId, openResource }: WebGraphPanelProps) {
  const [data, setData] = useState<DependencyGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      apiGet<DependencyGraphData>(`/api/org/${orgId}/dependency-graph`)
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
  }, [orgId]);

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
