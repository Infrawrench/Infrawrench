import { useMemo } from "react";
import { StatusPagesPanel, useUIStore } from "@infrawrench/ui";
import { ProbesPanel } from "@infrawrench/ui/probes";
import { createDesktopProbesClient } from "@/lib/probes-client";
import { createDesktopStatusPagesClient } from "@/lib/status-pages-client";

/**
 * Synthetic probes on desktop, and the status pages that publish them — the
 * same screens web renders. Rendered as a workspace tab (the "probes" kind).
 * Cloud-only: checks run in the cloud poller through the egress proxy and the
 * public page is served by the cloud app, so without an org the tab explains
 * rather than fetching.
 */
export function DesktopProbesPanel() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopProbesClient(), []);
  const statusPagesClient = useMemo(() => createDesktopStatusPagesClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Synthetic probes require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ProbesPanel key={activeCloudOrgId} client={client} />
      <StatusPagesPanel key={`status-${activeCloudOrgId}`} client={statusPagesClient} />
    </div>
  );
}
