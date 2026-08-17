import { useCallback, useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  WALLBOARD_LIMITS,
  WallboardSection,
  useUIStore,
  type WallboardResponse,
} from "@infrawrench/ui";
import { fetchCloudWallboard } from "@/lib/cloud-resources";

/**
 * Desktop host for the wallboard. Cloud only: three of its four sources are org
 * state and the fourth is run by the cloud poller, so a local wall would be a
 * screen showing one quarter of the answer.
 *
 * A failed poll deliberately leaves the last reading on screen; the section's
 * own stale marker is what says the wall has stopped updating.
 */
export function DesktopWallboardPanel() {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<WallboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const togglePaused = useCallback(() => setPaused((value) => !value), []);

  useEffect(() => {
    if (!activeCloudOrgId) return;
    let cancelled = false;
    setData(null);
    setError(null);
    function load() {
      const orgId = activeCloudOrgId;
      if (!orgId) return;
      fetchCloudWallboard(orgId)
        .then((response) => {
          if (cancelled) return;
          setData(response);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : gt("Could not reach Infrawrench"));
        });
    }
    load();
    const timer = setInterval(load, WALLBOARD_LIMITS.defaultRefreshSeconds * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeCloudOrgId]);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">{gt("Wallboard")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted">
            The wallboard is a cloud feature — incidents, query monitors and sync health all live in
            the cloud. Sign in to an organization to put it on a screen.
          </p>
        </T>
      </div>
    );
  }

  return (
    <WallboardSection
      data={data}
      error={error}
      refreshSeconds={WALLBOARD_LIMITS.defaultRefreshSeconds}
      rotateSeconds={WALLBOARD_LIMITS.defaultRotateSeconds}
      paused={paused}
      onTogglePaused={togglePaused}
    />
  );
}
