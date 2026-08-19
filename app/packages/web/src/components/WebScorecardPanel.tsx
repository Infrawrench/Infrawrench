import { useCallback, useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  ScorecardSection,
  type ScorecardPillarId,
  type ScorecardResponse,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

interface WebScorecardPanelProps {
  orgId: string;
  /**
   * Navigation into the page each pillar summarises. Partial on purpose:
   * ownership is recorded per resource and has no org-level page, so its card
   * is deliberately not a link.
   */
  pillarLinks: Partial<Record<ScorecardPillarId, () => void>>;
}

/**
 * Web host for the shared scorecard screen. Same wiring as WebPosturePanel — a
 * failed *refresh* must not blank a grade that is already drawn, so the last
 * loaded scorecard stays on screen under the section's banner.
 */
export function WebScorecardPanel({ orgId, pillarLinks }: WebScorecardPanelProps) {
  const [data, setData] = useState<ScorecardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Refreshes within this effect (initial load + RESOURCES_CHANGED_EVENT)
    // can resolve out of order; only the newest request may write state.
    let latestRequest = 0;
    // Clear on org change: without this the previous org's grade stays on
    // screen until the new fetch resolves, which reads as this org's.
    setData(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      apiGet<ScorecardResponse>(`/api/org/${orgId}/scorecard`)
        .then((response) => {
          if (cancelled || request !== latestRequest) return;
          setData(response);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || request !== latestRequest) return;
          setError(e instanceof Error ? e.message : "Failed to load the scorecard");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [orgId, reloadKey]);

  return <ScorecardSection data={data} error={error} onRetry={retry} pillarLinks={pillarLinks} />;
}
