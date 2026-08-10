import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSchedules, updateSchedule } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's sleep/wake schedules (`GET /schedules`). Server-side and cheap:
 * the list is rows plus a savings annotation over already-collected billing
 * data — no provider API calls.
 */
export function useSchedules() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["schedules", orgId],
    queryFn: () => fetchSchedules(api, orgId),
  });
}

/** Pause/resume one schedule — the one mutation the phone offers. */
export function useSchedulePause() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, paused }: { scheduleId: string; paused: boolean }) =>
      updateSchedule(api, orgId, scheduleId, { paused }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["schedules", orgId] }),
  });
}
