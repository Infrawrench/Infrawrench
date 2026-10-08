import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import { SlosPanel } from "@infrawrench/ui/slos";
import { createDesktopSlosClient } from "@/lib/slos-client";
import { navigateToWorkspaceTarget, slosTabTarget } from "@/lib/workspace-tabs";

/**
 * SLOs on desktop: the same screen web renders, as the "slos" workspace tab.
 * Cloud-only: an SLO is evaluated by the cloud poller over the cloud metric
 * store, so without an org the tab explains rather than fetching.
 */
export function DesktopSlosPanel({ sloId }: { sloId?: string | undefined }) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopSlosClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("SLOs require cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <SlosPanel
        key={activeCloudOrgId}
        client={client}
        sloId={sloId}
        onSloChange={(next) =>
          void navigateToWorkspaceTarget(navigate, slosTabTarget(next ?? undefined), {
            label: gt("SLOs"),
          })
        }
      />
    </div>
  );
}
