import { useMemo } from "react";
import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "@infrawrench/ui";
import { OffboardingPanel } from "@infrawrench/ui/offboarding/OffboardingPanel";
import { createDesktopOffboardingClient } from "@/lib/offboarding-client";
import {
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  offboardingTabTarget,
  resourceTabTarget,
} from "@/lib/workspace-tabs";

/**
 * Desktop host for the shared offboarding tab. Cloud mode only: the checklist,
 * the seats, the ownership records and the org's members it lines up all live
 * in the cloud, and a local workspace has none of them.
 */
export function DesktopOffboardingPanel({ offboardingId }: { offboardingId?: string | undefined }) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopOffboardingClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("Offboarding requires cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <OffboardingPanel
      // Keyed by org so switching org remounts and refetches.
      key={activeCloudOrgId}
      client={client}
      offboardingId={offboardingId}
      onSelect={(next) =>
        void navigateToWorkspaceTarget(navigate, offboardingTabTarget(next), {
          label: gt("Offboarding"),
        })
      }
      onOpenResource={(item) => {
        if (!item.accountId || !item.resourceId) return;
        void navigate(
          getWorkspaceNavigateArgs(
            resourceTabTarget(
              item.accountId,
              item.resourceId,
              item.pluginId ?? undefined,
              item.resourceTypeId ?? undefined,
            ),
          ),
        );
      }}
    />
  );
}
