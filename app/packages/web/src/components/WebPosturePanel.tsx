import { useCallback, useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  PostureSection,
  type PostureFinding,
  type PostureListResponse,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

interface WebPosturePanelProps {
  orgId: string;
  openResource: (finding: PostureFinding) => void;
}

/**
 * Web host for the shared posture checks: fetches the org's findings from the
 * API and refreshes when resources change. Same wiring as WebExpiryPanel — a
 * failed *refresh* must not blank findings that are already drawn, so the
 * last loaded data stays on screen under the section's banner.
 */
export function WebPosturePanel({ orgId, openResource }: WebPosturePanelProps) {
  const [data, setData] = useState<PostureListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Refreshes within this effect (initial load + RESOURCES_CHANGED_EVENT)
    // can resolve out of order; only the newest request may write state.
    let latestRequest = 0;
    // Clear on org change: without this the previous org's findings stay on
    // screen until the new fetch resolves, which reads as this org's feed.
    setData(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      apiGet<PostureListResponse>(`/api/org/${orgId}/posture`)
        .then((d) => {
          if (!cancelled && request === latestRequest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && request === latestRequest)
            setError(e instanceof Error ? e.message : "Failed to load the posture findings");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [orgId, reloadKey]);

  return <PostureSection data={data} error={error} onRetry={retry} onOpenResource={openResource} />;
}
