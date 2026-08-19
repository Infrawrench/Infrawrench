import { useCallback, useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  RESOURCES_CHANGED_EVENT,
  ScorecardSection,
  useUIStore,
  type ScorecardPillarId,
  type ScorecardResponse,
} from "@infrawrench/ui";
import { fetchCloudScorecard } from "@/lib/cloud-resources";

interface DesktopScorecardPanelProps {
  /**
   * Navigation into the page each pillar summarises. Partial on purpose:
   * ownership is recorded per resource and has no org-level page.
   */
  pillarLinks: Partial<Record<ScorecardPillarId, () => void>>;
}

/**
 * Desktop host for the shared scorecard screen. Cloud only, like Backups: two
 * of its six pillars (recoverability's objectives, the access review) are org
 * state, the trend lives in a cloud table, and a scorecard missing a third of
 * its pillars would grade an org on the wrong thing. Local mode gets the
 * Changes/Costs treatment — an explicit "sign in" message.
 */
export function DesktopScorecardPanel({ pillarLinks }: DesktopScorecardPanelProps) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<ScorecardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!activeCloudOrgId) return;
    let cancelled = false;
    let latestRequest = 0;
    setData(null);
    setError(null);
    function load() {
      const orgId = activeCloudOrgId;
      if (!orgId) return;
      const request = ++latestRequest;
      fetchCloudScorecard(orgId)
        .then((response) => {
          if (cancelled || request !== latestRequest) return;
          setData(response);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || request !== latestRequest) return;
          setError(e instanceof Error ? e.message : gt("Failed to load the scorecard"));
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [activeCloudOrgId, reloadKey]);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">{gt("Scorecard")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted">
            The scorecard is a cloud feature. Sign in to an organization to grade its posture,
            recoverability, deadlines, quota headroom, cloud access and ownership together — and to
            watch that grade move.
          </p>
        </T>
      </div>
    );
  }

  return <ScorecardSection data={data} error={error} onRetry={retry} pillarLinks={pillarLinks} />;
}
