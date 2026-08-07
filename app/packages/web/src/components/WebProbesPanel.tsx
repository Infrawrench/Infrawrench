import { useMemo } from "react";
import { ProbesPanel } from "@infrawrench/ui/probes";
import { StatusPagesPanel } from "@infrawrench/ui";
import { createWebProbesClient } from "@/lib/probes-client";
import { createWebStatusPagesClient } from "@/lib/status-pages-client";

/**
 * Synthetic probes, and the status pages that publish them. Both panels live
 * in `@infrawrench/ui` so desktop renders the identical screens; this
 * component is the web host. Rendered as a workspace tab (the "probes" kind)
 * by WebWorkspaceTabsViewport.
 *
 * Status pages sit below the probe list rather than on a tab of their own —
 * publishing monitoring is a decision made while looking at the monitoring.
 */
export function WebProbesPanel({ orgId }: { orgId: string }) {
  const client = useMemo(() => createWebProbesClient(orgId), [orgId]);
  const statusPagesClient = useMemo(() => createWebStatusPagesClient(orgId), [orgId]);

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ProbesPanel key={orgId} client={client} />
      <StatusPagesPanel key={`status-${orgId}`} client={statusPagesClient} />
    </div>
  );
}
