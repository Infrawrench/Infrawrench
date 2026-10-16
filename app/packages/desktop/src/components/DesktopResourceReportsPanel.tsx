import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import { ResourceReportsPanel } from "@infrawrench/ui/resource-reports";
import { createDesktopResourceReportsClient } from "@/lib/resource-reports-client";
import {
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  resourceReportsTabTarget,
  resourceTabTarget,
} from "@/lib/workspace-tabs";

/**
 * Resource reports on desktop: the same screen web renders, as the
 * "resource-reports" workspace tab. Cloud-only, like Cost reports: the rows
 * are a server-side join of the synced inventory with the cost store.
 */
export function DesktopResourceReportsPanel({ reportId }: { reportId?: string | undefined }) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopResourceReportsClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="h-full flex items-center justify-center px-8 text-center text-sm text-on-surface-faint">
        {gt(
          "Resource reports live in Infrawrench Cloud. Sign in and pick an organization to see them.",
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ResourceReportsPanel
        key={activeCloudOrgId}
        client={client}
        reportId={reportId}
        onReportChange={(next) =>
          void navigateToWorkspaceTarget(navigate, resourceReportsTabTarget(next ?? undefined), {
            label: gt("Resource reports"),
          })
        }
        onOpenResource={(ref) =>
          void navigate(
            getWorkspaceNavigateArgs(
              resourceTabTarget(ref.accountId, ref.resourceId, ref.pluginId, ref.resourceTypeId),
            ),
          )
        }
      />
    </div>
  );
}
