import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import { MigrationEstimatesPanel } from "@infrawrench/ui/migration-estimates/MigrationEstimatesPanel";
import { createDesktopMigrationEstimatesClient } from "@/lib/migration-estimates-client";
import {
  getWorkspaceNavigateArgs,
  migrationEstimatesTabTarget,
  navigateToWorkspaceTarget,
  resourceTabTarget,
} from "@/lib/workspace-tabs";

/**
 * Migration estimates on desktop: the same screen web renders, as the
 * "migration-estimates" workspace tab. Cloud-only, like Resource reports: the
 * current side is the cloud's billed spend and the target side is priced with
 * the org's accounts.
 */
export function DesktopMigrationEstimatesPanel({
  estimateId,
}: {
  estimateId?: string | undefined;
}) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopMigrationEstimatesClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="h-full flex items-center justify-center px-8 text-center text-sm text-on-surface-faint">
        {gt(
          "Migration estimates live in Infrawrench Cloud. Sign in and pick an organization to see them.",
        )}
      </div>
    );
  }

  return (
    <div className="w-full p-6 max-w-[1400px] mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <MigrationEstimatesPanel
        key={activeCloudOrgId}
        client={client}
        estimateId={estimateId}
        onEstimateChange={(next) =>
          void navigateToWorkspaceTarget(navigate, migrationEstimatesTabTarget(next ?? undefined), {
            label: gt("Migration estimates"),
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
