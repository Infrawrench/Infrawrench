import { useUIStore } from "@infrawrench/ui";
import type { GameDaysClient } from "@infrawrench/ui/game-days";
import { createDesktopBlastRadiusClient } from "./blast-radius-client";
import {
  abortCloudGameDay,
  armCloudGameDay,
  createCloudGameDay,
  deleteCloudGameDay,
  disarmCloudGameDay,
  endCloudGameDay,
  getCloudGameDay,
  getCloudGameDayCandidates,
  listCloudGameDays,
  planCloudGameDay,
  retryCloudGameDayUndo,
  updateCloudGameDay,
} from "./cloud-game-days";

/**
 * Game days are cloud-only: the poller injects, watches and undoes them. The
 * active org is resolved at call time rather than closed over, matching
 * `slos-client.ts`: the org can change under a mounted panel. Every method is
 * offered; the server enforces `game-days:run` and the panel shows its error.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Game days require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopGameDaysClient(): GameDaysClient {
  return {
    listGameDays: async () => (await listCloudGameDays(requireOrgId())).gameDays,
    getGameDay: (id) => getCloudGameDay(requireOrgId(), id),
    listCandidates: () => getCloudGameDayCandidates(requireOrgId()),
    abortGameDay: (id) => abortCloudGameDay(requireOrgId(), id),
    planGameDay: (input) => planCloudGameDay(requireOrgId(), input),
    createGameDay: (input) => createCloudGameDay(requireOrgId(), input),
    updateGameDay: (id, input) => updateCloudGameDay(requireOrgId(), id, input),
    deleteGameDay: (id) => deleteCloudGameDay(requireOrgId(), id),
    armGameDay: (id, confirmName) => armCloudGameDay(requireOrgId(), id, confirmName),
    disarmGameDay: (id) => disarmCloudGameDay(requireOrgId(), id),
    endGameDay: (id) => endCloudGameDay(requireOrgId(), id),
    retryUndo: (id) => retryCloudGameDayUndo(requireOrgId(), id),
    blastRadius: createDesktopBlastRadiusClient(),
  };
}
