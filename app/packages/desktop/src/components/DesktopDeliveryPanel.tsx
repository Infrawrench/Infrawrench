import { useMemo } from "react";
import { useGT } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import { DeliveryPanel } from "@infrawrench/ui/dora";
import { createDesktopDoraClient } from "@/lib/dora-client";
import { invoke } from "@/lib/invoke";

/**
 * Delivery (DORA metrics) on desktop: the same screen web renders, as the
 * "delivery" workspace tab. Cloud-only, so without an org the tab explains
 * rather than fetching.
 */
export function DesktopDeliveryPanel() {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopDoraClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("Delivery metrics require cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <DeliveryPanel
        key={activeCloudOrgId}
        client={client}
        onOpenUrl={(url) => void invoke("open_external_url", { url })}
      />
    </div>
  );
}
