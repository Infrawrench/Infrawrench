import { useCallback, useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  ExpirySection,
  type ExpiryItem,
  type ExpiryListResponse,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

interface WebExpiryPanelProps {
  orgId: string;
  openResource: (item: ExpiryItem) => void;
}

/**
 * Web host for the shared Expiry radar: fetches the org's expiry feed from the
 * API and refreshes when resources change. Same wiring as WebGraphPanel — a
 * failed *refresh* must not blank a feed that is already drawn, so the last
 * loaded data stays on screen under the section's banner.
 */
export function WebExpiryPanel({ orgId, openResource }: WebExpiryPanelProps) {
  const [data, setData] = useState<ExpiryListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Clear on org change: without this the previous org's deadlines stay on
    // screen until the new fetch resolves, which reads as this org's feed.
    setData(null);
    setError(null);
    function load() {
      apiGet<ExpiryListResponse>(`/api/org/${orgId}/expiring`)
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
  }, [orgId, reloadKey]);

  return <ExpirySection data={data} error={error} onRetry={retry} onOpenResource={openResource} />;
}
