import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BudgetWidgetConfig, Dashboard } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  DashboardBody,
  invalidateDashboardQueries,
  type DashboardData,
} from "@/features/dashboard/DashboardBody";
import { BudgetCard } from "@/features/dashboard/BudgetCard";
import { useBudgets } from "@/features/dashboard/useBudgets";
import { Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";

/**
 * The home tab is the org's default dashboard, the same as the web app's home
 * route — pinned resources, workflow tiles, cost graphs, and budgets in one
 * ordered list. A budget is a card on the dashboard it belongs to, not a
 * separate list bolted to the top of the screen.
 *
 * Below that: the budgets this dashboard doesn't already show (a budget push
 * opens this screen, so none of them may be unreachable from it), then the
 * org's other dashboards.
 */
export default function OrgHome() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();

  const home = useQuery({
    queryKey: ["dashboard-default", orgId],
    queryFn: () => api.org<DashboardData>(orgId, "/dashboards/default/full"),
  });
  const dashboards = useQuery({
    queryKey: ["dashboards", orgId],
    queryFn: () => api.org<Dashboard[]>(orgId, "/dashboards"),
  });
  // A budget alert's push opens this screen, so a budget whose widget lives on
  // another dashboard (or on none, after its widget was removed) still has to
  // be reachable here.
  const budgets = useBudgets();

  if (home.isLoading) return <LoadingView />;
  if (home.isError) {
    return (
      <ErrorView
        message={home.error instanceof Error ? home.error.message : "Failed to load"}
        onRetry={() => void home.refetch()}
      />
    );
  }

  const others = (dashboards.data ?? []).filter((d) => d.id !== home.data?.dashboard.id);

  const shownBudgetIds = new Set(
    (home.data?.widgets ?? [])
      .filter((w) => w.kind === "budget")
      .map((w) => (w.config as BudgetWidgetConfig).budgetId),
  );
  const elsewhere = [...(budgets.data?.values() ?? [])].filter((b) => !shownBudgetIds.has(b.id));

  return (
    <Screen
      onRefresh={() => {
        void home.refetch();
        void dashboards.refetch();
        invalidateDashboardQueries(queryClient);
      }}
      refreshing={home.isRefetching}
    >
      {home.data && <DashboardBody data={home.data} />}

      {elsewhere.length > 0 && (
        <>
          <SectionTitle>Other budgets</SectionTitle>
          {elsewhere.map((b) => (
            <BudgetCard key={b.id} budget={b} />
          ))}
        </>
      )}

      {others.length > 0 && (
        <>
          <SectionTitle>Other dashboards</SectionTitle>
          <Card list>
            {others.map((d) => (
              <Row
                key={d.id}
                title={d.name}
                onPress={() => router.push(`/org/${orgId}/dashboard/${d.id}`)}
              />
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}
