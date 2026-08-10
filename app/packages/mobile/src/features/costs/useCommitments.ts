import { useQuery } from "@tanstack/react-query";
import { fetchCommitments } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** The org's commitments feed (`GET /commitments`, permission `costs:read`). */
export function useCommitments() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["commitments", orgId],
    queryFn: () => fetchCommitments(api, orgId),
  });
}
