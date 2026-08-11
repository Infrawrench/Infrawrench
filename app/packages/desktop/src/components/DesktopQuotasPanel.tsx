import { useCallback, useEffect, useState } from "react";
import { QuotasSection, useUIStore, type QuotaListResponse } from "@infrawrench/ui";
import { invoke } from "@/lib/invoke";

/**
 * The quota radar on desktop — the same screen web renders. Rendered as a
 * workspace tab (the "quotas" kind).
 *
 * Cloud-only, and unlike the Expiring tab there is no local-mode fallback:
 * expiry is computed over rows this machine already holds, whereas a quota
 * reading is a live credentialed provider call on a schedule the desktop does
 * not run, with a trend fitted over history it does not store. Without an org
 * the tab explains rather than fetching.
 */
export function DesktopQuotasPanel() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<QuotaListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCloudOrgId) return;
    try {
      setData(await invoke<QuotaListResponse>("cloud_quotas", { orgId: activeCloudOrgId }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }, [activeCloudOrgId]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        The quota radar requires cloud mode — sign in to sync. Readings are collected by the cloud
        poller on a schedule, and the trend needs the history it keeps.
      </div>
    );
  }

  return (
    <QuotasSection
      key={activeCloudOrgId}
      data={data}
      error={error}
      onRetry={() => void load()}
      onOpenExternal={(url) => void invoke("open_external_url", { url })}
    />
  );
}
