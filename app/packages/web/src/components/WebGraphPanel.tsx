import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  RESOURCES_CHANGED_EVENT,
  DependencyGraphView,
  MaintenancePlanSection,
  type DependencyGraphData,
  type MaintenancePlan,
  type DependencyGraphNode,
} from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";

interface WebGraphPanelProps {
  orgId: string;
  openResource: (node: DependencyGraphNode) => void;
}

/**
 * Web host for the shared dependency-graph view: fetches the org graph from
 * the API and refreshes when resources change.
 */
export function WebGraphPanel({ orgId, openResource }: WebGraphPanelProps) {
  const gt = useGT();
  const [data, setData] = useState<DependencyGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Clear on org change: without this the previous org's topology stays on
    // screen until the new fetch resolves, which reads as this org's graph.
    setData(null);
    setError(null);
    function load() {
      apiGet<DependencyGraphData>(`/api/org/${orgId}/dependency-graph`)
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          // A failed *refresh* must not blank a graph that is already drawn —
          // surface it as a banner over the existing render instead.
          if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load graph");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [orgId, reloadKey]);

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
        <p className="text-sm text-on-surface-muted mt-0.5">
          {gt(
            "How your resources are wired together — read from your synced cloud data and from output references you wire yourself.",
          )}
        </p>
        {error && (
          <p className="mt-2 text-xs text-danger">
            {gt("Couldn’t refresh — showing the last loaded graph. {error}", { error })}
          </p>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        <DependencyGraphView data={data} onOpenResource={openResource} />
        {/* Beneath the picture that produced it: somebody looking at the wiring
            is the person about to ask what order to touch it in. */}
        <MaintenancePlanSection
          graph={data}
          onPlan={(input) => apiPost<MaintenancePlan>(`/api/org/${orgId}/maintenance-plan`, input)}
          // The canvas hands `openResource` a whole node; the planner only has
          // an id, so it is looked back up rather than the callback widened —
          // one shape for "open this resource" across the page.
          onOpenResource={(resourceId) => {
            const node = data.nodes.find((n) => n.id === resourceId);
            if (node) openResource(node);
          }}
        />
      </div>
    </div>
  );
}
