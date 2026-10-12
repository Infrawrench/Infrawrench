import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  accessReviewTabTarget,
  backupsTabTarget,
  expiringTabTarget,
  postureTabTarget,
  quotasTabTarget,
} from "@infrawrench/ui";
import {
  ServicesPanel,
  type ServiceResourceRef,
  type ServicesPanelLocation,
} from "@infrawrench/ui/services";
import { usePermissions } from "@/auth/permissions-context";
import { createWebServicesClient } from "@/lib/services-client";
import { getWorkspaceNavigateArgs } from "@/lib/workspace-tabs";

/**
 * Web host for the shared Services screen, rendered as the "services"
 * workspace tab. Which service is open, or whether the scorecards view is
 * showing, lives in the URL (`/org/:orgId/services[/:id | /scorecards]`), the
 * SLOs stance: that records it on the tab and makes a service a link.
 */
export function WebServicesPanel({
  orgId,
  serviceId,
  view,
  onNavigate,
  onOpenResource,
}: {
  orgId: string;
  serviceId?: string | undefined;
  view?: "scorecards" | undefined;
  onNavigate: (location: ServicesPanelLocation) => void;
  onOpenResource: (ref: ServiceResourceRef) => void;
}) {
  const { has } = usePermissions();
  const canWrite = has("resources:write");
  const canReadTeam = has("team:read");
  const canReadCosts = has("costs:read");
  const client = useMemo(
    () => createWebServicesClient(orgId, { canWrite, canReadTeam, canReadCosts }),
    [orgId, canWrite, canReadTeam, canReadCosts],
  );
  const navigate = useNavigate();
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
  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ServicesPanel
        key={orgId}
        client={client}
        serviceId={serviceId}
        view={view}
        onNavigate={onNavigate}
        onOpenResource={onOpenResource}
        orgScorecardLinks={orgScorecardLinks}
      />
    </div>
  );
}
