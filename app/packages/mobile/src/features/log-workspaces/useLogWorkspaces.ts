import { useQuery } from "@tanstack/react-query";
import { fetchLogWorkspaceQueries } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** The org's saved log-workspace queries — read-only on mobile. */
export function useLogWorkspaces() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["log-workspaces", orgId],
    queryFn: () => fetchLogWorkspaceQueries(api, orgId),
  });
}
