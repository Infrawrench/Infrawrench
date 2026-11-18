import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GAME_DAY_ACTIVE_STATUSES,
  type GameDay,
  type GameDayDetail,
  type GameDayList,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** How often a game day in flight is re-read, matching web and desktop. */
const LIVE_REFRESH_MS = 5_000;

const isActive = (g: GameDay) => GAME_DAY_ACTIVE_STATUSES.includes(g.status);

/** The org's game days (`GET /game-days`), polled while any is in flight. */
export function useGameDays() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["game-days", orgId],
    queryFn: async () => (await api.org<GameDayList>(orgId, "/game-days")) ?? { gameDays: [] },
    refetchInterval: (query) =>
      (query.state.data?.gameDays ?? []).some(isActive) ? LIVE_REFRESH_MS : false,
  });
}

/** One game day with its alerts and report (`GET /game-days/:id`). */
export function useGameDayDetail(gameDayId: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["game-days", orgId, gameDayId],
    queryFn: () => api.org<GameDayDetail>(orgId, `/game-days/${encodeURIComponent(gameDayId)}`),
    enabled: !!gameDayId,
    refetchInterval: (query) => {
      const g = query.state.data?.gameDay;
      return g && isActive(g) ? LIVE_REFRESH_MS : false;
    },
  });
}

/**
 * Abort (`POST /game-days/:id/abort`): undo the failure now, or cancel an
 * armed game day that has not started. Every member may, so the phone may.
 */
export function useAbortGameDay(gameDayId: string) {
  const { api, orgId } = useOrgApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.org<GameDay>(orgId, `/game-days/${encodeURIComponent(gameDayId)}/abort`, {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["game-days", orgId] });
    },
  });
}
