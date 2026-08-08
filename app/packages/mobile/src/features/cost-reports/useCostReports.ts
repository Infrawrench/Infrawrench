import { useQuery } from "@tanstack/react-query";
import type { CostReport } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's saved cost reports.
 *
 * One list fetch serves both the list screen and the detail screen (which
 * selects out of it) and, on a dashboard, resolves every `cost_report` card's
 * `reportId` — the same "fetch the list, not one per card" rule the budget
 * widgets follow.
 */
export function useCostReports(enabled = true) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-reports", orgId],
    enabled,
    queryFn: async () => (await api.org<CostReport[]>(orgId, "/cost-reports")) ?? [],
  });
}

/** The same list, keyed by id — what a dashboard's report cards look up. */
export function useCostReportsById(enabled = true) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-reports-by-id", orgId],
    enabled,
    queryFn: async () => {
      const rows = (await api.org<CostReport[]>(orgId, "/cost-reports")) ?? [];
      return new Map(rows.map((r) => [r.id, r]));
    },
  });
}
