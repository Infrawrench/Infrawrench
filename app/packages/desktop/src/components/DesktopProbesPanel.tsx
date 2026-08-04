import { useMemo } from "react";
import { useUIStore } from "@infrawrench/ui";
import { ProbesPanel } from "@infrawrench/ui/probes";
import { createDesktopProbesClient } from "@/lib/probes-client";

/**
 * Synthetic probes on desktop — the same screen web renders. Rendered as a
 * workspace tab (the "probes" kind). Cloud-only: checks run in the cloud
 * poller through the egress proxy, so without an org the tab explains rather
 * than fetching.
 */
export function DesktopProbesPanel() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopProbesClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Synthetic probes require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ProbesPanel key={activeCloudOrgId} client={client} />
    </div>
  );
}
