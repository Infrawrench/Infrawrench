import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import { CiPanel } from "@infrawrench/ui/ci";
import { hasPermission, type OrgMembership } from "@infrawrench/client-core";
import { createDesktopCiClient } from "@/lib/ci-client";
import { createDesktopSettingsApi } from "@/lib/settings-client";
import { ciTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";
import { openExternalUrl } from "../lib/app-shell";

/**
 * CI on desktop: the same screen web renders, as the "ci" workspace tab.
 * Cloud-only, so without an org the tab explains rather than fetching.
 */
export function DesktopCiPanel({ runId }: { runId?: string | undefined }) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopCiClient(), []);
  const api = useMemo(() => createDesktopSettingsApi(), []);
  // What the member may do, to show only the controls that would work; the
  // server enforces regardless.
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  useEffect(() => {
    setPermissions([]);
    if (!activeCloudOrgId) return;
    let cancelled = false;
    api
      .get<OrgMembership>(`/api/org/${activeCloudOrgId}/team/me`)
      .then((me) => !cancelled && setPermissions(me.permissions))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, activeCloudOrgId]);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("CI requires cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    // A run uses the tab's whole width: its graph needs it.
    <div className={runId ? "p-6" : "p-6 max-w-6xl mx-auto"}>
      {/* Keyed by org so switching org remounts and refetches. */}
      <CiPanel
        key={activeCloudOrgId}
        client={client}
        selectedRunId={runId ?? null}
        onSelectRun={(next) =>
          void navigateToWorkspaceTarget(navigate, ciTabTarget(next ?? undefined), {
            label: gt("CI"),
          })
        }
        canWrite={hasPermission(permissions, "ci:write")}
        canManageAccess={hasPermission(permissions, "ci-access:write")}
        canApprove={hasPermission(permissions, "ci:approve")}
        onOpenUrl={(url) => void openExternalUrl(url)}
        onDownloadUrl={(url) => void openExternalUrl(url)}
      />
    </div>
  );
}
