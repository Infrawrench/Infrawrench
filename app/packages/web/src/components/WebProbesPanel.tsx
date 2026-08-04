import { useMemo } from "react";
import { ProbesPanel } from "@infrawrench/ui/probes";
import { createWebProbesClient } from "@/lib/probes-client";

/**
 * Synthetic probes. The panel lives in `@infrawrench/ui` so desktop renders
 * the identical screen; this component is the web host. Rendered as a
 * workspace tab (the "probes" kind) by WebWorkspaceTabsViewport.
 */
export function WebProbesPanel({ orgId }: { orgId: string }) {
  const client = useMemo(() => createWebProbesClient(orgId), [orgId]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ProbesPanel key={orgId} client={client} />
    </div>
  );
}
