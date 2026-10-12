import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  accessReviewTabTarget,
  backupsTabTarget,
  expiringTabTarget,
  postureTabTarget,
  quotasTabTarget,
  useUIStore,
} from "@infrawrench/ui";
import { ServicesPanel } from "@infrawrench/ui/services";
import { createDesktopServicesClient } from "@/lib/services-client";
import {
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  resourceTabTarget,
  servicesTabTarget,
} from "@/lib/workspace-tabs";

/**
 * Services on desktop: the same screen web renders, as the "services"
 * workspace tab. Cloud-only: membership is resolved against the cloud
 * inventory and scores by the cloud poller, so without an org the tab
 * explains rather than fetching.
 */
export function DesktopServicesPanel({
  serviceId,
  view,
}: {
  serviceId?: string | undefined;
  view?: "scorecards" | undefined;
}) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopServicesClient(), []);
  // The org grade's pillar cards lead to the page each one reads. Ownership
  // is recorded per resource and has no org-level page; service standards
  // reads the matrix on the same view.
  const orgScorecardLinks = useMemo(
    () => ({
      posture: () => void navigate(getWorkspaceNavigateArgs(postureTabTarget())),
      recoverability: () => void navigate(getWorkspaceNavigateArgs(backupsTabTarget())),
      deadlines: () => void navigate(getWorkspaceNavigateArgs(expiringTabTarget())),
      access: () => void navigate(getWorkspaceNavigateArgs(accessReviewTabTarget())),
      headroom: () => void navigate(getWorkspaceNavigateArgs(quotasTabTarget())),
    }),
    [navigate],
  );

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("Services require cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ServicesPanel
        key={activeCloudOrgId}
        client={client}
        serviceId={serviceId}
        view={view}
        onNavigate={(next) =>
          void navigateToWorkspaceTarget(navigate, servicesTabTarget(next.serviceId, next.view), {
            label: gt("Services"),
          })
        }
        orgScorecardLinks={orgScorecardLinks}
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
