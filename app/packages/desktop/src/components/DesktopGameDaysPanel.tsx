import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import { GameDaysPanel } from "@infrawrench/ui/game-days";
import { createDesktopGameDaysClient } from "@/lib/game-days-client";
import { gameDaysTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * Game days on desktop: the same screen web renders, as the "game-days"
 * workspace tab. Cloud-only: the cloud poller injects and undoes the failure,
 * so without an org the tab explains rather than fetching.
 */
export function DesktopGameDaysPanel({ gameDayId }: { gameDayId?: string | undefined }) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopGameDaysClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("Game days require cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <GameDaysPanel
        key={activeCloudOrgId}
        client={client}
        gameDayId={gameDayId}
        onGameDayChange={(next) =>
          void navigateToWorkspaceTarget(navigate, gameDaysTabTarget(next ?? undefined), {
            label: gt("Game days"),
          })
        }
      />
    </div>
  );
}
