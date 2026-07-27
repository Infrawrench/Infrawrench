import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dashboard } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  DashboardBody,
  invalidateDashboardQueries,
  type DashboardData,
} from "@/features/dashboard/DashboardBody";
import { Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";

/**
 * The home tab is the org's default dashboard, the same as the web app's home
 * route — pinned resources, workflow tiles, cost graphs, and budgets in one
 * ordered list, then a link to the org's other dashboards.
 *
 * A budget appears here only as a card on this dashboard, exactly as on web and
 * desktop: the widget is what puts it on a dashboard, so removing the widget
 * takes it off. This screen used to append an "Other budgets" list of every org
 * budget no widget here covered, which meant a budget you had just removed came
 * straight back under a different heading.
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
