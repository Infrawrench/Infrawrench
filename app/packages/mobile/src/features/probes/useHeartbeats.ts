import { useQuery } from "@tanstack/react-query";
import { fetchHeartbeats } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's heartbeat monitors (`GET /heartbeats`): each scheduled job's
 * status, schedule and last ping. Read-only beside `useProbes`, for the same
 * reason: heartbeats are created on web or desktop, where the editor reads
 * schedules from synced resources.
 */
export function useHeartbeats() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["heartbeats", orgId],
    queryFn: () => fetchHeartbeats(api, orgId),
  });
}
