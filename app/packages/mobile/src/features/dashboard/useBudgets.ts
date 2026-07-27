import { useQuery } from "@tanstack/react-query";
import type { BudgetWithStatus } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's budgets, keyed by id. Budget widgets each reference a row, and the
 * home screen needs the same rows to catch budgets no widget on it covers, so
 * both share one query rather than two shapes under one key.
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
