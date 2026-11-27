import { useQuery } from "@tanstack/react-query";
import { fetchGitForgeOverview, fetchGitForgeRepositories } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The organisation's side of git.infrawrench.com (`GET /git` and `GET
 * /git/repositories`): its namespace, usage against the plan, and its
 * repositories. Two cheap reads of our own tables, fetched together because
 * the screen shows both and a repository list is meaningless without the
 * namespace it lives in.
 */
export function useGitForge() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["git-forge", orgId],
    queryFn: async () => {
      const [overview, repositories] = await Promise.all([
        fetchGitForgeOverview(api, orgId),
        fetchGitForgeRepositories(api, orgId),
      ]);
      return { overview, repositories };
    },
  });
}
