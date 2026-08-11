import { useMemo } from "react";
import { EnvironmentsPanel, type EnvironmentsClient } from "@infrawrench/ui/environments";
import { createWebEnvironmentsClient } from "@/lib/environments-client";

interface WebEnvironmentsPanelProps {
  orgId: string;
  openResource: (target: {
    accountId: string;
    resourceId: string;
    pluginId: string;
    resourceTypeId: string;
  }) => void;
}

/**
 * Ephemeral environments — templates and the live copies stamped out of them.
 * The panel lives in `@infrawrench/ui` so desktop renders the identical
 * screen; this component is the web host. Rendered as a workspace tab (the
 * "environments" kind) by WebWorkspaceTabsViewport.
 */
export function WebEnvironmentsPanel({ orgId, openResource }: WebEnvironmentsPanelProps) {
  const client = useMemo<EnvironmentsClient>(
    () => ({ ...createWebEnvironmentsClient(orgId), openResource }),
    [orgId, openResource],
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <EnvironmentsPanel key={orgId} client={client} />
    </div>
  );
}
