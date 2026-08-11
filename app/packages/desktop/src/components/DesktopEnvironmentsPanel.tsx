import { useMemo } from "react";
import { useUIStore } from "@infrawrench/ui";
import { EnvironmentsPanel, type EnvironmentsClient } from "@infrawrench/ui/environments";
import { createDesktopEnvironmentsClient } from "@/lib/environments-client";

interface DesktopEnvironmentsPanelProps {
  openResource: (target: {
    accountId: string;
    resourceId: string;
    pluginId: string;
    resourceTypeId: string;
  }) => void;
}

/**
 * Ephemeral environments — cloud-mode only, unlike Graph or Expiring. An
 * environment is created against org accounts, recorded in org tables and torn
 * down by the cloud lease pass; there is nothing local to render.
 */
export function DesktopEnvironmentsPanel({ openResource }: DesktopEnvironmentsPanelProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo<EnvironmentsClient>(
    () => ({ ...createDesktopEnvironmentsClient(), openResource }),
    [openResource],
  );

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Ephemeral environments require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <EnvironmentsPanel key={activeCloudOrgId} client={client} />
    </div>
  );
}
