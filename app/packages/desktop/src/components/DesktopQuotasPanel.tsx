import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  QuotasSection,
  useUIStore,
  type QuotaListResponse,
  type RunwayListResponse,
} from "@infrawrench/ui";
import { cloudClient } from "@/lib/cloud-client";
import { runRpc } from "@/lib/rpc/client";
import { fetchDesktopRunway } from "@/lib/runway-client";
import { getWorkspaceNavigateArgs, resourceTabTarget } from "@/lib/workspace-tabs";
import { openExternalUrl } from "../lib/app-shell";

/**
 * The quota radar and the capacity runway on desktop: the same screen web
 * renders. Rendered as a workspace tab (the "quotas" kind).
 *
 * Cloud-only, and unlike the Expiring tab there is no local-mode fallback:
 * expiry is computed over rows this machine already holds, whereas a quota
 * reading is a live credentialed provider call on a schedule the desktop does
 * not run, with a trend fitted over history it does not store; the runway's
 * history is recorded by the cloud sync for the same reason. Without an org
 * the tab explains rather than fetching.
 */
export function DesktopQuotasPanel() {
  const gt = useGT();
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<QuotaListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runway, setRunway] = useState<RunwayListResponse | null>(null);
  const [runwayError, setRunwayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCloudOrgId) return;
    try {
      const quotas: QuotaListResponse = await runRpc(
        cloudClient("quotas").quotas.list({ params: { orgId: activeCloudOrgId } }),
      );
      setData(quotas);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Request failed"));
    }
  }, [activeCloudOrgId]);

  // Separate from the quota read so one failing never blanks the other.
  const loadRunway = useCallback(async () => {
    if (!activeCloudOrgId) return;
    try {
      setRunway(await fetchDesktopRunway(activeCloudOrgId));
      setRunwayError(null);
    } catch (err) {
      setRunwayError(err instanceof Error ? err.message : gt("Request failed"));
    }
  }, [activeCloudOrgId]);

  useEffect(() => {
    setData(null);
    setError(null);
    setRunway(null);
    setRunwayError(null);
    void load();
    void loadRunway();
  }, [load, loadRunway]);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("The quota radar requires cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <QuotasSection
      key={activeCloudOrgId}
      data={data}
      error={error}
      onRetry={() => void load()}
      onOpenExternal={(url) => void openExternalUrl(url)}
      runway={runway}
      runwayError={runwayError}
      onRetryRunway={() => void loadRunway()}
      onOpenResource={(row) =>
        void navigate(
          getWorkspaceNavigateArgs(
            resourceTabTarget(row.accountId, row.resourceId, row.pluginId, row.resourceTypeId),
          ),
        )
      }
    />
  );
}
