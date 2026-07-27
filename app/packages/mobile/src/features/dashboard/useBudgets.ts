import { useQuery } from "@tanstack/react-query";
import type { BudgetWithStatus } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's budgets, keyed by id, for the budget widgets on a dashboard to
 * resolve their `budgetId` against. Fetched once per dashboard rather than
 * per widget; a budget with no widget on the dashboard being viewed is not
 * rendered, matching web and desktop.
 */
export function useBudgets(enabled = true) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["budgets", orgId],
    enabled,
    queryFn: async () => {
      const rows = (await api.org<BudgetWithStatus[]>(orgId, "/budgets")) ?? [];
      return new Map(rows.map((b) => [b.id, b]));
    },
  });
}
