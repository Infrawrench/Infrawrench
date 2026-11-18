import type { GameDaysClient } from "@infrawrench/ui/game-days";
import type {
  GameDay,
  GameDayCandidates,
  GameDayDetail,
  GameDayInput,
  GameDayList,
  GameDayPlan,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { createWebBlastRadiusClient } from "./blast-radius-client";

/**
 * Web implementation of the shared game days client, per org. `canRun` gates
 * the `game-days:run` half (the panel renders read-only without it); abort is
 * offered to every reader, matching the server. The server enforces both.
 */
export function createWebGameDaysClient(orgId: string, canRun: boolean): GameDaysClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/game-days`;
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    listGameDays: async () => (await apiGet<GameDayList>(base)).gameDays,
    getGameDay: (id) => apiGet<GameDayDetail>(one(id)),
    listCandidates: () => apiGet<GameDayCandidates>(`${base}/candidates`),
    abortGameDay: (id) => apiPost<GameDay>(`${one(id)}/abort`),
    blastRadius: createWebBlastRadiusClient(orgId),
    ...(canRun
      ? {
          planGameDay: (input: GameDayInput) => apiPost<GameDayPlan>(`${base}/plan`, input),
          createGameDay: (input: GameDayInput) => apiPost<GameDay>(base, input),
          updateGameDay: (id: string, input: GameDayInput) => apiPut<GameDay>(one(id), input),
          deleteGameDay: async (id: string) => {
            await apiDelete(one(id));
          },
          armGameDay: (id: string, confirmName: string) =>
            apiPost<GameDay>(`${one(id)}/arm`, { confirmName }),
          disarmGameDay: (id: string) => apiPost<GameDay>(`${one(id)}/disarm`),
          endGameDay: (id: string) => apiPost<GameDay>(`${one(id)}/end`),
          retryUndo: (id: string) => apiPost<GameDay>(`${one(id)}/retry-undo`),
        }
      : {}),
  };
}
