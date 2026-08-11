import { useCallback, useEffect, useState } from "react";
import { QuotasSection, type QuotaListResponse } from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

/**
 * The quota radar. The panel itself lives in `@infrawrench/ui` so desktop
 * renders the identical screen; this component is the web host and owns only
 * the fetch. Rendered as a workspace tab (the "quotas" kind) by
 * WebWorkspaceTabsViewport.
 */
export function WebQuotasPanel({ orgId }: { orgId: string }) {
  const [data, setData] = useState<QuotaListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<QuotaListResponse>(`/api/org/${encodeURIComponent(orgId)}/quotas`));
      setError(null);
    } catch (err) {
      // The last feed deliberately stays on screen — QuotasSection renders a
      // banner over it rather than blanking a drawn list.
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }, [orgId]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  return (
    <QuotasSection
      data={data}
      error={error}
      onRetry={() => void load()}
      onOpenExternal={(url) => window.open(url, "_blank", "noopener,noreferrer")}
    />
  );
}
