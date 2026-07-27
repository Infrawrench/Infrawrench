import { useEffect } from "react";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  DashboardBody,
  invalidateDashboardQueries,
  type DashboardData,
} from "@/features/dashboard/DashboardBody";
import { EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";

/**
 * One dashboard's cards. The name goes in the header rather than the body —
 * the back button next to it is what makes this read as a place you drilled
 * into from the Dashboards tab, and a title inside the scroll view would
 * disappear the moment you scrolled.
 */
export default function DashboardScreen() {
  const { dashboardId } = useLocalSearchParams<{ dashboardId: string }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const navigation = useNavigation();

  const detail = useQuery({
    queryKey: ["dashboard", orgId, dashboardId],
    queryFn: () => api.org<DashboardData>(orgId, `/dashboards/${encodeURIComponent(dashboardId)}`),
  });

  const name = detail.data?.dashboard.name;
  useEffect(() => {
    // Set once the fetch lands: the title is data, so the layout can only
    // supply the placeholder.
    navigation.setOptions({ title: name ?? "Dashboard" });
  }, [navigation, name]);

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Failed to load"}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  if (!detail.data) return <EmptyView message="Dashboard not found." />;

  return (
    <Screen
      onRefresh={() => {
        void detail.refetch();
        invalidateDashboardQueries(queryClient);
      }}
      refreshing={detail.isRefetching}
    >
      <DashboardBody data={detail.data} />
    </Screen>
  );
}
