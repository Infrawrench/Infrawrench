import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { IacPanel, useUIStore } from "@infrawrench/ui";
import { createDesktopIacClient } from "@/lib/iac-client";
import { getWorkspaceNavigateArgs, resourceTabTarget } from "@/lib/workspace-tabs";

/**
 * Infrastructure as Code on desktop — the same panel web renders, over the
 * `cloud_iac_*` IPC. Rendered as a workspace tab (the "iac" kind).
 *
 * Cloud-only: the reconciliation classifies the org's synced inventory, which
 * local-only mode does not have. The guard keeps a restored tab (or signing
 * out with the tab open) from rendering without an org.
 */
export function DesktopIacPanel() {
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopIacClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">Infrastructure as Code</h1>
        <p className="text-sm text-on-surface-muted">
          Reconciliation compares your Terraform state against the resources Infrawrench Cloud has
          synced. Local-only mode has no synced inventory to compare against — sign in to an
          organization to use it.
        </p>
      </div>
    );
  }

  return (
    <IacPanel
      // Keyed by org so switching org refetches rather than showing the
      // previous org's classification.
      key={activeCloudOrgId}
      client={client}
      onOpenResource={(entry) =>
        void navigate(
          getWorkspaceNavigateArgs(
            resourceTabTarget(
              entry.accountId,
              entry.resourceId,
              entry.pluginId,
              entry.resourceTypeId,
            ),
          ),
        )
      }
    />
  );
}
