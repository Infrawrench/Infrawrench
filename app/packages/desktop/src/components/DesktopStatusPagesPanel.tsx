import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { StatusPagesPanel, useUIStore } from "@infrawrench/ui";
import { createDesktopStatusPagesClient } from "@/lib/status-pages-client";
import { navigateToWorkspaceTarget, probesTabTarget } from "@/lib/workspace-tabs";

/** Standalone workspace tool for configuring public status pages. */
export function DesktopStatusPagesPanel() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopStatusPagesClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Status pages require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <StatusPagesPanel
        key={activeCloudOrgId}
        client={client}
        onOpenProbes={() =>
          void navigateToWorkspaceTarget(navigate, probesTabTarget(), { label: "Probes" })
        }
      />
    </div>
  );
}
