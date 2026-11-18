import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { QuotasSection, type QuotaListResponse, type RunwayListResponse } from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

/**
 * The quota radar and the capacity runway. The panel itself lives in
 * `@infrawrench/ui` so desktop renders the identical screen; this component is
 * the web host and owns only the fetches and the resource link. Rendered as a
 * workspace tab (the "quotas" kind) by WebWorkspaceTabsViewport.
 */
export function WebQuotasPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<QuotaListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runway, setRunway] = useState<RunwayListResponse | null>(null);
  const [runwayError, setRunwayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<QuotaListResponse>(`/api/org/${encodeURIComponent(orgId)}/quotas`));
      setError(null);
    } catch (err) {
      // The last feed deliberately stays on screen: QuotasSection renders a
      // banner over it rather than blanking a drawn list.
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }, [orgId]);

  // Separate from the quota read so one failing never blanks the other.
  const loadRunway = useCallback(async () => {
    try {
      setRunway(
        await apiGet<RunwayListResponse>(`/api/org/${encodeURIComponent(orgId)}/quotas/runway`),
      );
      setRunwayError(null);
    } catch (err) {
      setRunwayError(err instanceof Error ? err.message : "Request failed");
    }
  }, [orgId]);

  useEffect(() => {
    setData(null);
    setError(null);
    setRunway(null);
    setRunwayError(null);
    void load();
    void loadRunway();
  }, [load, loadRunway]);

  return (
    <QuotasSection
      data={data}
      error={error}
      onRetry={() => void load()}
      onOpenExternal={(url) => window.open(url, "_blank", "noopener,noreferrer")}
      runway={runway}
      runwayError={runwayError}
      onRetryRunway={() => void loadRunway()}
      onOpenResource={(row) =>
        void navigate({
          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
          params: {
            orgId,
            pluginId: row.pluginId,
            resourceTypeId: row.resourceTypeId,
            resourceId: row.resourceId,
          },
          search: { accountId: row.accountId },
        })
      }
    />
  );
}
