import { useCallback, useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  PostureSection,
  useUIStore,
  type PostureFinding,
  type PostureListResponse,
} from "@infrawrench/ui";
import { fetchCloudPosture } from "@/lib/cloud-resources";
import { loadLocalPosture } from "@/lib/local-posture";

interface DesktopPosturePanelProps {
  openResource: (finding: PostureFinding) => void;
}

/**
 * Desktop host for the shared posture checks. Cloud mode fetches the org
 * findings from the web API; local mode runs the same shared computation over
 * the local SQLite workspace and the locally loaded plugins' `postureChecks`
 * declarations. Same wiring as DesktopExpiryPanel — a failed *refresh* must
 * not blank findings that are already drawn.
 */
export function DesktopPosturePanel({ openResource }: DesktopPosturePanelProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<PostureListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    // Clear on mode/org change: without this the previous context's findings
    // stay on screen until the new fetch resolves.
    setData(null);
    setError(null);
    function load() {
      const seq = ++latest;
      const promise = activeCloudOrgId ? fetchCloudPosture(activeCloudOrgId) : loadLocalPosture();
      promise
        .then((d) => {
          if (!cancelled && seq === latest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && seq === latest)
            setError(e instanceof Error ? e.message : "Failed to load the posture findings");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [activeCloudOrgId, reloadKey]);

  return <PostureSection data={data} error={error} onRetry={retry} onOpenResource={openResource} />;
}
