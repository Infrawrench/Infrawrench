import { useMemo } from "react";
import { GameDaysPanel } from "@infrawrench/ui/game-days";
import { usePermissions } from "@/auth/permissions-context";
import { createWebGameDaysClient } from "@/lib/game-days-client";

/**
 * Web host for the shared game days screen, rendered as the "game-days"
 * workspace tab. Which game day is open lives in the URL
 * (`/org/:orgId/game-days/:id`), the SLOs stance.
 */
export function WebGameDaysPanel({
  orgId,
  gameDayId,
  onSelectGameDay,
}: {
  orgId: string;
  gameDayId?: string | undefined;
  onSelectGameDay: (gameDayId: string | null) => void;
}) {
  const { has } = usePermissions();
  const canRun = has("game-days:run");
  const client = useMemo(() => createWebGameDaysClient(orgId, canRun), [orgId, canRun]);
  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <GameDaysPanel
        key={orgId}
        client={client}
        gameDayId={gameDayId}
        onGameDayChange={onSelectGameDay}
      />
    </div>
  );
}
