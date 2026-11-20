import { useMemo } from "react";
import { useGT } from "gt-react";
import {
  ResourceReportsPanel,
  type ResourceReportResourceRef,
} from "@infrawrench/ui/resource-reports";
import { usePermissions } from "@/auth/permissions-context";
import { createWebResourceReportsClient } from "@/lib/resource-reports-client";
import { useStartMigrationEstimate } from "./useStartMigrationEstimate";

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
  const gt = useGT();
  const migration = useStartMigrationEstimate(orgId);
  const startMigration = migration.start;
  return (
    <div className="w-full p-6 max-w-[1400px] mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ResourceReportsPanel
        key={orgId}
        client={client}
        reportId={reportId}
        onReportChange={onSelectReport}
        onOpenResource={onOpenResource}
        onEstimateMigration={
          startMigration && has("costs:read")
            ? (resourceIds) =>
                startMigration({
                  source: { kind: "resources", resourceIds },
                  label: gt("{count} selected resources", { count: resourceIds.length }),
                })
            : undefined
        }
      />
      {migration.dialog}
    </div>
  );
}
