import { useMemo } from "react";
import {
  ResourceReportsPanel,
  type ResourceReportResourceRef,
} from "@infrawrench/ui/resource-reports";
import { usePermissions } from "@/auth/permissions-context";
import { createWebResourceReportsClient } from "@/lib/resource-reports-client";

/**
 * Web host for the shared resource reports screen, rendered as the
 * "resource-reports" workspace tab. Which report is open lives in the URL
 * (`/org/:orgId/resource-reports/:id`), the cost reports stance.
 */
export function WebResourceReportsPanel({
  orgId,
  reportId,
  onSelectReport,
  onOpenResource,
}: {
  orgId: string;
  reportId?: string | undefined;
  onSelectReport: (reportId: string | null) => void;
  onOpenResource: (ref: ResourceReportResourceRef) => void;
}) {
  const { has } = usePermissions();
  const canWrite = has("resources:write");
  const canWriteFolders = has("costs:write");
  const client = useMemo(
    () => createWebResourceReportsClient(orgId, canWrite, canWriteFolders),
    [orgId, canWrite, canWriteFolders],
  );
  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ResourceReportsPanel
        key={orgId}
        client={client}
        reportId={reportId}
        onReportChange={onSelectReport}
        onOpenResource={onOpenResource}
      />
    </div>
  );
}
