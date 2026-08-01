import { useCallback, useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  ExpirySection,
  useUIStore,
  type ExpiryItem,
  type ExpiryListResponse,
} from "@infrawrench/ui";
import { fetchCloudExpiring } from "@/lib/cloud-resources";
import { loadLocalExpiring } from "@/lib/local-expiring";

interface DesktopExpiryPanelProps {
  openResource: (item: ExpiryItem) => void;
}

/**
 * Desktop host for the shared Expiry radar. Cloud mode fetches the org feed
 * from the web API; local mode runs the same shared computation over the
 * local SQLite workspace and the locally loaded plugins' `expiryFields`
 * declarations. Same wiring as DesktopGraphPanel — a failed *refresh* must
 * not blank a feed that is already drawn.
 */
export function DesktopExpiryPanel({ openResource }: DesktopExpiryPanelProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<ExpiryListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Clear on mode/org change: without this the previous context's deadlines
    // stay on screen until the new fetch resolves.
    setData(null);
    setError(null);
    function load() {
      const promise = activeCloudOrgId ? fetchCloudExpiring(activeCloudOrgId) : loadLocalExpiring();
      promise
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setError(e instanceof Error ? e.message : "Failed to load the expiry feed");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [activeCloudOrgId, reloadKey]);

  return <ExpirySection data={data} error={error} onRetry={retry} onOpenResource={openResource} />;
}
